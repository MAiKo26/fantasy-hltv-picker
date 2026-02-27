import type {
  AnalyzerService,
  AnalysisResult,
  FantasyPlayer,
  FantasyTeam,
  FantasyConfig,
} from "../types/player.ts";
import {StatsScraperService} from "./statsScraper.ts";
import {mathOptimizer} from "./mathOptimizer.ts";
import {llmSelector} from "./llmSelector.ts";
import ora from "ora";

export class FantasyAnalyzerService implements AnalyzerService {
  async analyze(
    players: FantasyPlayer[],
    teams: FantasyTeam[],
    config: FantasyConfig,
    sourceUrl: string,
  ): Promise<AnalysisResult> {
    // 1. Scrape and Enrich
    const scraperSpinner = ora(
      "Fetching historical player stats from HLTV (or cache)...",
    ).start();
    const scraper = new StatsScraperService();
    const enrichedPlayers =
      await scraper.enrichPlayersWithHistoricalStats(players);
    scraperSpinner.succeed("Player stats enriched.");

    // 2. Math Optimizer
    const mathSpinner = ora(
      "Generating mathematically optimal lineups...",
    ).start();
    const bestLineups = mathOptimizer.optimize(enrichedPlayers, config);
    mathSpinner.succeed(
      `Generated ${bestLineups.length} valid top lineups mathematically.`,
    );

    if (bestLineups.length === 0) {
      throw new Error(
        "Could not find any mathematically valid lineups for given budget and constraints.",
      );
    }

    // 3. LLM Selection
    const llmSpinner = ora(
      "Asking LLM to pick the absolute best lineup based on context...",
    ).start();
    const llmResult = await llmSelector.selectBestLineup(bestLineups);
    llmSpinner.succeed("LLM decision received.");

    const chosenMathLineup =
      bestLineups[llmResult.bestLineupIndex] || bestLineups[0];

    if (!chosenMathLineup) {
      throw new Error("No math lineup selected");
    }

    // Map FantasyPlayer back to Player interface for output
    const finalPlayers = chosenMathLineup.players.map((fp) => ({
      id: fp.id,
      name: fp.name,
      team: fp.team,
      role: llmResult.roles[fp.id] || "No Role Assigned",
      rating: fp.stats.rating,
    }));

    // Output reasoning to console for transparency
    console.log("\n🧠 AI Reasoning:");
    console.log(`\x1b[36m${llmResult.reasoning}\x1b[0m\n`);

    return {
      players: finalPlayers,
      analyzedAt: new Date(),
      sourceUrl,
      roles: llmResult.roles,
      boosters: llmResult.boosters,
      reasoning: llmResult.reasoning,
    };
  }
}
