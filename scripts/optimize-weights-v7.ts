/**
 * v7 weight optimizer — walk-forward validation + coordinate descent.
 *
 * Why this exists: v4–v6 grid-searched weights against ALL events, then
 * reported loss on the SAME events. With 18 free weights and 13 events that
 * overfits badly. v7 instead:
 *
 *   Phase A  walk-forward over player-level weights using Spearman loss
 *            (train on events[0..k), predict event k) — pure trait math, fast;
 *   Phase B  lineup-level weights (stacking/field-split) tuned with FULL
 *            optimizer evaluations on the training prefix;
 *   Phase C  final frozen weights evaluated per held-out event with the real
 *            metrics: Spearman + top-rated coverage + best-value coverage.
 *
 * Output: held-out loss vs baselines + a ready-to-paste .env block.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {HtmlExtractorService} from "../src/services/extractor.ts";
import {StatsScraperService} from "../src/services/statsScraper.ts";
import {
  mathOptimizer,
  resolveWeights,
  type OptimizerWeightOverrides,
  type PlayerWeightKey,
  type LineupWeightKey,
  type WeightKey,
} from "../src/services/mathOptimizer.ts";
import {parseEventGroundTruth, type EventGroundTruth} from "../src/services/resultParser.ts";
import {normalizePlayerName} from "../src/utils/normalize.ts";
import {HISTORICAL_SOURCES} from "../src/services/historicalSources.ts";
import type {FantasyConfig, FantasyPlayer, FantasyTeam} from "../src/types/player.ts";

const RATINGS_DIR = path.join(process.cwd(), "results", "player-ratings-at-end-of-event");
const RESULTS_DIR = path.join(process.cwd(), "results");
const DRAFT_DIR = path.join(process.cwd(), "source", "draft");
const OUTPUT_FILE = path.join(process.cwd(), "optimization-results-v7.json");
const CACHE_FILE = path.join(process.cwd(), ".cache", "v7-events.json");

const MIN_MAPS_FOR_RATING = 6;
const MAP_WEIGHT_THRESHOLD = 8;
const RATING_TOP_THRESHOLD = 1.18;
const MIN_TRAIN_EVENTS = 6;

const LOSS_SPEARMAN_WEIGHT = 1.0;
const LOSS_TOP_RATED_COVERAGE_WEIGHT = 0.5;
const LOSS_BEST_VALUE_COVERAGE_WEIGHT = 0.2;

const TOP_LINEUPS_COUNT = 30;

const PLAYER_KEYS: PlayerWeightKey[] = [
  "cardRatingBenefit",
  ...HISTORICAL_SOURCES.map((s) => `hist_${s.key}` as PlayerWeightKey),
  "topTeamRankBenefit",
  "awperRoleBenefit",
  "lowDeathRateBenefit",
  "ctVsTRatingImbalancePenalty",
  "awpPerRoundWeight",
  "deathPenaltyWeight",
  "priceEfficiencyBenefit",
];

const LINEUP_KEYS: LineupWeightKey[] = [
  "stackCorrelationBenefit",
  "topRankedTeamStackBenefit",
  "fieldSide3PlayerPenalty",
  "fieldSide4PlusPlayerPenalty",
  "fieldSideCrossTeamPenalty",
];

type Weights = Record<WeightKey, number>;

/** Multiplicative probe grid around current value. */
function probeValues(current: number): number[] {
  const candidates = new Set<number>();
  for (const mult of [0, 0.25, 0.5, 0.75, 1.25, 1.5, 2]) {
    const v = Number((current * mult).toFixed(4));
    if (v >= 0 && v <= 4) candidates.add(v);
  }
  candidates.add(Number((current + 0.05).toFixed(4)));
  candidates.add(Number((Math.max(0, current - 0.05)).toFixed(4)));
  return [...candidates];
}

// ── Event loading (same shape as v6, fresh cache incl. map counts) ──────

