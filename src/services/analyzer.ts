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
import type {LlmProgressCallback} from "./llmSelector.ts";
import {createProgressBar} from "../cli/output.ts";

export class FantasyAnalyzerService implements AnalyzerService {
  async analyze(
    players: FantasyPlayer[],
    teams: FantasyTeam[],
    config: FantasyConfig,
    sourceUrl: string,
  ): Promise<AnalysisResult> {
    // ── Stage 1: Stats Enrichment ────────────────────────────────────────────
    const statsBar = createProgressBar("Stage 1 · Enriching player stats");
    statsBar.tick(0, 1, "Fetching historical HLTV stats (cache or disk)...");
    const scraper = new StatsScraperService();
    const enrichedPlayers =
      await scraper.enrichPlayersWithHistoricalStats(players);
    statsBar.done("Stats enriched", 1);

    // ── Stage 2: Math Optimizer ──────────────────────────────────────────────
    const mathBar = createProgressBar("Stage 2 · Generating optimal lineups");
    mathBar.tick(0, 1, "Crunching combinations...");
    const bestLineups = mathOptimizer.optimize(enrichedPlayers, config);

    if (bestLineups.length === 0) {
      throw new Error(
        "Could not find any mathematically valid lineups for given budget and constraints.",
      );
    }
    mathBar.done(`Generated ${bestLineups.length} valid lineups`, 1);

    // ── Stage 3: LLM Evaluation (one call per lineup) ───────────────────────
    const llmBar = createProgressBar(
      `Stage 3 · AI evaluating ${bestLineups.length} lineups`,
    );

    const onLlmProgress: LlmProgressCallback = (completed, total, label) => {
      llmBar.tick(completed, total, label);
    };

    const llmResult = await llmSelector.selectBestLineup(
      bestLineups,
      onLlmProgress,
    );
    llmBar.done(
      `Best lineup selected (index ${llmResult.bestLineupIndex})`,
      bestLineups.length,
    );

    // ── Assemble result ──────────────────────────────────────────────────────
    const chosenMathLineup =
      bestLineups[llmResult.bestLineupIndex] || bestLineups[0];

    if (!chosenMathLineup) {
      throw new Error("No math lineup selected");
    }

    const finalPlayers = chosenMathLineup.players.map((fp) => ({
      id: fp.id,
      name: fp.name,
      team: fp.team,
      role: llmResult.roles[fp.id] || "No Role Assigned",
      rating: fp.stats.rating,
    }));

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
