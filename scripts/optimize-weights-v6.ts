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
const OUTPUT_FILE = path.join(process.cwd(), "optimization-results-v6.json");
const CACHE_FILE = path.join(process.cwd(), ".cache", "v6-events.json");

const MIN_MAPS_FOR_RATING = 6;
const MAP_WEIGHT_THRESHOLD = 8;
const RATING_TOP_THRESHOLD = 1.18;

const LOSS_SPEARMAN_WEIGHT = 1.0;
const LOSS_TOP_RATED_COVERAGE_WEIGHT = 0.5;
const LOSS_BEST_VALUE_COVERAGE_WEIGHT = 0.2;
const LOSS_REGULARIZATION_WEIGHT = 0.0;

const TOP_LINEUPS_COUNT = 30;
const PROGRESS_LOG_EVERY_PCT = 2;

const BASELINE_WEIGHTS: WeightConfig = {
  cardRatingBenefit: 0.5,
  historicalTop20RatingBenefit: 1,
  topTeamRankBenefit: 0.5,
  awperRoleBenefit: 0,
  lowDeathRateBenefit: 0,
  ctVsTRatingImbalancePenalty: 0.5,
  stackCorrelationBenefit: 0.5,
  topRankedTeamStackBenefit: 0.25,
  awpPerRoundWeight: 0,
  deathPenaltyWeight: 0,
  priceEfficiencyBenefit: 0,
};

const V5_WEIGHTS: WeightConfig = {
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

const OPTIMIZED_KEYS: (keyof WeightConfig)[] = [
  "cardRatingBenefit",
  "historicalTop20RatingBenefit",
  "topTeamRankBenefit",
  "ctVsTRatingImbalancePenalty",
];

const COARSE_RANGES: Record<keyof WeightConfig, number[]> = {
  cardRatingBenefit: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 1.8, 2.0],
  historicalTop20RatingBenefit: [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 7.0, 8.0],
  topTeamRankBenefit: [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.25, 2.5, 2.75, 3.0],
  ctVsTRatingImbalancePenalty: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.35, 1.5],
  awperRoleBenefit: [0],
  lowDeathRateBenefit: [0],
  stackCorrelationBenefit: [0.5],
  topRankedTeamStackBenefit: [0.25],
  awpPerRoundWeight: [0],
  deathPenaltyWeight: [0],
  priceEfficiencyBenefit: [0],
};

const MEDIUM_STEP = 0.1;
const MEDIUM_RADIUS = 3;
const FINE_STEP = 0.02;
const FINE_RADIUS = 2;
const SLICE_SAMPLES = 41;

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

interface GridPoint {
  values: number[];
  weights: WeightConfig;
  loss: LossBreakdown;
}

interface SlicePoint {
  key: keyof WeightConfig;
  value: number;
  loss: number;
}

function clampWeight(w: number): number {
  return Math.max(0, Math.min(2, w));
}

