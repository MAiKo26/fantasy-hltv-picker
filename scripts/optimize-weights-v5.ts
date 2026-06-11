import * as fs from "node:fs";
import * as path from "node:path";
import {HtmlExtractorService} from "../src/services/extractor.ts";
import {StatsScraperService} from "../src/services/statsScraper.ts";
import {mathOptimizer, type OptimizerWeightOverrides} from "../src/services/mathOptimizer.ts";
import {parseEventGroundTruth, type EventGroundTruth, type PlayerFinalRating} from "../src/services/resultParser.ts";
import {normalizePlayerName} from "../src/utils/normalize.ts";
import type {FantasyConfig, FantasyPlayer, FantasyTeam} from "../src/types/player.ts";

const RATINGS_DIR = path.join(process.cwd(), "results", "player-ratings-at-end-of-event");
const RESULTS_DIR = path.join(process.cwd(), "results");
const DRAFT_DIR = path.join(process.cwd(), "source", "draft");
const OUTPUT_FILE = path.join(process.cwd(), "optimization-results-v5.json");
const CACHE_FILE = path.join(process.cwd(), ".cache", "v5-events.json");

const MIN_MAPS_FOR_RATING = 6;
const MAP_WEIGHT_THRESHOLD = 8;
const RATING_TOP_THRESHOLD = 1.18;
const BEST_VALUE_COUNT = 8;

const LOSS_SPEARMAN_WEIGHT = 1.0;
const LOSS_TOP_RATED_COVERAGE_WEIGHT = 0.5;
const LOSS_BEST_VALUE_COVERAGE_WEIGHT = 0.2;
const LOSS_REGULARIZATION_WEIGHT = 0.02;

const MAX_OPTIMIZER_ITERATIONS = 12;
const EARLY_STOP_PATIENCE = 3;
const RESTART_COUNT = 3;
const RESTART_NOISE_SIGMA = 0.05;
const INITIAL_STEP_SIZE = 0.05;
const STEP_ACCELERATION = 1.4;
const STEP_DECAY = 0.5;
const MIN_STEP_SIZE = 0.005;

const TOP_LINEUPS_COUNT = 30;
const TRAIN_FRACTION = 0.75;

const BASELINE_WEIGHTS: WeightConfig = {
  cardRatingBenefit: 0.25,
  historicalTop20RatingBenefit: 3,
  topTeamRankBenefit: 1.5,
  awperRoleBenefit: 0,
  lowDeathRateBenefit: 0,
  ctVsTRatingImbalancePenalty: 0.5,
  stackCorrelationBenefit: 0.5,
  topRankedTeamStackBenefit: 0.25,
  awpPerRoundWeight: 0,
  deathPenaltyWeight: 0,
  priceEfficiencyBenefit: 0,
};

const WEIGHT_KEYS = Object.keys(BASELINE_WEIGHTS) as (keyof WeightConfig)[];

interface WeightConfig {
  cardRatingBenefit: number;
  historicalTop20RatingBenefit: number;
  topTeamRankBenefit: number;
  awperRoleBenefit: number;
  lowDeathRateBenefit: number;
  ctVsTRatingImbalancePenalty: number;
  stackCorrelationBenefit: number;
  topRankedTeamStackBenefit: number;
  awpPerRoundWeight: number;
  deathPenaltyWeight: number;
  priceEfficiencyBenefit: number;
}

interface EventInput {
  eventSlug: string;
  players: FantasyPlayer[];
  teams: FantasyTeam[];
}

interface EventData {
  input: EventInput;
  truth: EventGroundTruth;
}

interface PlayerEval {
  name: string;
  team: string;
  predicted: number;
  actual: number | null;
  maps: number;
  mapWeight: number;
}

interface EventEval {
  eventSlug: string;
  players: PlayerEval[];
  topRatedSet: string[];
  bestValueSet: string[];
  lineups: {playerNames: string[]}[];
  spearman: number;
  topRatedCoverage: number;
  bestValueCoverage: number;
  meanActualInTopLineups: number;
  meanPredictedInTopLineups: number;
  hasRatings: boolean;
  hasBestValue: boolean;
}

interface LossBreakdown {
  total: number;
  spearman: number;
  topRatedCoverage: number;
  bestValueCoverage: number;
  regularization: number;
  perEvent: Array<{eventSlug: string; loss: number; spearman: number; topRated: number; bestValue: number}>;
}

interface RunResult {
  weights: WeightConfig;
  trainLoss: LossBreakdown;
  testLoss: LossBreakdown;
  iterations: number;
  converged: boolean;
  seed: number;
}

