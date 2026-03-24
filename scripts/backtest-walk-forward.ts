import * as fs from "node:fs";
import * as path from "node:path";
import {HtmlExtractorService} from "../src/services/extractor.ts";
import {StatsScraperService} from "../src/services/statsScraper.ts";
import {
  mathOptimizer,
  type OptimizerWeightOverrides,
} from "../src/services/mathOptimizer.ts";
import {loadEventBundleForSource} from "../src/services/eventBundleLoader.ts";
import type {FantasyConfig, FantasyPlayer, FantasyTeam} from "../src/types/player.ts";
import {normalizePlayerName} from "../src/utils/normalize.ts";

const DATASET_PATH = path.join(
  process.cwd(),
  "fixtures",
  "backtest",
  "events.json",
);
const REPORT_PATH = path.join(
  process.cwd(),
  "fixtures",
  "backtest",
  "walk-forward-report.json",
);

interface BacktestEvent {
  eventSlug: string;
  sourceFile: string;
  actualBestLineup?: string[];
  actualTopPlayers?: string[];
}

interface EventInput {
  players: FantasyPlayer[];
  teams: FantasyTeam[];
  bundle: Awaited<ReturnType<typeof loadEventBundleForSource>>["bundle"];
}

interface WeightProfile {
  name: string;
  overrides: OptimizerWeightOverrides;
}

const config: FantasyConfig = {
  strategy: "Auto",
  minG2Players: "Auto",
  disableLLMEvaluation: true,
};

const profiles: WeightProfile[] = [
  {name: "baseline", overrides: {}},
  {
    name: "rating_hard",
    overrides: {
      roleExpected: 0.06,
      teamOutcome: 0.03,
      stackCorrelation: 0.01,
      matchupRiskPenalty: 0.6,
      chalkWeakPenalty: 0.2,
    },
  },
  {
    name: "leverage_soft",
    overrides: {
      playerLeverage: 0.16,
      lineupLeverage: 0.19,
      ownershipBand: 0.12,
      teamOutcome: 0.035,
    },
  },
  {
    name: "aggressive_anti_chalk",
    overrides: {
      playerLeverage: 0.24,
      lineupLeverage: 0.28,
      chalkWeakPenalty: 0.24,
      matchupRiskPenalty: 0.62,
    },
  },
];

function normalizeNameArray(names: string[] = []): string[] {
  return names.map((name) => normalizePlayerName(name)).filter((name) => name.length > 0);
}

function overlapScore(predicted: string[], actual: string[]): number {
  if (actual.length === 0) return 0;
  const predictedSet = new Set(normalizeNameArray(predicted));
  const actualSet = new Set(normalizeNameArray(actual));
  let overlap = 0;
  for (const name of actualSet) {
    if (predictedSet.has(name)) overlap++;
  }
  return overlap / actualSet.size;
}

async function loadInputsForEvent(sourceFile: string): Promise<EventInput> {
  const extractor = new HtmlExtractorService();
  const stats = new StatsScraperService();
  const extraction = await extractor.extract(sourceFile);
  const {bundle} = await loadEventBundleForSource(sourceFile);
  const enrichedPlayers = await stats.enrichPlayersWithHistoricalStats(extraction.players);
  return {
    players: enrichedPlayers,
    teams: extraction.teams,
    bundle,
  };
}