function cloneWeights(w: WeightConfig): WeightConfig {
  return {...w};
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

type CachedLineups = Map<string, {playerNames: string[]}[]>;

function precomputeLineups(
  events: EventData[],
  weights: WeightConfig,
  config: FantasyConfig = {strategy: "2-2-1"},
): CachedLineups {
  const overrides = weightToOptimizerOverrides(weights);
  const out: CachedLineups = new Map();
  for (const event of events) {
    const lineups = mathOptimizer.optimize(
      event.input.players,
      event.input.teams,
      config,
      overrides,
    );
    out.set(
      event.truth.eventSlug,
      lineupsToNames(lineups),
    );
  }
  return out;
}

function evaluateFast(
  weights: WeightConfig,
  events: EventData[],
  cachedLineups: CachedLineups,
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

function valuesAround(center: number, step: number, radius: number): number[] {
  const out: number[] = [];
  for (let m = -radius; m <= radius; m++) {
    const v = center + m * step;
    if (v < 0) continue;
    out.push(Number(v.toFixed(6)));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function valuesInRange(min: number, max: number, samples: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    out.push(min + (max - min) * (i / (samples - 1)));
  }
  return out;
}

interface GridSearchOptions {
  topN: number;
  label: string;
  saveEvery?: number;
  progressLogPath?: string;
}

async function gridSearch(
  events: EventData[],
  initWeights: WeightConfig,
  valueLists: [number[], number[], number[], number[]],
  cachedLineups: CachedLineups,
  opts: GridSearchOptions,
): Promise<{top: GridPoint[]; best: GridPoint; count: number; elapsedMs: number}> {
  const [v0s, v1s, v2s, v3s] = valueLists;
  const total = v0s.length * v1s.length * v2s.length * v3s.length;
  const msg = `\n  📐 [${opts.label}] ${v0s.length}×${v1s.length}×${v2s.length}×${v3s.length} = ${total} evaluations (cached lineups)`;
  console.log(msg);
  if (opts.progressLogPath) {
    fs.appendFileSync(opts.progressLogPath, msg + "\n");
  }

  const top: GridPoint[] = [];
  let best: GridPoint | null = null;
  let count = 0;
  const t0 = Date.now();
  const progressEvery = Math.max(1, Math.floor((total * PROGRESS_LOG_EVERY_PCT) / 100));

  for (const v0 of v0s) {
    for (const v1 of v1s) {
      for (const v2 of v2s) {
        for (const v3 of v3s) {
          const weights: WeightConfig = {
            ...initWeights,
            cardRatingBenefit: v0,
            historicalTop20RatingBenefit: v1,
            topTeamRankBenefit: v2,
            ctVsTRatingImbalancePenalty: v3,
          };
          const {breakdown} = evaluateFast(weights, events, cachedLineups);
          const point: GridPoint = {
            values: [v0, v1, v2, v3],
            weights,
            loss: breakdown,
          };

          if (!best || breakdown.total < best.loss.total) {
            best = point;
          }

          if (top.length < opts.topN) {
            top.push(point);
            top.sort((a, b) => a.loss.total - b.loss.total);
          } else if (breakdown.total < top[top.length - 1]!.loss.total) {
            top[top.length - 1] = point;
            top.sort((a, b) => a.loss.total - b.loss.total);
          }

          count++;
          if (count % progressEvery === 0) {
            const elapsed = (Date.now() - t0) / 1000;
            const rate = count / elapsed;
            const eta = (total - count) / rate;
            const line = (
              `    ${count.toString().padStart(6)}/${total} ` +
              `(${(100 * count / total).toFixed(1).padStart(5)}%) ` +
              `best=${best!.loss.total.toFixed(4)} ` +
              `elapsed=${(elapsed / 60).toFixed(1)}m ` +
              `eta=${(eta / 60).toFixed(1)}m\n`
            );
            process.stdout.write(line);
            if (opts.progressLogPath) {
              fs.appendFileSync(opts.progressLogPath, line);
            }
            if (opts.saveEvery && count % opts.saveEvery === 0) {
              saveIntermediate({label: opts.label, count, total, best: best!, top: top.slice()});
            }
          }
        }
      }
    }
  }

  const elapsedMs = Date.now() - t0;
  const doneLine = `    ✓ done in ${(elapsedMs / 1000 / 60).toFixed(1)} min | best loss = ${best!.loss.total.toFixed(4)}\n`;
  console.log(`    ✓ done in ${(elapsedMs / 1000 / 60).toFixed(1)} min | best loss = ${best!.loss.total.toFixed(4)}`);
  if (opts.progressLogPath) {
    fs.appendFileSync(opts.progressLogPath, doneLine);
  }
  return {top, best: best!, count, elapsedMs};
}

function saveIntermediate(state: {label: string; count: number; total: number; best: GridPoint; top: GridPoint[]}): void {
  const file = path.join(process.cwd(), `optimization-results-v6-${state.label}-checkpoint.json`);
  fs.writeFileSync(file, JSON.stringify({
    phase: state.label,
    progress: `${state.count}/${state.total}`,
    best: {values: state.best.values, weights: state.best.weights, loss: state.best.loss},
    top: state.top.map(p => ({values: p.values, loss: p.loss.total})),
  }, null, 2));
}

async function gridSearchFull(
  events: EventData[],
  initWeights: WeightConfig,
  valueLists: [number[], number[], number[], number[]],
  opts: GridSearchOptions,
): Promise<{top: GridPoint[]; best: GridPoint; count: number; elapsedMs: number}> {
  const [v0s, v1s, v2s, v3s] = valueLists;
  const total = v0s.length * v1s.length * v2s.length * v3s.length;
  const msg = `\n  📐 [${opts.label}] ${v0s.length}×${v1s.length}×${v2s.length}×${v3s.length} = ${total} evaluations (full mode)`;
  console.log(msg);
  if (opts.progressLogPath) {
    fs.appendFileSync(opts.progressLogPath, msg + "\n");
  }

  const top: GridPoint[] = [];
  let best: GridPoint | null = null;
  let count = 0;
  const t0 = Date.now();
  const progressEvery = Math.max(1, Math.floor((total * PROGRESS_LOG_EVERY_PCT) / 100));

  for (const v0 of v0s) {
    for (const v1 of v1s) {
      for (const v2 of v2s) {
        for (const v3 of v3s) {
          const weights: WeightConfig = {
            ...initWeights,
            cardRatingBenefit: v0,
            historicalTop20RatingBenefit: v1,
            topTeamRankBenefit: v2,
            ctVsTRatingImbalancePenalty: v3,
          };
          const {breakdown} = await evaluateFull(weights, events);
          const point: GridPoint = {
            values: [v0, v1, v2, v3],
            weights,
            loss: breakdown,
          };

          if (!best || breakdown.total < best.loss.total) {
            best = point;
          }

          if (top.length < opts.topN) {
            top.push(point);
            top.sort((a, b) => a.loss.total - b.loss.total);
          } else if (breakdown.total < top[top.length - 1]!.loss.total) {
            top[top.length - 1] = point;
            top.sort((a, b) => a.loss.total - b.loss.total);
          }

          count++;
          if (count % progressEvery === 0) {
            const elapsed = (Date.now() - t0) / 1000;
            const rate = count / elapsed;
            const eta = (total - count) / rate;
            const line = (
              `    ${count.toString().padStart(6)}/${total} ` +
              `(${(100 * count / total).toFixed(1).padStart(5)}%) ` +
              `best=${best!.loss.total.toFixed(4)} ` +
              `elapsed=${(elapsed / 60).toFixed(1)}m ` +
              `eta=${(eta / 60).toFixed(1)}m\n`
            );
            process.stdout.write(line);
            if (opts.progressLogPath) {
              fs.appendFileSync(opts.progressLogPath, line);
            }
          }
        }
      }
    }
  }

  const elapsedMs = Date.now() - t0;
  console.log(`    ✓ done in ${(elapsedMs / 1000 / 60).toFixed(1)} min | best loss = ${best!.loss.total.toFixed(4)}`);
  if (opts.progressLogPath) {
    fs.appendFileSync(opts.progressLogPath, `    ✓ done in ${(elapsedMs / 1000 / 60).toFixed(1)} min | best loss = ${best!.loss.total.toFixed(4)}\n`);
  }
  return {top, best: best!, count, elapsedMs};
}

async function runMultiResolutionSearch(
  events: EventData[],
  cachedLineups: CachedLineups,
  progressLogPath: string,
): Promise<{
  coarse: GridPoint[];
  verifiedTop: GridPoint[];
  medium: GridPoint[];
  fine: GridPoint[];
  best: GridPoint;
  coarseCount: number;
  verifiedCount: number;
  mediumCount: number;
  fineCount: number;
  coarseMs: number;
  verifiedMs: number;
  mediumMs: number;
  fineMs: number;
}> {
  const tAll = Date.now();
  const fixedInit: WeightConfig = cloneWeights(BASELINE_WEIGHTS);

  const coarseValueLists: [number[], number[], number[], number[]] = OPTIMIZED_KEYS.map(k => COARSE_RANGES[k]) as [number[], number[], number[], number[]];
  const coarse = await gridSearch(events, fixedInit, coarseValueLists, cachedLineups, {
    label: "coarse-cached",
    topN: 30,
    saveEvery: 5000,
    progressLogPath,
  });

  const tVerify0 = Date.now();
  console.log("\n  🔬 PHASE 1.5: VERIFYING TOP 20 FROM COARSE WITH FULL MODE (recomputes lineups)...");
  const verifyTop = coarse.top.slice(0, 20);
  const verifiedResults: GridPoint[] = [];
  for (let i = 0; i < verifyTop.length; i++) {
    const p = verifyTop[i]!;
    const {breakdown} = await evaluateFull(p.weights, events);
    const newPoint: GridPoint = {values: p.values, weights: p.weights, loss: breakdown};
    verifiedResults.push(newPoint);
    const elapsed = (Date.now() - tVerify0) / 1000;
    console.log(
      `    [${(i + 1).toString().padStart(2)}/20] loss_full=${breakdown.total.toFixed(4)} ` +
      `(cached was ${p.loss.total.toFixed(4)})  ` +
      `elapsed=${elapsed.toFixed(1)}s  ` +
      OPTIMIZED_KEYS.map((k, ki) => `${k}=${p.values[ki]!.toFixed(2)}`).join(" "),
    );
  }
  verifiedResults.sort((a, b) => a.loss.total - b.loss.total);
  const verifiedTop = verifiedResults.slice(0, 10);
  const verifiedMs = Date.now() - tVerify0;
  console.log(`  ✓ Verified top done in ${(verifiedMs / 1000).toFixed(1)}s\n`);

  const tMed0 = Date.now();
  console.log("  📐 PHASE 2: MEDIUM REFINE (full mode, 5 centers × 7^4 = 12,005 evals)");
  const mediumResults: GridPoint[] = [];
  let mediumCount = 0;
  const centers = verifiedTop.slice(0, 5);
  for (let i = 0; i < centers.length; i++) {
    const center = centers[i]!;
    const valueLists: [number[], number[], number[], number[]] = OPTIMIZED_KEYS.map((k, ki) => {
      const cv = center.values[ki]!;
      return valuesAround(cv, MEDIUM_STEP, MEDIUM_RADIUS);
    }) as [number[], number[], number[], number[]];
    const result = await gridSearchFull(events, fixedInit, valueLists, {
      label: `medium-${i + 1}`,
      topN: 3,
      progressLogPath,
    });
    mediumResults.push(...result.top);
    mediumCount += result.count;
  }
  mediumResults.sort((a, b) => a.loss.total - b.loss.total);
  const medium = mediumResults.slice(0, 10);
  const mediumMs = Date.now() - tMed0;
  console.log(`  ✓ Medium done in ${(mediumMs / 1000 / 60).toFixed(1)} min\n`);

  const bestMedium = medium[0]!;
  const tFine0 = Date.now();
  console.log("  📐 PHASE 3: FINE REFINE (full mode, 5^4 = 625 evals around best)");
  const fineValueLists: [number[], number[], number[], number[]] = OPTIMIZED_KEYS.map((k, ki) => {
    const cv = bestMedium.values[ki]!;
    return valuesAround(cv, FINE_STEP, FINE_RADIUS);
  }) as [number[], number[], number[], number[]];
  const fine = await gridSearchFull(events, fixedInit, fineValueLists, {
    label: "fine",
    topN: 5,
    progressLogPath,
  });
  const fineMs = Date.now() - tFine0;
  console.log(`  ✓ Fine done in ${(fineMs / 1000).toFixed(1)}s\n`);

  const best = fine.top[0]!;
  const totalMin = (Date.now() - tAll) / 1000 / 60;
  console.log(`  ⏱️  Total multi-resolution: ${totalMin.toFixed(1)} min`);

  return {
    coarse: coarse.top,
    verifiedTop,
    medium,
    fine: fine.top,
    best,
    coarseCount: coarse.count,
    verifiedCount: verifiedResults.length,
    mediumCount,
    fineCount: fine.count,
    coarseMs: coarse.elapsedMs,
    verifiedMs,
    mediumMs,
    fineMs,
  };
}

async function runSensitivitySlices(
  events: EventData[],
  bestWeights: WeightConfig,
): Promise<Record<keyof WeightConfig, SlicePoint[]>> {
  console.log("\n  📈 PHASE 4: 1D LOSS SURFACE SLICES (full mode, recomputes lineups)");
  const slices: Record<string, SlicePoint[]> = {};

  for (const k of OPTIMIZED_KEYS) {
    const optV = bestWeights[k];
    const range = COARSE_RANGES[k];
    const minV = Math.min(...range);
    const maxV = Math.max(...range);
    const sampleValues = valuesInRange(minV, maxV, SLICE_SAMPLES);

    const points: SlicePoint[] = [];
    console.log(`    ${k.padEnd(34)}: sweeping ${minV} → ${maxV} (${SLICE_SAMPLES} pts)`);
    for (const v of sampleValues) {
      const w: WeightConfig = {...bestWeights, [k]: v};
      const {breakdown} = await evaluateFull(w, events);
      points.push({key: k, value: v, loss: breakdown.total});
    }
    slices[k] = points;
  }

  return slices as Record<keyof WeightConfig, SlicePoint[]>;
}

function printSliceAscii(key: keyof WeightConfig, points: SlicePoint[], bestV: number, bestLoss: number): void {
  console.log(`\n  📊 ${key} (optimum = ${bestV.toFixed(3)}, loss = ${bestLoss.toFixed(4)})`);
  const W = 60;
  const H = 16;
  const minL = Math.min(...points.map(p => p.loss));
  const maxL = Math.max(...points.map(p => p.loss));
  const span = Math.max(1e-6, maxL - minL);
  const vMin = Math.min(...points.map(p => p.value));
  const vMax = Math.max(...points.map(p => p.value));
  const vSpan = Math.max(1e-6, vMax - vMin);

  const grid: string[][] = Array.from({length: H}, () => Array(W).fill(" "));
  for (let y = 0; y < H; y++) {
    grid[y]![0] = "│";
    grid[y]![W - 1] = "│";
  }
  grid[0]![0] = "┌";
  grid[0]![W - 1] = "┐";
  grid[H - 1]![0] = "└";
  grid[H - 1]![W - 1] = "┘";
  for (let x = 1; x < W - 1; x++) {
    grid[0]![x] = "─";
    grid[H - 1]![x] = "─";
  }

  for (const p of points) {
    const x = Math.min(W - 2, Math.max(1, Math.floor(((p.value - vMin) / vSpan) * (W - 3) + 1)));
    const y = Math.min(H - 2, Math.max(1, H - 2 - Math.floor(((p.loss - minL) / span) * (H - 2))));
    grid[y]![x] = "·";
  }

  const bestX = Math.min(W - 2, Math.max(1, Math.floor(((bestV - vMin) / vSpan) * (W - 3) + 1)));
  const bestY = Math.min(H - 2, Math.max(1, H - 2 - Math.floor(((bestLoss - minL) / span) * (H - 2))));
  grid[bestY]![bestX] = "★";

  for (const row of grid) {
    console.log("    " + row.join(""));
  }
  console.log(`    x: [${vMin.toFixed(2)} ─── ${vMax.toFixed(2)}]`);
  console.log(`    y: [${minL.toFixed(4)} ─── ${maxL.toFixed(4)}]    ★ = optimum, · = sample`);
}

function printBestWeights(
  best: GridPoint,
  v5Eval: {breakdown: LossBreakdown},
  userBaselineEval: {breakdown: LossBreakdown},
): void {
  console.log("\n🏆 OPTIMAL WEIGHTS (4-weight grid search, no regularization)");
  console.log("─".repeat(70));
  const labels: string[] = [
    "cardRatingBenefit             ",
    "historicalTop20RatingBenefit  ",
    "topTeamRankBenefit            ",
    "ctVsTRatingImbalancePenalty   ",
  ];
  for (let i = 0; i < OPTIMIZED_KEYS.length; i++) {
    const k = OPTIMIZED_KEYS[i]!;
    const optV = best.values[i]!;
    const userV = BASELINE_WEIGHTS[k];
    const v5V = V5_WEIGHTS[k];
    console.log(
      `  ${labels[i]}  optimal=${optV.toFixed(3).padStart(7)}   ` +
      `user_hunch=${userV.toFixed(3).padStart(6)}   v5_default=${v5V.toFixed(3).padStart(6)}`,
    );
  }
  console.log("─".repeat(70));
  console.log(`  Total loss:`);
  console.log(`    optimal:        ${best.loss.total.toFixed(5)}`);
  console.log(`    user hunch:     ${userBaselineEval.breakdown.total.toFixed(5)}  (Δ vs optimal = ${(userBaselineEval.breakdown.total - best.loss.total).toFixed(5)})`);
  console.log(`    v5 defaults:    ${v5Eval.breakdown.total.toFixed(5)}  (Δ vs optimal = ${(v5Eval.breakdown.total - best.loss.total).toFixed(5)})`);
  console.log("─".repeat(70));
  console.log(`  Loss components at optimum:`);
  console.log(`    -Spearman correlation:   ${(-best.loss.spearman).toFixed(4)}  (was ${(-userBaselineEval.breakdown.spearman).toFixed(4)} at user hunch)`);
  console.log(`    Top-rated coverage:      ${(1 - best.loss.topRatedCoverage).toFixed(4)}  (was ${(1 - userBaselineEval.breakdown.topRatedCoverage).toFixed(4)})`);
  console.log(`    Best-value coverage:     ${(1 - best.loss.bestValueCoverage).toFixed(4)}  (was ${(1 - userBaselineEval.breakdown.bestValueCoverage).toFixed(4)})`);
  console.log("─".repeat(70));
}

function printSensitivity(
  best: GridPoint,
  slices: Record<keyof WeightConfig, SlicePoint[]>,
): void {
  console.log("\n🔬 SENSITIVITY (how much does loss change if we move each weight away from optimum?)");
  console.log("─".repeat(90));
  const header = ["Weight", "Optimum", "Loss @ opt", "Loss @ +25%", "Loss @ -25%", "Loss @ +50%", "Loss @ -50%", "Δmax", "Tolerance"];
  const rows: string[][] = [header];
  for (const k of OPTIMIZED_KEYS) {
    const optV = best.weights[k];
    const optLoss = best.loss.total;
    const slicePts = slices[k]!;

    const findLossAt = (targetV: number): number => {
      let bestPt = slicePts[0]!;
      let bestDist = Math.abs(bestPt.value - targetV);
      for (const p of slicePts) {
        const d = Math.abs(p.value - targetV);
        if (d < bestDist) {
          bestDist = d;
          bestPt = p;
        }
      }
      return bestPt.loss;
    };

    const p25 = findLossAt(optV * 1.25);
    const m25 = findLossAt(optV * 0.75);
    const p50 = findLossAt(optV * 1.5);
    const m50 = findLossAt(optV * 0.5);
    const maxDelta = Math.max(p25, m25, p50, m50) - optLoss;
    const tolerance = maxDelta < 0.001 ? "±50%+" : maxDelta < 0.005 ? "±25%" : maxDelta < 0.01 ? "±10%" : "tight";

    rows.push([
      k,
      optV.toFixed(3),
      optLoss.toFixed(4),
      p25.toFixed(4),
      m25.toFixed(4),
      p50.toFixed(4),
      m50.toFixed(4),
      (maxDelta >= 0 ? "+" : "") + maxDelta.toFixed(4),
      tolerance,
    ]);
  }

  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(r => r[i]!.length)));
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  for (const row of rows) {
    console.log("  " + fmt(row));
  }
  console.log("─".repeat(90));
}

function printPerEventTable(label: string, evalResult: {perEvent: EventEval[]; breakdown: LossBreakdown}): void {
  console.log(`\n  ${label}:`);
  const header = ["Event", "Spearman", "TopRated Cov", "BestVal Cov"];
  console.log("    " + header.map(h => h.padEnd(20)).join(""));
  console.log("    " + "─".repeat(80));
  for (const e of evalResult.perEvent) {
    const spStr = e.hasRatings ? e.spearman.toFixed(3) : "n/a";
    const trStr = e.hasRatings ? `${(e.topRatedCoverage * 100).toFixed(0)}%` : "n/a";
    const bvStr = e.hasBestValue ? `${(e.bestValueCoverage * 100).toFixed(0)}%` : "n/a";
    console.log(
      "    " +
      e.eventSlug.padEnd(48).slice(0, 48) +
      "  " + spStr.padEnd(20) +
      "  " + trStr.padEnd(20) +
      "  " + bvStr.padEnd(20),
    );
  }
  console.log("    " + "─".repeat(80));
  console.log(
    `    MEAN: Spearman=${(-evalResult.breakdown.spearman).toFixed(3)}  ` +
    `TopRated=${(1 - evalResult.breakdown.topRatedCoverage).toFixed(3)}  ` +
    `BestVal=${(1 - evalResult.breakdown.bestValueCoverage).toFixed(3)}  ` +
    `Total=${evalResult.breakdown.total.toFixed(4)}`,
  );
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
  const PROGRESS_LOG = path.join(process.cwd(), "optimization-v6.log");
  fs.writeFileSync(PROGRESS_LOG, "");

  console.log("🚀 v6 Weight Optimization — Long-Run Grid Search\n");
  console.log(`📂 Ratings:  ${RATINGS_DIR}`);
  console.log(`📂 Results:  ${RESULTS_DIR}`);
  console.log(`📂 Drafts:   ${DRAFT_DIR}\n`);
  console.log("🎯 Optimizing 4 weights via multi-resolution grid search on ALL events:");
  console.log("   - cardRatingBenefit");
  console.log("   - historicalTop20RatingBenefit");
  console.log("   - topTeamRankBenefit");
  console.log("   - ctVsTRatingImbalancePenalty");
  console.log("   (other 7 weights held at user-specified baseline values)");
  console.log(`   Progress log: ${PROGRESS_LOG}\n`);

  const events = await loadEvents();
  if (events.length < 4) {
    console.error(`Need at least 4 events; got ${events.length}.`);
    process.exit(1);
  }
  console.log(`\n✅ Loaded ${events.length} events`);

  const tAll = Date.now();
  const startIso = new Date().toISOString();

  const v5Eval = await evaluateFull(V5_WEIGHTS, events);
  const userBaselineEval = await evaluateFull(BASELINE_WEIGHTS, events);
  console.log(`\n📊 BASELINES (all ${events.length} events):`);
  console.log(`   v5 default weights:    loss=${v5Eval.breakdown.total.toFixed(5)}  ` +
    `Spearman=${(-v5Eval.breakdown.spearman).toFixed(3)}`);
  console.log(`   user-suggested values: loss=${userBaselineEval.breakdown.total.toFixed(5)}  ` +
    `Spearman=${(-userBaselineEval.breakdown.spearman).toFixed(3)}\n`);

  console.log("  📦 Pre-computing lineups at baseline weights (used for fast grid search)...");
  const cachedLineups = precomputeLineups(events, BASELINE_WEIGHTS);
  console.log(`  ✓ Cached lineups for ${cachedLineups.size} events\n`);

  const mr = await runMultiResolutionSearch(events, cachedLineups, PROGRESS_LOG);

  console.log("\n🔍 Top 5 from coarse grid (cached lineups):");
  for (const p of mr.coarse.slice(0, 5)) {
    console.log(
      `    loss=${p.loss.total.toFixed(4)} | ` +
      OPTIMIZED_KEYS.map((k, i) => `${k}=${p.values[i]!.toFixed(2)}`).join(", "),
    );
  }

  console.log("\n🔍 Top 5 from full-mode verification:");
  for (const p of mr.verifiedTop.slice(0, 5)) {
    console.log(
      `    loss_full=${p.loss.total.toFixed(4)} | ` +
      OPTIMIZED_KEYS.map((k, i) => `${k}=${p.values[i]!.toFixed(3)}`).join(", "),
    );
  }

  console.log("\n🔍 Top 5 from medium refine (full mode):");
  for (const p of mr.medium.slice(0, 5)) {
    console.log(
      `    loss=${p.loss.total.toFixed(4)} | ` +
      OPTIMIZED_KEYS.map((k, i) => `${k}=${p.values[i]!.toFixed(3)}`).join(", "),
    );
  }

  console.log("\n🔍 Top 5 from fine refine (full mode):");
  for (const p of mr.fine.slice(0, 5)) {
    console.log(
      `    loss=${p.loss.total.toFixed(4)} | ` +
      OPTIMIZED_KEYS.map((k, i) => `${k}=${p.values[i]!.toFixed(4)}`).join(", "),
    );
  }

  const slices = await runSensitivitySlices(events, mr.best.weights);

  const verifiedBest = mr.best;
  const optimalEval = await evaluateFull(verifiedBest.weights, events);

  const totalMin = (Date.now() - tAll) / 1000 / 60;
  console.log(`\n⏱️  Total runtime: ${totalMin.toFixed(1)} min`);

  printBestWeights(verifiedBest, v5Eval, userBaselineEval);
  printSensitivity(verifiedBest, slices);
  for (const k of OPTIMIZED_KEYS) {
    printSliceAscii(k, slices[k]!, verifiedBest.weights[k], verifiedBest.loss.total);
  }

  console.log("\n📋 Per-event comparison");
  printPerEventTable("OPTIMAL (verified, full eval)", optimalEval);
  printPerEventTable("USER HUNCH (0.5, 1, 0.5, 0.5)", userBaselineEval);
  printPerEventTable("V5 DEFAULTS (0.25, 3, 1.5, 0.5)", v5Eval);

  const output = {
    generatedAt: startIso,
    completedAt: new Date().toISOString(),
    totalRuntimeMin: totalMin,
    eventCount: events.length,
    optimizedKeys: OPTIMIZED_KEYS,
    fixedKeys: WEIGHT_KEYS.filter(k => !OPTIMIZED_KEYS.includes(k)),
    userBaseline: BASELINE_WEIGHTS,
    v5Baseline: V5_WEIGHTS,
    v5BaselineLoss: v5Eval.breakdown.total,
    userBaselineLoss: userBaselineEval.breakdown.total,
    optimalWeights: mr.best.weights,
    optimalValues: mr.best.values,
    optimalLoss: mr.best.loss.total,
    improvement: {
      overUserHunch: userBaselineEval.breakdown.total - mr.best.loss.total,
      overV5Defaults: v5Eval.breakdown.total - mr.best.loss.total,
      overUserHunchPct: 100 * (userBaselineEval.breakdown.total - mr.best.loss.total) / userBaselineEval.breakdown.total,
      overV5DefaultsPct: 100 * (v5Eval.breakdown.total - mr.best.loss.total) / v5Eval.breakdown.total,
    },
    phaseStats: {
      coarse: {count: mr.coarseCount, runtimeMs: mr.coarseMs, topN: 30, mode: "cached-lineups"},
      verified: {count: mr.verifiedCount, runtimeMs: mr.verifiedMs, topN: 10, mode: "full-eval"},
      medium: {count: mr.mediumCount, runtimeMs: mr.mediumMs, topN: 10, mode: "full-eval"},
      fine: {count: mr.fineCount, runtimeMs: mr.fineMs, topN: 5, mode: "full-eval"},
    },
    coarseTop30: mr.coarse.map(p => ({values: p.values, loss: p.loss.total})),
    verifiedTop10: mr.verifiedTop.map(p => ({values: p.values, loss: p.loss.total})),
    mediumTop10: mr.medium.map(p => ({values: p.values, loss: p.loss.total})),
    fineTop5: mr.fine.map(p => ({values: p.values, loss: p.loss.total})),
    slices: Object.fromEntries(
      OPTIMIZED_KEYS.map(k => [
        k,
        slices[k]!.map(p => ({value: p.value, loss: p.loss})),
      ]),
    ),
    perEvent: {
      optimal: optimalEval.perEvent.map(e => ({
        eventSlug: e.eventSlug,
        spearman: e.spearman,
        topRatedCoverage: e.topRatedCoverage,
        bestValueCoverage: e.bestValueCoverage,
        meanActualInTopLineups: e.meanActualInTopLineups,
      })),
      userHunch: userBaselineEval.perEvent.map(e => ({
        eventSlug: e.eventSlug,
        spearman: e.spearman,
        topRatedCoverage: e.topRatedCoverage,
        bestValueCoverage: e.bestValueCoverage,
        meanActualInTopLineups: e.meanActualInTopLineups,
      })),
      v5Defaults: v5Eval.perEvent.map(e => ({
        eventSlug: e.eventSlug,
        spearman: e.spearman,
        topRatedCoverage: e.topRatedCoverage,
        bestValueCoverage: e.bestValueCoverage,
        meanActualInTopLineups: e.meanActualInTopLineups,
      })),
    },
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n💾 Saved to ${OUTPUT_FILE}`);
  console.log("\n✨ Done.");
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