interface LooResult {
  perEvent: Array<{
    eventSlug: string;
    weights: WeightConfig;
    testLoss: LossBreakdown;
  }>;
  meanWeights: WeightConfig;
  stdWeights: WeightConfig;
  meanTestLoss: number;
}

function clampWeight(w: number): number {
  return Math.max(0, Math.min(2, w));
}

function cloneWeights(w: WeightConfig): WeightConfig {
  return {...w};
}

function gaussianRandom(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function perturbWeights(baseline: WeightConfig, sigma: number): WeightConfig {
  const out = cloneWeights(baseline);
  for (const k of WEIGHT_KEYS) {
    out[k] = clampWeight(baseline[k] + gaussianRandom() * sigma);
  }
  return out;
}

function weightToOptimizerOverrides(w: WeightConfig): OptimizerWeightOverrides {
  return {
    cardRatingBenefit: w.cardRatingBenefit,
    historicalTop20RatingBenefit: w.historicalTop20RatingBenefit,
    topTeamRankBenefit: w.topTeamRankBenefit,
    awperRoleBenefit: w.awperRoleBenefit,
    lowDeathRateBenefit: w.lowDeathRateBenefit,
    ctVsTRatingImbalancePenalty: w.ctVsTRatingImbalancePenalty,
    stackCorrelationBenefit: w.stackCorrelationBenefit,
    topRankedTeamStackBenefit: w.topRankedTeamStackBenefit,
    awpPerRoundWeight: w.awpPerRoundWeight,
    deathPenaltyWeight: w.deathPenaltyWeight,
    priceEfficiencyBenefit: w.priceEfficiencyBenefit,
  };
}

function buildRatingMap(ratings: PlayerFinalRating[]): Map<string, PlayerFinalRating> {
  const map = new Map<string, PlayerFinalRating>();
  for (const r of ratings) {
    map.set(r.name, r);
  }
  return map;
}

function buildTopRatedSet(ratings: PlayerFinalRating[]): string[] {
  return ratings
    .filter(r => r.rating >= RATING_TOP_THRESHOLD && r.maps >= 6)
    .map(r => r.name);
}

function computePerPlayerPredictions(
  event: EventData,
  weights: WeightConfig,
  ratingMap: Map<string, PlayerFinalRating>,
): PlayerEval[] {
  return event.input.players.map(player => {
    const traits = mathOptimizer.getPlayerTraitVector(player).traits;
    let predicted = 0;
    for (const k of WEIGHT_KEYS) {
      predicted += traits[k] * weights[k];
    }
    const rating = ratingMap.get(normalizePlayerName(player.name));
    const maps = rating?.maps ?? 0;
    return {
      name: normalizePlayerName(player.name),
      team: player.team,
      predicted,
      actual: rating && rating.maps >= MIN_MAPS_FOR_RATING ? rating.rating : null,
      maps,
      mapWeight: rating ? Math.min(1, rating.maps / MAP_WEIGHT_THRESHOLD) : 0,
    };
  });
}

function rankWithMidrank(values: number[]): Map<number, number> {
  const indexed = values.map((v, i) => ({v, i}));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Map<number, number>();
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) {
      j++;
    }
    const midrank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      ranks.set(indexed[k]!.i, midrank);
    }
    i = j + 1;
  }
  return ranks;
}

function weightedSpearman(
  predicted: number[],
  actual: number[],
  weights: number[],
): number {
  const n = predicted.length;
  if (n < 3) return 0;

  const allSameP = predicted.every(p => p === predicted[0]);
  const allSameA = actual.every(a => a === actual[0]);
  if (allSameP || allSameA) return 0;

  const xRanks = rankWithMidrank(predicted);
  const yRanks = rankWithMidrank(actual);

  let sumW = 0;
  let sumWx = 0;
  let sumWy = 0;
  let sumWxx = 0;
  let sumWyy = 0;
  let sumWxy = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i]!;
    if (w <= 0) continue;
    const xr = xRanks.get(i)!;
    const yr = yRanks.get(i)!;
    sumW += w;
    sumWx += w * xr;
    sumWy += w * yr;
    sumWxx += w * xr * xr;
    sumWyy += w * yr * yr;
    sumWxy += w * xr * yr;
  }

  const denom = Math.sqrt(sumW * sumWxx - sumWx * sumWx) *
                Math.sqrt(sumW * sumWyy - sumWy * sumWy);
  if (denom === 0) return 0;
  return (sumW * sumWxy - sumWx * sumWy) / denom;
}