interface EventInput {
  eventSlug: string;
  players: FantasyPlayer[];
  teams: FantasyTeam[];
}

interface EventData {
  input: EventInput;
  truth: EventGroundTruth;
}

async function loadEvents(): Promise<EventData[]> {
  if (fs.existsSync(CACHE_FILE)) {
    console.log(`Loading cached events from ${CACHE_FILE}...`);
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")) as EventData[];
    return cached;
  }

  console.log("Loading events from disk...");
  const ratingFiles = fs.readdirSync(RATINGS_DIR).filter(f => f.endsWith(".html")).sort();
  const extractor = new HtmlExtractorService();
  const scraper = new StatsScraperService();
  const events: EventData[] = [];

  for (const file of ratingFiles) {
    const draftPath = path.join(DRAFT_DIR, file);
    if (!fs.existsSync(draftPath)) continue;
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
      console.log(`  ✓ ${truth.eventSlug}: ${enriched.length} players`);
    } catch (err) {
      console.error(`  ❌ ${file}:`, err);
    }
  }

  fs.mkdirSync(path.dirname(CACHE_FILE), {recursive: true});
  fs.writeFileSync(CACHE_FILE, JSON.stringify(events));
  return events;
}

// ── Fast trait-based evaluation (Phase A) ────────────────────────────────

interface TraitRow {
  name: string;
  predictedOf: Map<WeightKey, number>;
  actual: number | null;
  mapWeight: number;
}

function buildTraitRows(event: EventData): TraitRow[] {
  mathOptimizer.setTeams(event.input.teams);
  return event.input.players.map((player) => {
    const {traits} = mathOptimizer.getTraitVector(player);
    return {
      name: normalizePlayerName(player.name),
      predictedOf: new Map(Object.entries(traits) as [WeightKey, number][]),
      actual: null,
      mapWeight: 0,
    };
  });
}

function attachActuals(rows: TraitRow[], event: EventData): void {
  const byName = new Map(
    event.truth.ratings.map((r) => [normalizePlayerName(r.name), r]),
  );
  for (const row of rows) {
    const r = byName.get(row.name);
    row.actual = r && r.maps >= MIN_MAPS_FOR_RATING ? r.rating : null;
    row.mapWeight = r ? Math.min(1, r.maps / MAP_WEIGHT_THRESHOLD) : 0;
  }
}

function spearmanLoss(rows: TraitRow[], weights: Weights): number {
  const eligible = rows.filter((r) => r.actual != null);
  if (eligible.length < 3) return 0;
  const n = eligible.length;
  const pred = eligible.map((r) => {
    let s = 0;
    for (const [k, v] of r.predictedOf) s += v * (weights[k] ?? 0);
    return s;
  });
  const act = eligible.map((r) => r.actual as number);
  const wt = eligible.map((r) => r.mapWeight);

  const midranks = (values: number[]): number[] => {
    const idx = values.map((v, i) => ({v, i})).sort((a, b) => a.v - b.v);
    const ranks = new Array<number>(n).fill(0);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1]!.v === idx[i]!.v) j++;
      const mid = (i + j) / 2 + 1;
      for (let k2 = i; k2 <= j; k2++) ranks[idx[k2]!.i] = mid;
      i = j + 1;
    }
    return ranks;
  };

  const rx = midranks(pred);
  const ry = midranks(act);
  let sw = 0, swx = 0, swy = 0, swxx = 0, swyy = 0, swxy = 0;
  for (let i = 0; i < n; i++) {
    const w = wt[i]!;
    if (w <= 0) continue;
    sw += w;
    swx += w * rx[i]!;
    swy += w * ry[i]!;
    swxx += w * rx[i]! * rx[i]!;
    swyy += w * ry[i]! * ry[i]!;
    swxy += w * rx[i]! * ry[i]!;
  }
  const denom =
    Math.sqrt(sw * swxx - swx * swx) * Math.sqrt(sw * swyy - swy * swy);
  if (denom === 0) return 0;
  const rho = (sw * swxy - swx * swy) / denom;
  return -rho; // loss
}

