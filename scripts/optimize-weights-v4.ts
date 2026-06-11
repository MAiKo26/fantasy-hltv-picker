import * as fs from "node:fs";
import * as path from "node:path";
import * as cheerio from "cheerio";
import { HtmlExtractorService } from "../src/services/extractor.ts";
import { StatsScraperService } from "../src/services/statsScraper.ts";
import {
  mathOptimizer,
  type OptimizerWeightOverrides,
} from "../src/services/mathOptimizer.ts";
import { normalizePlayerName, normalizeTeamName } from "../src/utils/normalize.ts";
import type { FantasyConfig, FantasyPlayer, FantasyTeam } from "../src/types/player.ts";

const RESULTS_DIR = path.join(process.cwd(), "results");
const DRAFT_DIR = path.join(process.cwd(), "source", "draft");
const WEIGHT_STEP = 0.025;
const MAX_ITERATIONS = 15;
const EARLY_STOP_PATIENCE = 4;
const TOP_LINEUPS_COUNT = 30;
const BEST_VALUE_COUNT = 8;

interface GroundTruth {
  eventSlug: string;
  bestValue: string[];
  bestValueRaw: { name: string; pricePerPoint: string }[];
}

interface EventInput {
  eventSlug: string;
  players: FantasyPlayer[];
  teams: FantasyTeam[];
}

interface WeightConfig {
  cardRatingBenefit: number;
  historicalTop20RatingBenefit: number;
  topTeamRankBenefit: number;
  awperRoleBenefit: number;
  lowDeathRateBenefit: number;
  ctVsTRatingImbalancePenalty: number;
  stackCorrelationBenefit: number;
  topRankedTeamStackBenefit: number;
}

interface PlayerTraits {
  teamRankNormalized: number;
  isAwp: number;
  survival: number;
  sideVariance: number;
  historical12m: number;
  baseRating: number;
}

interface EventAnalysis {
  eventSlug: string;
  iteration: number;
  totalAppearances: number;
  maxPossible: number;
  concentrationPct: number;
  bestValuePlayersInLineups: string[];
  bestValuePlayersMissing: string[];
  playerFrequency: Record<string, number>;
}

interface OptimizationResult {
  baselineWeights: WeightConfig;
  finalWeights: WeightConfig;
  weightDeltas: Record<string, number>;
  baselineScore: number;
  finalScore: number;
  maxPossibleScore: number;
  iterations: number;
  eventAnalyses: EventAnalysis[];
  generatedAt: string;
}

function parseResultsFile(filePath: string): GroundTruth | null {
  const html = fs.readFileSync(filePath, "utf-8");
  const $ = cheerio.load(html);

  if ($(".most-value-for-money-players").length === 0) {
    return null;
  }

  const eventSlug = path.basename(filePath, ".html");
  const bestValue: string[] = [];
  const bestValueRaw: { name: string; pricePerPoint: string }[] = [];

  $(".most-value-for-money-players .pickedPlayers .player-with-count").each((_, el) => {
    const name = $(el).find(".card-player-tag").first().text().trim();
    const pricePerPoint = $(el).find(".price-per-point").text().trim();
    if (name) {
      bestValue.push(normalizePlayerName(name));
      bestValueRaw.push({ name, pricePerPoint });
    }
  });

  return { eventSlug, bestValue, bestValueRaw };
}

async function loadEventInput(eventSlug: string, sourceFile: string): Promise<EventInput> {
  const extractor = new HtmlExtractorService();
  const scraper = new StatsScraperService();

  const result = await extractor.extract(sourceFile);
  const enrichedPlayers = await scraper.enrichPlayersWithHistoricalStats(result.players);

  return {
    eventSlug,
    players: enrichedPlayers,
    teams: result.teams,
  };
}

function generateLineups(
  input: EventInput,
  weights: WeightConfig
): string[][] {
  const config: FantasyConfig = { strategy: "2-2-1" };

  const lineups = mathOptimizer.optimize(
    input.players,
    input.teams,
    config,
    weights,
  );

  return lineups.map(l => l.players.map(p => normalizePlayerName(p.name)));
}