function computeSpearman(players: PlayerEval[]): number {
  const eligible = players.filter(p => p.actual !== null);
  if (eligible.length < 3) return 0;
  const predicted = eligible.map(p => p.predicted);
  const actual = eligible.map(p => p.actual!);
  const weights = eligible.map(p => p.mapWeight);
  return weightedSpearman(predicted, actual, weights);
}

function computeCoverageFromNames(
  lineups: {playerNames: string[]}[],
  targetSet: string[],
): number {
  if (targetSet.length === 0) return 1;
  const set = new Set(targetSet);
  let totalHits = 0;
  const consider = lineups.slice(0, TOP_LINEUPS_COUNT);
  for (const lineup of consider) {
    for (const name of lineup.playerNames) {
      if (set.has(name)) totalHits++;
    }
  }
  const maxPossible = targetSet.length * Math.min(TOP_LINEUPS_COUNT, consider.length);
  return maxPossible === 0 ? 0 : totalHits / maxPossible;
}

function aggregateLoss(
  perEvent: EventEval[],
  weights: WeightConfig,
  baseline: WeightConfig,
): LossBreakdown {
  let sumSpearman = 0;
  let sumTopRated = 0;
  let sumBestValue = 0;
  let nSpearman = 0;
  let nTopRated = 0;
  let nBestValue = 0;
  const perEventContribs: LossBreakdown["perEvent"] = [];

  for (const e of perEvent) {
    let contrib = 0;
    let evSpearman = 0;
    let evTopRated = 0;
    let evBestValue = 0;

    if (e.hasRatings) {
      const spLoss = -e.spearman;
      const trLoss = 1 - e.topRatedCoverage;
      sumSpearman += spLoss;
      sumTopRated += trLoss;
      nSpearman++;
      nTopRated++;
      evSpearman = spLoss;
      evTopRated = trLoss;
      contrib += LOSS_SPEARMAN_WEIGHT * spLoss;
      contrib += LOSS_TOP_RATED_COVERAGE_WEIGHT * trLoss;
    }

    if (e.hasBestValue) {
      const bvLoss = 1 - e.bestValueCoverage;
      sumBestValue += bvLoss;
      nBestValue++;
      evBestValue = bvLoss;
      contrib += LOSS_BEST_VALUE_COVERAGE_WEIGHT * bvLoss;
    }

    perEventContribs.push({
      eventSlug: e.eventSlug,
      loss: contrib,
      spearman: evSpearman,
      topRated: evTopRated,
      bestValue: evBestValue,
    });
  }

  const meanSpearman = nSpearman > 0 ? sumSpearman / nSpearman : 0;
  const meanTopRated = nTopRated > 0 ? sumTopRated / nTopRated : 0;
  const meanBestValue = nBestValue > 0 ? sumBestValue / nBestValue : 0;

  let regLoss = 0;
  for (const k of WEIGHT_KEYS) {
    regLoss += (weights[k] - baseline[k]) ** 2;
  }

  const total = LOSS_SPEARMAN_WEIGHT * meanSpearman
              + LOSS_TOP_RATED_COVERAGE_WEIGHT * meanTopRated
              + LOSS_BEST_VALUE_COVERAGE_WEIGHT * meanBestValue
              + LOSS_REGULARIZATION_WEIGHT * regLoss;

  return {
    total,
    spearman: meanSpearman,
    topRatedCoverage: meanTopRated,
    bestValueCoverage: meanBestValue,
    regularization: regLoss,
    perEvent: perEventContribs,
  };
}

function lineupsToNames(lineups: {players: FantasyPlayer[]}[]): {playerNames: string[]}[] {
  return lineups.map(l => ({
    playerNames: l.players.map(p => normalizePlayerName(p.name)),
  }));
}