function evaluateEventWithProfile(
  event: BacktestEvent,
  input: EventInput,
  profile: WeightProfile,
) {
  // Keep walk-forward runs tractable by pruning to strongest statistical candidates.
  const topByRating = [...input.players]
    .sort((a, b) => b.stats.rating - a.stats.rating)
    .slice(0, 55);

  const perTeamTop = new Map<string, FantasyPlayer[]>();
  for (const player of input.players) {
    const bucket = perTeamTop.get(player.team) ?? [];
    if (bucket.length < 3) {
      bucket.push(player);
      perTeamTop.set(player.team, bucket);
    }
  }

  const candidatePlayersMap = new Map<string, FantasyPlayer>(
    topByRating.map((player) => [player.id, player]),
  );
  for (const bucket of perTeamTop.values()) {
    for (const player of bucket) {
      candidatePlayersMap.set(player.id, player);
    }
  }
  const candidatePlayers = [...candidatePlayersMap.values()];

  const lineups = mathOptimizer.optimize(
    candidatePlayers,
    input.teams,
    config,
    input.bundle,
    profile.overrides,
  );
  if (lineups.length === 0) {
    return {
      eventSlug: event.eventSlug,
      profile: profile.name,
      metric: 0,
      predictedTopLineup: [] as string[],
      predictedTopPlayers: [] as string[],
    };
  }

  const predictedTopLineup = lineups[0]!.players.map((player) => player.name);
  const predictedTopPlayers = input.players
    .map((player) => ({
      name: player.name,
      score: mathOptimizer.getExpectedBaseScore(player),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((entry) => entry.name);

  const lineupMetric = overlapScore(predictedTopLineup, event.actualBestLineup ?? []);
  const topPlayersMetric = overlapScore(predictedTopPlayers, event.actualTopPlayers ?? []);
  const metric = lineupMetric * 0.7 + topPlayersMetric * 0.3;

  return {
    eventSlug: event.eventSlug,
    profile: profile.name,
    metric,
    lineupMetric,
    topPlayersMetric,
    predictedTopLineup,
    predictedTopPlayers,
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

async function main() {
  const quickMode = process.argv.includes("--quick");

  if (!fs.existsSync(DATASET_PATH)) {
    console.error(
      `Backtest dataset missing at ${DATASET_PATH}. Copy fixtures/backtest/events.sample.json to events.json and fill actual outcomes.`,
    );
    process.exit(1);
  }

  const events = JSON.parse(fs.readFileSync(DATASET_PATH, "utf-8")) as BacktestEvent[];
  if (events.length === 0) {
    console.error("Backtest dataset has no events.");
    process.exit(1);
  }

  const activeEvents = quickMode ? events.slice(0, 1) : events;
  const activeProfiles = quickMode ? profiles.slice(0, 1) : profiles;

  const inputCache = new Map<string, EventInput>();
  for (const event of activeEvents) {
    inputCache.set(event.sourceFile, await loadInputsForEvent(event.sourceFile));
  }

  const walkForward: Array<{
    eventSlug: string;
    selectedProfile: string;
    trainScore: number;
    evalMetric: number;
    lineupMetric: number;
    topPlayersMetric: number;
    predictedTopLineup: string[];
  }> = [];

  for (let i = 0; i < activeEvents.length; i++) {
    const event = activeEvents[i]!;
    const trainEvents = activeEvents.slice(0, i);

    let selected = activeProfiles[0]!;
    let bestTrainScore = Number.NEGATIVE_INFINITY;

    for (const profile of activeProfiles) {
      const trainMetrics = trainEvents.map((trainEvent) => {
        const input = inputCache.get(trainEvent.sourceFile)!;
        return evaluateEventWithProfile(trainEvent, input, profile).metric;
      });
      const trainScore = average(trainMetrics);
      if (trainScore > bestTrainScore) {
        bestTrainScore = trainScore;
        selected = profile;
      }
    }

    const evalInput = inputCache.get(event.sourceFile)!;
    const evaluation = evaluateEventWithProfile(event, evalInput, selected);

    walkForward.push({
      eventSlug: event.eventSlug,
      selectedProfile: selected.name,
      trainScore: bestTrainScore === Number.NEGATIVE_INFINITY ? 0 : bestTrainScore,
      evalMetric: evaluation.metric,
      lineupMetric: evaluation.lineupMetric ?? 0,
      topPlayersMetric: evaluation.topPlayersMetric ?? 0,
      predictedTopLineup: evaluation.predictedTopLineup,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    quickMode,
    events: walkForward,
    averageEvalMetric: average(walkForward.map((entry) => entry.evalMetric)),
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), {recursive: true});
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf-8");
  console.log(`Walk-forward report written: ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