function calculateBestValueAppearances(
  lineups: string[][],
  bestValuePlayers: string[],
  maxLineups: number = TOP_LINEUPS_COUNT
): { totalAppearances: number; maxPossible: number; concentrationPct: number; playerFrequency: Record<string, number> } {
  const targetSet = new Set(bestValuePlayers);
  let totalAppearances = 0;
  const consideredLineups = lineups.slice(0, maxLineups);
  const playerFrequency: Record<string, number> = {};

  for (const player of bestValuePlayers) {
    playerFrequency[player] = 0;
  }

  for (const lineup of consideredLineups) {
    let lineupBestValueCount = 0;
    for (const player of lineup) {
      if (targetSet.has(player)) {
        totalAppearances++;
        lineupBestValueCount++;
        playerFrequency[player]!++;
      }
    }
  }

  const maxPossible = bestValuePlayers.length * maxLineups;
  const concentrationPct = (totalAppearances / maxPossible) * 100;

  return { totalAppearances, maxPossible, concentrationPct, playerFrequency };
}

function getPlayerTraits(
  player: FantasyPlayer,
  teams: FantasyTeam[]
): PlayerTraits {
  const team = teams.find(t => normalizeTeamName(t.name) === normalizeTeamName(player.team));
  const worldRank = team?.worldRank ?? 50;

  return {
    teamRankNormalized: 1 / (1 + worldRank),
    isAwp: player.stats.awpPerRound >= 0.25 ? 1 : 0,
    survival: player.stats.deathsPerRound <= 0.6 ? 1 : 0,
    sideVariance: Math.abs(player.stats.ctRating - player.stats.tRating),
    historical12m: player.stats.rating12mTop20 ?? 0,
    baseRating: player.stats.rating,
  };
}

function analyzeMissingAndLowFrequencyPlayers(
  input: EventInput,
  lineups: string[][],
  groundTruth: GroundTruth,
  playerFrequency: Record<string, number>
): { traitAverages: Record<string, number>; problemPlayers: string[] } {
  const playerMap = new Map<string, FantasyPlayer>();
  for (const player of input.players) {
    playerMap.set(normalizePlayerName(player.name), player);
  }

  const consideredLineups = lineups.slice(0, TOP_LINEUPS_COUNT);
  const lineupPlayers = new Set<string>(consideredLineups.flat());

  const missingPlayers = groundTruth.bestValue.filter(p => !lineupPlayers.has(p));

  const maxPossible = consideredLineups.length;
  const lowFreqThreshold = maxPossible * 0.2;
  const lowFreqPlayers = groundTruth.bestValue.filter(
    p => !missingPlayers.includes(p) && (playerFrequency[p] ?? 0) < lowFreqThreshold
  );

  const problemPlayers = [...missingPlayers, ...lowFreqPlayers];

  const traitSums: Record<string, number> = {
    teamRankNormalized: 0,
    isAwp: 0,
    survival: 0,
    sideVariance: 0,
    historical12m: 0,
    baseRating: 0,
  };

  let count = 0;
  for (const playerName of problemPlayers) {
    const player = playerMap.get(playerName);
    if (!player) continue;

    const traits = getPlayerTraits(player, input.teams);
    for (const [key, value] of Object.entries(traits)) {
      traitSums[key]! += value;
    }
    count++;
  }

  const traitAverages: Record<string, number> = {};
  for (const [key, sum] of Object.entries(traitSums)) {
    traitAverages[key] = count > 0 ? sum / count : 0;
  }

  return { traitAverages, problemPlayers };
}

function calculateWeightAdjustments(
  problemTraitAverages: Record<string, number>,
  currentWeights: WeightConfig
): Partial<WeightConfig> {
  const adjustments: Partial<WeightConfig> = {};

  const traitToWeight: Record<string, keyof WeightConfig> = {
    teamRankNormalized: "topTeamRankBenefit",
    isAwp: "awperRoleBenefit",
    survival: "lowDeathRateBenefit",
    sideVariance: "ctVsTRatingImbalancePenalty",
    historical12m: "historicalTop20RatingBenefit",
    baseRating: "cardRatingBenefit",
  };

  for (const [trait, weightName] of Object.entries(traitToWeight)) {
    const traitValue = problemTraitAverages[trait] ?? 0;
    const current = currentWeights[weightName];

    let adjustment = 0;

    if (traitValue > 0.6) {
      adjustment = WEIGHT_STEP * 2;
    } else if (traitValue > 0.4) {
      adjustment = WEIGHT_STEP;
    } else if (traitValue < 0.15) {
      adjustment = -WEIGHT_STEP * 2;
    } else if (traitValue < 0.3) {
      adjustment = -WEIGHT_STEP;
    }

    adjustments[weightName] = Math.round(adjustment * 1000) / 1000;
  }

  return adjustments;
}