async function evaluateFull(
  weights: WeightConfig,
  events: EventData[],
  config: FantasyConfig = {strategy: "2-2-1"},
): Promise<{perEvent: EventEval[]; breakdown: LossBreakdown}> {
  const overrides = weightToOptimizerOverrides(weights);
  const perEvent: EventEval[] = [];

  for (const event of events) {
    const lineups = mathOptimizer.optimize(
      event.input.players,
      event.input.teams,
      config,
      overrides,
    );
    const ratingMap = buildRatingMap(event.truth.ratings);
    const topRatedSet = buildTopRatedSet(event.truth.ratings);
    const bestValueSet = event.truth.bestValuePlayers;

    const players = computePerPlayerPredictions(event, weights, ratingMap);
    const spearman = computeSpearman(players);
    const topRatedCoverage = computeCoverageFromNames(lineupsToNames(lineups), topRatedSet);
    const bestValueCoverage = computeCoverageFromNames(lineupsToNames(lineups), bestValueSet);

    let meanActual = 0;
    let meanPredicted = 0;
    let count = 0;
    const lineupPlayerSet = new Set<string>();
    for (const l of lineups.slice(0, TOP_LINEUPS_COUNT)) {
      for (const p of l.players) lineupPlayerSet.add(normalizePlayerName(p.name));
    }
    for (const p of players) {
      if (lineupPlayerSet.has(p.name) && p.actual !== null) {
        meanActual += p.actual;
        meanPredicted += p.predicted;
        count++;
      }
    }
    if (count > 0) {
      meanActual /= count;
      meanPredicted /= count;
    }

    perEvent.push({
      eventSlug: event.truth.eventSlug,
      players,
      topRatedSet,
      bestValueSet,
      lineups: lineupsToNames(lineups),
      spearman,
      topRatedCoverage,
      bestValueCoverage,
      meanActualInTopLineups: meanActual,
      meanPredictedInTopLineups: meanPredicted,
      hasRatings: event.truth.hasRatings,
      hasBestValue: event.truth.hasBestValue,
    });
  }

  const breakdown = aggregateLoss(perEvent, weights, BASELINE_WEIGHTS);
  return {perEvent, breakdown};
}

function evaluateAnalytical(
  weights: WeightConfig,
  events: EventData[],
  cachedLineups: Map<string, {playerNames: string[]}[]>,
): {perEvent: EventEval[]; breakdown: LossBreakdown} {
  const perEvent: EventEval[] = [];

  for (const event of events) {
    const lineups = cachedLineups.get(event.truth.eventSlug) ?? [];
    const ratingMap = buildRatingMap(event.truth.ratings);
    const topRatedSet = buildTopRatedSet(event.truth.ratings);
    const bestValueSet = event.truth.bestValuePlayers;

    const players = computePerPlayerPredictions(event, weights, ratingMap);
    const spearman = computeSpearman(players);
    const topRatedCoverage = computeCoverageFromNames(lineups, topRatedSet);
    const bestValueCoverage = computeCoverageFromNames(lineups, bestValueSet);

    let meanActual = 0;
    let meanPredicted = 0;
    let count = 0;
    const lineupPlayerSet = new Set<string>();
    for (const l of lineups.slice(0, TOP_LINEUPS_COUNT)) {
      for (const name of l.playerNames) lineupPlayerSet.add(name);
    }
    for (const p of players) {
      if (lineupPlayerSet.has(p.name) && p.actual !== null) {
        meanActual += p.actual;
        meanPredicted += p.predicted;
        count++;
      }
    }
    if (count > 0) {
      meanActual /= count;
      meanPredicted /= count;
    }

    perEvent.push({
      eventSlug: event.truth.eventSlug,
      players,
      topRatedSet,
      bestValueSet,
      lineups,
      spearman,
      topRatedCoverage,
      bestValueCoverage,
      meanActualInTopLineups: meanActual,
      meanPredictedInTopLineups: meanPredicted,
      hasRatings: event.truth.hasRatings,
      hasBestValue: event.truth.hasBestValue,
    });
  }

  const breakdown = aggregateLoss(perEvent, weights, BASELINE_WEIGHTS);
  return {perEvent, breakdown};
}