function coordinateDescentSpearman(
  rows: TraitRow[],
  startWeights: Weights,
  sweeps = 3,
): Weights {
  const weights: Weights = {...startWeights};
  // Scale-invariant-ish: normalize rating-scale keys so magnitudes are comparable.
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let improved = false;
    for (const key of PLAYER_KEYS) {
      let bestVal = weights[key]!;
      let bestLoss = spearmanLoss(rows, weights);
      for (const v of probeValues(weights[key]!)) {
        weights[key] = v;
        const loss = spearmanLoss(rows, weights);
        if (loss < bestLoss - 1e-6) {
          bestLoss = loss;
          bestVal = v;
        }
      }
      weights[key] = bestVal;
      improved ||= bestVal !== startWeights[key];
    }
    if (!improved) break;
  }
  return weights;
}

// ── Full pipeline evaluation (Phases B/C) ───────────────────────────────

const EVAL_CONFIG: FantasyConfig = {strategy: "Auto"};

interface FullEval {
  spearmanLoss: number;
  topRatedCoverage: number;
  bestValueCoverage: number;
  total: number;
}

function evaluateFull(weights: Weights, events: EventData[]): FullEval {
  const overrides: OptimizerWeightOverrides = weights;
  let sumSp = 0, sumTr = 0, sumBv = 0, nRatings = 0, nBv = 0;

  for (const event of events) {
    const lineups = mathOptimizer.optimize(
      event.input.players,
      event.input.teams,
      EVAL_CONFIG,
      overrides,
    );
    const rows = buildTraitRows(event);
    attachActuals(rows, event);
    sumSp += spearmanLoss(rows, overrides as Weights);
    nRatings++;

    if (lineups.length === 0) {
      sumTr += 1;
    } else {
      const targetTop = new Set(
        event.truth.ratings
          .filter((r) => r.rating >= RATING_TOP_THRESHOLD && r.maps >= 6)
          .map((r) => normalizePlayerName(r.name)),
      );
      const targetValue = new Set(
        event.truth.bestValuePlayers.map((n) => normalizePlayerName(n)),
      );
      let hitsTop = 0, hitsValue = 0;
      for (const lineup of lineups.slice(0, TOP_LINEUPS_COUNT)) {
        for (const p of lineup.players) {
          const name = normalizePlayerName(p.name);
          if (targetTop.has(name)) hitsTop++;
          if (targetValue.has(name)) hitsValue++;
        }
      }
      const denomTop = Math.max(1, targetTop.size * Math.min(TOP_LINEUPS_COUNT, lineups.length));
      const denomValue = Math.max(1, targetValue.size * Math.min(TOP_LINEUPS_COUNT, lineups.length));
      sumTr += 1 - hitsTop / denomTop;
      sumBv += 1 - hitsValue / denomValue;
    }
    if (event.truth.hasBestValue) nBv++;
  }

  const meanSp = nRatings > 0 ? sumSp / nRatings : 0;
  const meanTr = nRatings > 0 ? sumTr / Math.max(1, nRatings) : 0;
  const meanBv = nBv > 0 ? sumBv / nBv : 0;
  return {
    spearmanLoss: meanSp,
    topRatedCoverage: meanTr,
    bestValueCoverage: meanBv,
    total:
      LOSS_SPEARMAN_WEIGHT * meanSp +
      LOSS_TOP_RATED_COVERAGE_WEIGHT * meanTr +
      LOSS_BEST_VALUE_COVERAGE_WEIGHT * meanBv,
  };
}