async function main() {
  console.log("🚀 Starting Advanced HLTV Fantasy Weight Optimization...\n");
  console.log(`🎯 Goal: Maximize ${BEST_VALUE_COUNT} Best Value players appearing in Top ${TOP_LINEUPS_COUNT} lineups`);
  console.log(`📊 Max possible appearances per event: ${BEST_VALUE_COUNT} × ${TOP_LINEUPS_COUNT} = ${BEST_VALUE_COUNT * TOP_LINEUPS_COUNT}\n`);

  const BASELINE_WEIGHTS: WeightConfig = {
    cardRatingBenefit: 0.25,
    historicalTop20RatingBenefit: 3,
    topTeamRankBenefit: 0.3,
    awperRoleBenefit: 0,
    lowDeathRateBenefit: 0,
    ctVsTRatingImbalancePenalty: 0.5,
    stackCorrelationBenefit: 0.05,
    topRankedTeamStackBenefit: 0.15,
  };

  const resultsFiles = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith(".html"));
  const dataset: { input: EventInput; truth: GroundTruth }[] = [];

  for (const file of resultsFiles) {
    const resultsPath = path.join(RESULTS_DIR, file);
    const truth = parseResultsFile(resultsPath);

    if (!truth) continue;

    const draftPath = path.join(DRAFT_DIR, file);
    if (!fs.existsSync(draftPath)) {
      console.warn(`⚠️ Draft file not found: ${file}`);
      continue;
    }

    console.log(`📂 Loading: ${truth.eventSlug} (${truth.bestValue.length} best value players)...`);
    try {
      const input = await loadEventInput(truth.eventSlug, file);
      dataset.push({ input, truth });
    } catch (err) {
      console.error(`❌ Failed to load ${truth.eventSlug}:`, err);
    }
  }

  if (dataset.length === 0) {
    console.error("❌ No valid events loaded.");
    process.exit(1);
  }

  console.log(`\n✅ Loaded ${dataset.length} events!\n`);

  const trainSize = Math.floor(dataset.length * 0.75);
  const trainSet = dataset.slice(0, trainSize);
  const testSet = dataset.slice(trainSize);

  console.log(`📊 Train Set: ${trainSet.length} events | Test Set: ${testSet.length} events\n`);

  let currentWeights: WeightConfig = { ...BASELINE_WEIGHTS };
  let bestWeights: WeightConfig = { ...currentWeights };
  let bestTestScore = 0;
  let noImprovementCount = 0;
  const eventAnalyses: EventAnalysis[] = [];

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`🔄 === Iteration ${iteration} ===\n`);

    const totalAdjustments: Record<keyof WeightConfig, number[]> = {
      cardRatingBenefit: [],
      historicalTop20RatingBenefit: [],
      topTeamRankBenefit: [],
      awperRoleBenefit: [],
      lowDeathRateBenefit: [],
      ctVsTRatingImbalancePenalty: [],
      stackCorrelationBenefit: [],
      topRankedTeamStackBenefit: [],
    };

    let trainScore = 0;

    for (const item of trainSet) {
      console.log(`🔍 Training: ${item.truth.eventSlug}`);

      const lineups = generateLineups(item.input, currentWeights);
      const { totalAppearances, maxPossible, concentrationPct, playerFrequency } = calculateBestValueAppearances(lineups, item.truth.bestValue);

      console.log(`   📊 Appearances: ${totalAppearances}/${maxPossible} (${concentrationPct.toFixed(1)}%)`);

      const { traitAverages, problemPlayers } = analyzeMissingAndLowFrequencyPlayers(item.input, lineups, item.truth, playerFrequency);

      const adjustments = calculateWeightAdjustments(traitAverages, currentWeights);

      for (const [key, adjustment] of Object.entries(adjustments) as [keyof WeightConfig, number][]) {
        if (adjustment !== 0) totalAdjustments[key].push(adjustment);
      }

      const lineupPlayers = new Set(lineups.slice(0, TOP_LINEUPS_COUNT).flat());
      eventAnalyses.push({
        eventSlug: item.truth.eventSlug,
        iteration,
        totalAppearances,
        maxPossible,
        concentrationPct,
        bestValuePlayersInLineups: item.truth.bestValue.filter(p => lineupPlayers.has(p)),
        bestValuePlayersMissing: problemPlayers,
        playerFrequency,
      });

      trainScore += totalAppearances;
      console.log(`   ✅ Done\n`);
    }

    let testScore = 0;
    for (const item of testSet) {
      const lineups = generateLineups(item.input, currentWeights);
      const { totalAppearances } = calculateBestValueAppearances(lineups, item.truth.bestValue);
      testScore += totalAppearances;
    }

    console.log(`📊 Train Score: ${trainScore} | Test Score: ${testScore}`);

    if (testScore > bestTestScore) {
      bestTestScore = testScore;
      bestWeights = { ...currentWeights };
      noImprovementCount = 0;
      console.log(`🎉 New best test score: ${bestTestScore}\n`);
    } else {
      noImprovementCount++;
      console.log(`⏸️ No improvement (${noImprovementCount}/${EARLY_STOP_PATIENCE})\n`);
    }

    if (noImprovementCount >= EARLY_STOP_PATIENCE) {
      console.log("🛑 Early stopping: No improvement for 4 iterations.");
      break;
    }

    let anyAdjustment = false;
    for (const key of Object.keys(currentWeights) as (keyof WeightConfig)[]) {
      const adjustments = totalAdjustments[key];
      if (adjustments.length > 0) {
        const avgAdjustment = adjustments.reduce((a, b) => a + b, 0) / adjustments.length;
        const roundedAdjustment = Math.round(avgAdjustment * 1000) / 1000;
        const newValue = Math.max(0, Math.min(1, currentWeights[key] + roundedAdjustment));
        currentWeights[key] = newValue;
        anyAdjustment = true;
      }
    }

    if (!anyAdjustment) {
      console.log("\n🛑 No further adjustments needed. Converged.");
      break;
    }

    console.log(`🔄 Weights updated for next iteration...\n`);
  }

  console.log("⚖️ FINAL WEIGHT COMPARISON:");
  console.log("┌──────────────────────────────┬────────────┬────────────┬─────────────┐");
  console.log("│ Weight Variable              │ Baseline   │ Optimized  │ Delta       │");
  console.log("├──────────────────────────────┼────────────┼────────────┼─────────────┤");

  const weightDeltas: Record<string, number> = {};
  for (const key of Object.keys(BASELINE_WEIGHTS) as (keyof WeightConfig)[]) {
    const base = BASELINE_WEIGHTS[key];
    const opt = bestWeights[key];
    const delta = Math.round((opt - base) * 1000) / 1000;
    weightDeltas[key] = delta;
    const deltaStr = delta === 0 ? " 0.000" : (delta > 0 ? `+${delta.toFixed(3)}` : delta.toFixed(3));
    console.log(`│ ${key.padEnd(28)} │ ${base.toFixed(3).padStart(10)} │ ${opt.toFixed(3).padStart(10)} │ ${deltaStr.padStart(11)} │`);
  }
  console.log("└──────────────────────────────┴────────────┴────────────┴─────────────┘");

  let totalBaselineScore = 0;
  let totalFinalScore = 0;
  let totalMaxPossible = 0;

  for (const item of dataset) {
    const baselineLineups = generateLineups(item.input, BASELINE_WEIGHTS);
    const finalLineups = generateLineups(item.input, bestWeights);

    const baselineResult = calculateBestValueAppearances(baselineLineups, item.truth.bestValue);
    const finalResult = calculateBestValueAppearances(finalLineups, item.truth.bestValue);

    totalBaselineScore += baselineResult.totalAppearances;
    totalFinalScore += finalResult.totalAppearances;
    totalMaxPossible += baselineResult.maxPossible;
  }

  console.log(`\n📊 FINAL SCORES:`);
  console.log(`   Baseline:   ${totalBaselineScore}/${totalMaxPossible} (${((totalBaselineScore / totalMaxPossible) * 100).toFixed(1)}%)`);
  console.log(`   Optimized:  ${totalFinalScore}/${totalMaxPossible} (${((totalFinalScore / totalMaxPossible) * 100).toFixed(1)}%)`);
  console.log(`   Improvement: +${totalFinalScore - totalBaselineScore} appearances`);

  const result: OptimizationResult = {
    baselineWeights: BASELINE_WEIGHTS,
    finalWeights: bestWeights,
    weightDeltas,
    baselineScore: totalBaselineScore,
    finalScore: totalFinalScore,
    maxPossibleScore: totalMaxPossible,
    iterations: MAX_ITERATIONS,
    eventAnalyses,
    generatedAt: new Date().toISOString(),
  };

  const outputPath = path.join(process.cwd(), "optimization-results.json");
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`\n💾 Results saved to: ${outputPath}`);
  console.log("\n✨ Optimization Complete!");
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