async function coordinateDescent(
  trainSet: EventData[],
  testSet: EventData[],
  initWeights: WeightConfig,
  fastMode: boolean,
  cachedLineups?: Map<string, {playerNames: string[]}[]>,
): Promise<{weights: WeightConfig; trainLoss: LossBreakdown; testLoss: LossBreakdown; iterations: number; converged: boolean}> {
  const evalTrain = async (w: WeightConfig): Promise<LossBreakdown> => {
    if (fastMode) {
      return (await evaluateAnalytical(w, trainSet, cachedLineups!)).breakdown;
    }
    return (await evaluateFull(w, trainSet)).breakdown;
  };
  const evalTest = async (w: WeightConfig): Promise<LossBreakdown> => {
    if (fastMode) {
      return (await evaluateAnalytical(w, testSet, cachedLineups!)).breakdown;
    }
    return (await evaluateFull(w, testSet)).breakdown;
  };

  let weights = cloneWeights(initWeights);
  let bestTrain = await evalTrain(weights);
  let bestTest = await evalTest(weights);
  let bestWeights = cloneWeights(weights);

  const stepSizes: Record<string, number> = Object.fromEntries(
    WEIGHT_KEYS.map(k => [k, INITIAL_STEP_SIZE]),
  );
  let noImprovementCount = 0;
  let iter = 0;
  let converged = false;

  for (iter = 1; iter <= MAX_OPTIMIZER_ITERATIONS; iter++) {
    let anyWeightMoved = false;
    for (const k of WEIGHT_KEYS) {
      const ss = stepSizes[k]!;
      if (ss < MIN_STEP_SIZE) continue;

      const wUp: WeightConfig = {...weights, [k]: clampWeight(weights[k] + ss)};
      const wDown: WeightConfig = {...weights, [k]: clampWeight(weights[k] - ss)};

      const lUp = await evalTrain(wUp);
      const lDown = await evalTrain(wDown);

      const bestCurrent = bestTrain.total;
      if (lUp.total < bestCurrent && lUp.total <= lDown.total) {
        weights = wUp;
        bestTrain = lUp;
        stepSizes[k] = Math.min(ss * STEP_ACCELERATION, 0.5);
        anyWeightMoved = true;
      } else if (lDown.total < bestCurrent) {
        weights = wDown;
        bestTrain = lDown;
        stepSizes[k] = Math.min(ss * STEP_ACCELERATION, 0.5);
        anyWeightMoved = true;
      } else {
        stepSizes[k] = Math.max(ss * STEP_DECAY, MIN_STEP_SIZE / 2);
      }
    }

    const testLossNow = await evalTest(weights);
    if (testLossNow.total < bestTest.total) {
      bestTest = testLossNow;
      bestWeights = cloneWeights(weights);
      noImprovementCount = 0;
    } else {
      noImprovementCount++;
    }

    const tag = fastMode ? "FAST" : "FULL";
    console.log(
      `  [${tag}] iter ${iter}: train=${bestTrain.total.toFixed(4)} ` +
      `test=${bestTest.total.toFixed(4)} patience=${noImprovementCount}`,
    );

    if (noImprovementCount >= EARLY_STOP_PATIENCE) {
      converged = false;
      break;
    }
    if (!anyWeightMoved) {
      converged = true;
      break;
    }
  }

  return {
    weights: bestWeights,
    trainLoss: bestTrain,
    testLoss: bestTest,
    iterations: iter,
    converged,
  };
}

async function runFullOptimization(
  trainSet: EventData[],
  testSet: EventData[],
): Promise<{allRuns: RunResult[]; bestRun: RunResult}> {
  const allRuns: RunResult[] = [];

  for (let restart = 0; restart < RESTART_COUNT; restart++) {
    const seed = Math.floor(Math.random() * 1_000_000);
    const initWeights = restart === 0
      ? cloneWeights(BASELINE_WEIGHTS)
      : perturbWeights(BASELINE_WEIGHTS, RESTART_NOISE_SIGMA);

    console.log(`\n🔄 Restart ${restart + 1}/${RESTART_COUNT} (seed=${seed})`);
    const t0 = Date.now();
    const result = await coordinateDescent(trainSet, testSet, initWeights, false);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    allRuns.push({
      weights: result.weights,
      trainLoss: result.trainLoss,
      testLoss: result.testLoss,
      iterations: result.iterations,
      converged: result.converged,
      seed,
    });

    console.log(
      `  ✓ restart ${restart + 1}: train=${result.trainLoss.total.toFixed(4)} ` +
      `test=${result.testLoss.total.toFixed(4)} iter=${result.iterations} ` +
      `time=${elapsed}s converged=${result.converged}`,
    );
  }

  const bestRun = allRuns.reduce((a, b) => (a.testLoss.total < b.testLoss.total ? a : b));
  return {allRuns, bestRun};
}