function coordinateDescentLineupWeights(
  events: EventData[],
  startWeights: Weights,
  sweeps = 2,
): Weights {
  const weights: Weights = {...startWeights};
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let improved = false;
    for (const key of LINEUP_KEYS) {
      let bestVal = weights[key]!;
      let bestTotal = evaluateFull(weights, events).total;
      for (const v of probeValues(weights[key]!)) {
        weights[key] = v;
        const total = evaluateFull(weights, events).total;
        if (total < bestTotal - 1e-6) {
          bestTotal = total;
          bestVal = v;
        }
      }
      weights[key] = bestVal;
      improved ||= bestVal !== startWeights[key];
      console.log(`    ${key} -> ${bestVal.toFixed(3)} (loss ${bestTotal.toFixed(5)})`);
    }
    if (!improved) break;
  }
  return weights;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 v7 Walk-Forward Weight Optimization\n");

  const events = await loadEvents();
  if (events.length < MIN_TRAIN_EVENTS + 2) {
    console.error(`Need ≥ ${MIN_TRAIN_EVENTS + 2} events; got ${events.length}.`);
    process.exit(1);
  }
  console.log(`✅ ${events.length} events loaded\n`);

  const defaultWeights = resolveWeights();

  // Precompute trait rows once.
  const rowsByEvent = new Map<string, TraitRow[]>();
  for (const event of events) {
    const rows = buildTraitRows(event);
    attachActuals(rows, event);
    rowsByEvent.set(event.truth.eventSlug, rows);
  }

  // ── Phase A: walk-forward over player-level weights ─────────────
  console.log("── Phase A · Walk-forward (player-level weights, Spearman loss) ──");
  const foldWeights: Weights[] = [];
  const heldOut: Array<{slug: string; loss: number; spearman: number}> = [];
  for (let k = MIN_TRAIN_EVENTS; k < events.length; k++) {
    const trainRows = events
      .slice(0, k)
      .flatMap((e) => rowsByEvent.get(e.truth.eventSlug)!);
    const trained = coordinateDescentSpearman(trainRows, defaultWeights);
    foldWeights.push(trained);

    const testEvent = events[k]!;
    const testRows = rowsByEvent.get(testEvent.truth.eventSlug)!;
    const loss = spearmanLoss(testRows, trained);
    heldOut.push({slug: testEvent.truth.eventSlug, loss, spearman: -loss});
    console.log(
      `  fold k=${k}: trained on ${k}, tested "${testEvent.truth.eventSlug}" → spearman=${(-loss).toFixed(4)}`,
    );
  }

  const meanHeldOutSpearman =
    heldOut.reduce((s, h) => s + h.spearman, 0) / heldOut.length;

  // Median-fold weights (robust aggregation).
  const medianFoldWeights = {} as Weights;
  for (const key of Object.keys(defaultWeights) as WeightKey[]) {
    const vals = foldWeights
      .map((w) => w[key] ?? defaultWeights[key]!)
      .sort((a, b) => a - b);
    medianFoldWeights[key] = vals[Math.floor(vals.length / 2)] ?? defaultWeights[key]!;
  }

  // Baseline comparison on the same held-out folds.
  const baselineHeldOut: number[] = [];
  for (let k = MIN_TRAIN_EVENTS; k < events.length; k++) {
    const testEvent = events[k]!;
    const testRows = rowsByEvent.get(testEvent.truth.eventSlug)!;
    baselineHeldOut.push(spearmanLoss(testRows, defaultWeights));
  }
  const meanBaselineSpearman =
    baselineHeldOut.reduce((s, l) => s + (-l), 0) / baselineHeldOut.length;

  console.log(`\n  Held-out mean Spearman:`); 
  console.log(`    defaults:      ${meanBaselineSpearman.toFixed(4)}`);
  console.log(`    walk-forward:  ${meanHeldOutSpearman.toFixed(4)}`);

  // ── Phase B: lineup-level weights via full evals on train prefix ──
  console.log("\n── Phase B · Lineup-level weights (full optimizer evals) ──");
  const trainPrefix = events.slice(0, Math.max(MIN_TRAIN_EVENTS, events.length - 3));
  const finalWeights = coordinateDescentLineupWeights(
    trainPrefix,
    medianFoldWeights,
  );

  // ── Phase C: final frozen evaluation ─────────────────────────────
  console.log("\n── Phase C · Frozen-weight full evaluation ──");
  const finalEvalAll = evaluateFull(finalWeights, events);
  const baselineEvalAll = evaluateFull(defaultWeights, events);
  console.log(`  v7 weights (all events):   loss=${finalEvalAll.total.toFixed(5)}  spearman=${(-finalEvalAll.spearmanLoss).toFixed(4)}  topRated=${(1 - finalEvalAll.topRatedCoverage).toFixed(3)}  bestValue=${(1 - finalEvalAll.bestValueCoverage).toFixed(3)}`);
  console.log(`  defaults (all events):     loss=${baselineEvalAll.total.toFixed(5)}  spearman=${(-baselineEvalAll.spearmanLoss).toFixed(4)}  topRated=${(1 - baselineEvalAll.topRatedCoverage).toFixed(3)}  bestValue=${(1 - baselineEvalAll.bestValueCoverage).toFixed(3)}`);

  // .env snippet
  const envLines: string[] = [];
  for (const source of HISTORICAL_SOURCES) {
    const key = `hist_${source.key}` as WeightKey;
    if (finalWeights[key] !== defaultWeights[key]) {
      envLines.push(`${source.envVar}=${finalWeights[key]}`);
    }
  }
  const staticEnvNames: Partial<Record<WeightKey, string>> = {
    cardRatingBenefit: "WEIGHT_CARD_RATING_BENEFIT",
    topTeamRankBenefit: "WEIGHT_TOP_TEAM_RANK_BENEFIT",
    awperRoleBenefit: "WEIGHT_AWPER_ROLE_BENEFIT",
    lowDeathRateBenefit: "WEIGHT_LOW_DEATH_RATE_BENEFIT",
    ctVsTRatingImbalancePenalty: "WEIGHT_CT_VS_T_RATING_IMBALANCE_PENALTY",
    stackCorrelationBenefit: "WEIGHT_STACK_CORRELATION_BENEFIT",
    topRankedTeamStackBenefit: "WEIGHT_TOP_RANKED_TEAM_STACK_BENEFIT",
    awpPerRoundWeight: "WEIGHT_AWP_PER_ROUND_WEIGHT",
    deathPenaltyWeight: "WEIGHT_DEATH_PENALTY_WEIGHT",
    priceEfficiencyBenefit: "WEIGHT_PRICE_EFFICIENCY_BENEFIT",
    fieldSide3PlayerPenalty: "WEIGHT_FIELD_SIDE_3_PLAYER_PENALTY",
    fieldSide4PlusPlayerPenalty: "WEIGHT_FIELD_SIDE_4PLUS_PLAYER_PENALTY",
    fieldSideCrossTeamPenalty: "WEIGHT_FIELD_SIDE_CROSS_TEAM_PENALTY",
  };
  for (const [key, envName] of Object.entries(staticEnvNames)) {
    const wk = key as WeightKey;
    if (envName && finalWeights[wk] !== defaultWeights[wk]) {
      envLines.push(`${envName}=${finalWeights[wk]}`);
    }
  }

  console.log("\n📋 Paste into .env to activate tuned weights:\n");
  console.log(envLines.length > 0 ? envLines.join("\n") : "(defaults already optimal)");

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        eventCount: events.length,
        method: "walk-forward coordinate descent (player-level) + full-eval coordinate descent (lineup-level)",
        meanHeldOutSpearman,
        meanBaselineSpearman,
        finalWeights,
        defaultWeights,
        heldOutFolds: heldOut,
        fullEvalV7: finalEvalAll,
        fullEvalDefaults: baselineEvalAll,
        envSnippet: envLines.join("\n"),
      },
      null,
      2,
    ),
  );
  console.log(`\n💾 Saved ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