async function runLeaveOneOut(
  events: EventData[],
  baselineWeights: WeightConfig,
): Promise<LooResult> {
  console.log(`\n📊 Leave-one-out (${events.length} folds, fast analytical mode)...`);

  const cachedLineups = new Map<string, {playerNames: string[]}[]>();
  const overrides = weightToOptimizerOverrides(baselineWeights);
  for (const event of events) {
    const lineups = mathOptimizer.optimize(
      event.input.players,
      event.input.teams,
      {strategy: "2-2-1"},
      overrides,
    );
    cachedLineups.set(
      event.truth.eventSlug,
      lineups.map(l => ({playerNames: l.players.map(p => normalizePlayerName(p.name))})),
    );
  }

  const perEvent: LooResult["perEvent"] = [];
  for (let holdOut = 0; holdOut < events.length; holdOut++) {
    const trainSet = events.filter((_, i) => i !== holdOut);
    const testSet = [events[holdOut]!];
    const initWeights = cloneWeights(baselineWeights);

    const result = await coordinateDescent(trainSet, testSet, initWeights, true, cachedLineups);
    perEvent.push({
      eventSlug: events[holdOut]!.truth.eventSlug,
      weights: result.weights,
      testLoss: result.testLoss,
    });
    console.log(
      `  LOO ${holdOut + 1}/${events.length}: ${events[holdOut]!.truth.eventSlug} ` +
      `test_loss=${result.testLoss.total.toFixed(4)}`,
    );
  }

  const meanWeights = cloneWeights(BASELINE_WEIGHTS);
  const stdWeights = cloneWeights(BASELINE_WEIGHTS);
  for (const k of WEIGHT_KEYS) {
    const vals = perEvent.map(p => p.weights[k]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / vals.length;
    meanWeights[k] = mean;
    stdWeights[k] = Math.sqrt(variance);
  }
  const meanTestLoss = perEvent.reduce((a, p) => a + p.testLoss.total, 0) / perEvent.length;

  return {perEvent, meanWeights, stdWeights, meanTestLoss};
}

function printAttribution(
  events: EventData[],
  weights: WeightConfig,
): void {
  console.log("\n📊 Per-trait attribution (sign indicates weight direction):");
  console.log("   Positive = optimizer underweighted this trait; negative = overweighted.");

  const attributions: Record<string, number> = Object.fromEntries(
    WEIGHT_KEYS.map(k => [k, 0]),
  );

  let nPlayers = 0;
  for (const event of events) {
    const ratingMap = buildRatingMap(event.truth.ratings);
    for (const player of event.input.players) {
      const rating = ratingMap.get(normalizePlayerName(player.name));
      if (!rating || rating.maps < MIN_MAPS_FOR_RATING) continue;
      const traits = mathOptimizer.getPlayerTraitVector(player).traits;
      let predicted = 0;
      for (const k of WEIGHT_KEYS) {
        predicted += traits[k] * weights[k];
      }
      const residual = rating.rating - predicted;
      nPlayers++;
      for (const k of WEIGHT_KEYS) {
        attributions[k]! += residual * traits[k];
      }
    }
  }

  const sorted = Object.entries(attributions).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  for (const [k, v] of sorted) {
    const direction = v > 0.01 ? "↑ underweight" : v < -0.01 ? "↓ overweight" : "· neutral";
    console.log(`   ${k.padEnd(34)} ${v.toFixed(2).padStart(9)}  ${direction}`);
  }
  console.log(`   (computed over ${nPlayers} players with maps >= ${MIN_MAPS_FOR_RATING})`);
}

function printWeightComparison(
  baseline: WeightConfig,
  final: WeightConfig,
  loo: LooResult,
): void {
  const header = ["Weight", "Baseline", "Final", "Delta", "LOO Mean", "LOO Std", "Stable?"];
  const rows: string[][] = [header];
  for (const k of WEIGHT_KEYS) {
    const base = baseline[k];
    const opt = final[k];
    const delta = opt - base;
    const looMean = loo.meanWeights[k];
    const looStd = loo.stdWeights[k];
    const stable = looStd / Math.max(0.01, Math.abs(looMean)) < 0.5 ? "✓" : "✗";
    rows.push([
      k,
      base.toFixed(3),
      opt.toFixed(3),
      (delta >= 0 ? "+" : "") + delta.toFixed(3),
      looMean.toFixed(3),
      looStd.toFixed(3),
      stable,
    ]);
  }

  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(r => r[i]!.length)));
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const sep = widths.map(w => "─".repeat(w)).join("  ");

  console.log("\n⚖️  WEIGHT COMPARISON");
  console.log(sep);
  for (const row of rows) {
    console.log(fmt(row));
  }
  console.log(sep);
}

function printPerEventAnalysis(
  baselineEval: EventEval[],
  optimizedEval: EventEval[],
): void {
  console.log("\n📋 Per-event analysis (baseline → optimized):");
  const header = ["Event", "Spearman", "TopRated Cov", "BestVal Cov", "Δ Total"];
  console.log(header.map(h => h.padEnd(20)).join(""));
  console.log("─".repeat(100));
  for (let i = 0; i < baselineEval.length; i++) {
    const b = baselineEval[i]!;
    const o = optimizedEval[i]!;
    if (!b || !o) continue;
    const spStr = b.hasRatings ? `${b.spearman.toFixed(3)}→${o.spearman.toFixed(3)}` : "n/a";
    const trStr = b.hasRatings ? `${(b.topRatedCoverage * 100).toFixed(0)}%→${(o.topRatedCoverage * 100).toFixed(0)}%` : "n/a";
    const bvStr = b.hasBestValue ? `${(b.bestValueCoverage * 100).toFixed(0)}%→${(o.bestValueCoverage * 100).toFixed(0)}%` : "n/a";
    const delta = (o.spearman - b.spearman).toFixed(3);
    console.log(
      b.eventSlug.padEnd(48).slice(0, 48) +
      "  " + spStr.padEnd(20) +
      "  " + trStr.padEnd(20) +
      "  " + bvStr.padEnd(20) +
      "  " + delta.padEnd(8),
    );
  }
}

function printQualityFlags(
  baselineTrain: LossBreakdown,
  finalTrain: LossBreakdown,
  looMeanLoss: number,
  loo: LooResult,
): void {
  console.log("\n🚦 Quality flags:");
  if (finalTrain.total >= baselineTrain.total) {
    console.log("   ⚠️  Final train loss did NOT improve — check loss weights or initial weights.");
  } else {
    console.log(`   ✓  Train loss improved: ${baselineTrain.total.toFixed(4)} → ${finalTrain.total.toFixed(4)} (Δ=${(baselineTrain.total - finalTrain.total).toFixed(4)})`);
  }
  if (looMeanLoss > 1.5 * finalTrain.total) {
    console.log(`   ⚠️  LOO mean loss (${looMeanLoss.toFixed(4)}) > 1.5× train loss (${finalTrain.total.toFixed(4)}) — possible overfitting.`);
  } else {
    console.log(`   ✓  LOO mean loss (${looMeanLoss.toFixed(4)}) within 1.5× of train (${finalTrain.total.toFixed(4)}) — good generalization.`);
  }
  const unstable = WEIGHT_KEYS.filter(k => loo.stdWeights[k] / Math.max(0.01, Math.abs(loo.meanWeights[k])) > 0.5);
  if (unstable.length > 0) {
    console.log(`   ⚠️  Unstable weights (LOO std > 50% of mean): ${unstable.join(", ")}`);
  } else {
    console.log("   ✓  All weights have stable LOO distributions.");
  }
  if (!Number.isFinite(finalTrain.total)) {
    console.log("   ❌ Final loss is not finite — bug in the loss function.");
  }
}

interface CachedEvent {
  input: EventInput;
  truth: EventGroundTruth;
}

async function loadEvents(): Promise<EventData[]> {
  if (fs.existsSync(CACHE_FILE)) {
    console.log(`Loading cached events from ${CACHE_FILE}...`);
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")) as CachedEvent[];
    return cached.map(c => ({
      input: {
        eventSlug: c.input.eventSlug,
        players: c.input.players as FantasyPlayer[],
        teams: c.input.teams as FantasyTeam[],
      },
      truth: c.truth,
    }));
  }

  console.log("Loading events from disk (this may take a minute for historical stats)...");
  const ratingFiles = fs.readdirSync(RATINGS_DIR).filter(f => f.endsWith(".html")).sort();
  const extractor = new HtmlExtractorService();
  const scraper = new StatsScraperService();
  const events: EventData[] = [];

  for (const file of ratingFiles) {
    const draftPath = path.join(DRAFT_DIR, file);
    if (!fs.existsSync(draftPath)) {
      console.warn(`  ⚠️  No matching draft for ${file}, skipping.`);
      continue;
    }
    const truth = parseEventGroundTruth({
      ratingsFile: path.join(RATINGS_DIR, file),
      bestValueFile: path.join(RESULTS_DIR, file),
      eventSlug: path.basename(file, ".html"),
    });
    try {
      const result = await extractor.extract(file);
      const enriched = await scraper.enrichPlayersWithHistoricalStats(result.players);
      events.push({
        input: {eventSlug: truth.eventSlug, players: enriched, teams: result.teams},
        truth,
      });
      console.log(
        `  ✓ ${truth.eventSlug}: ${enriched.length} players, ${result.teams.length} teams, ` +
        `ratings=${truth.ratings.length}, bestValue=${truth.bestValuePlayers.length}`,
      );
    } catch (err) {
      console.error(`  ❌ Failed to load ${file}:`, err);
    }
  }

  fs.mkdirSync(path.dirname(CACHE_FILE), {recursive: true});
  fs.writeFileSync(CACHE_FILE, JSON.stringify(events, null, 2));
  console.log(`  → Cached to ${CACHE_FILE}`);
  return events;
}

async function main() {
  console.log("🚀 v5 Weight Optimization\n");
  console.log(`📂 Ratings:  ${RATINGS_DIR}`);
  console.log(`📂 Results:  ${RESULTS_DIR}`);
  console.log(`📂 Drafts:   ${DRAFT_DIR}\n`);

  const events = await loadEvents();
  if (events.length < 4) {
    console.error(`Need at least 4 events for train/test split; got ${events.length}.`);
    process.exit(1);
  }
  console.log(`\n✅ Loaded ${events.length} events\n`);

  const trainIdx = Math.max(1, Math.floor(events.length * TRAIN_FRACTION));
  const trainSet = events.slice(0, trainIdx);
  const testSet = events.slice(trainIdx);
  console.log(`📊 Train: ${trainSet.length} events | Test: ${testSet.length} events\n`);

  const baselineEval = await evaluateFull(BASELINE_WEIGHTS, events);
  const baselineTrainEval = await evaluateFull(BASELINE_WEIGHTS, trainSet);
  const baselineTestEval = await evaluateFull(BASELINE_WEIGHTS, testSet);

  console.log("📊 BASELINE (current weights):");
  console.log(`   Train total: ${baselineTrainEval.breakdown.total.toFixed(4)}`);
  console.log(`   Test total:  ${baselineTestEval.breakdown.total.toFixed(4)}`);
  console.log(`   Mean Spearman: ${baselineEval.breakdown.spearman.toFixed(4)} (negated = ${(-baselineEval.breakdown.spearman).toFixed(4)} correlation)\n`);

  const t0 = Date.now();
  const {allRuns, bestRun} = await runFullOptimization(trainSet, testSet);
  const optTime = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log(`\n⏱️  Full optimization took ${optTime} min`);

  const optimizedEval = await evaluateFull(bestRun.weights, events);
  console.log("\n📊 OPTIMIZED (best restart):");
  console.log(`   Train total: ${bestRun.trainLoss.total.toFixed(4)}`);
  console.log(`   Test total:  ${bestRun.testLoss.total.toFixed(4)}`);
  console.log(`   Mean Spearman: ${optimizedEval.breakdown.spearman.toFixed(4)} (correlation ${(-optimizedEval.breakdown.spearman).toFixed(4)})`);

  const t1 = Date.now();
  const loo = await runLeaveOneOut(events, bestRun.weights);
  const looTime = ((Date.now() - t1) / 1000 / 60).toFixed(1);
  console.log(`\n⏱️  LOO took ${looTime} min`);

  printWeightComparison(BASELINE_WEIGHTS, bestRun.weights, loo);
  printPerEventAnalysis(baselineEval.perEvent, optimizedEval.perEvent);
  printAttribution(events, bestRun.weights);
  printQualityFlags(
    baselineTrainEval.breakdown,
    bestRun.trainLoss,
    loo.meanTestLoss,
    loo,
  );

  const output = {
    generatedAt: new Date().toISOString(),
    eventCount: events.length,
    trainCount: trainSet.length,
    testCount: testSet.length,
    baselineWeights: BASELINE_WEIGHTS,
    bestWeights: bestRun.weights,
    bestWeightsLooMean: loo.meanWeights,
    bestWeightsLooStd: loo.stdWeights,
    baselineTrainLoss: baselineTrainEval.breakdown,
    baselineTestLoss: baselineTestEval.breakdown,
    optimizedTrainLoss: bestRun.trainLoss,
    optimizedTestLoss: bestRun.testLoss,
    allRuns: allRuns.map(r => ({
      seed: r.seed,
      iterations: r.iterations,
      converged: r.converged,
      trainLoss: r.trainLoss.total,
      testLoss: r.testLoss.total,
      weights: r.weights,
    })),
    loo: {
      meanTestLoss: loo.meanTestLoss,
      perEvent: loo.perEvent.map(p => ({
        eventSlug: p.eventSlug,
        testLoss: p.testLoss.total,
        weights: p.weights,
      })),
    },
    perEvent: optimizedEval.perEvent.map(e => ({
      eventSlug: e.eventSlug,
      spearman: e.spearman,
      topRatedCoverage: e.topRatedCoverage,
      bestValueCoverage: e.bestValueCoverage,
      meanActualInTopLineups: e.meanActualInTopLineups,
      meanPredictedInTopLineups: e.meanPredictedInTopLineups,
    })),
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n💾 Saved to ${OUTPUT_FILE}`);
  console.log("\n✨ Done.");
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
