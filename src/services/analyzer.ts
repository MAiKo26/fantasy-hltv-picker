import type {
  AnalyzerService,
  AnalysisResult,
  FantasyPlayer,
  FantasyTeam,
  FantasyConfig,
  EventBundleContext,
} from "../types/player.ts";
import {StatsScraperService} from "./statsScraper.ts";
import {mathOptimizer} from "./mathOptimizer.ts";
import {llmSelector} from "./llmSelector.ts";
import type {LlmProgressCallback} from "./llmSelector.ts";
import {createProgressBar, printScoringDiagnostics} from "../cli/output.ts";
import chalk from "chalk";
import {env} from "../env.ts";

export class FantasyAnalyzerService implements AnalyzerService {
  async analyze(
    players: FantasyPlayer[],
    teams: FantasyTeam[],
    config: FantasyConfig,
    sourceUrl: string,
    bundle?: EventBundleContext,
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
    const bestLineups = mathOptimizer.optimize(enrichedPlayers, teams, config, bundle);

    if (bestLineups.length === 0) {
      throw new Error(
        "Could not find any mathematically valid lineups for given budget and constraints.",
      );
    }
    mathBar.done(`Generated ${bestLineups.length} valid lineups`, 1);

    // Print top 20 math-generated lineups before LLM evaluation
    const lineupPreviewBar = createProgressBar("Previewing top 20 lineups");
    lineupPreviewBar.tick(0, 1, "Showing math-optimized lineups...");
    console.log(
      chalk.bold.white("\n📊 TOP 20 MATH-OPTIMIZED LINEUPS (Pre-LLM):\n"),
    );
    bestLineups.slice(0, 20).forEach((lineup, idx) => {
      const playerNames = lineup.players.map((p) => p.name).join(" | ");
      const price = chalk.yellow(`$${(lineup.totalPrice / 1000).toFixed(0)}k`);
      const expected = chalk.cyan(
        `Exp: ${lineup.expectedBaseScore.toFixed(2)}`,
      );
      console.log(
        `  ${chalk.gray(`${idx + 1}.`)} ${playerNames} | ${price} | ${expected}`,
      );
    });
    lineupPreviewBar.done("Lineups previewed", 1);

    if (env.SCORING_DIAGNOSTICS) {
      printScoringDiagnostics(mathOptimizer.getLatestDiagnostics());
    }

    // Calculate top 20 players by expected base score
    const playerScores = new Map<
      string,
      {id: string; name: string; team: string; rating: number}
    >();
    for (const p of enrichedPlayers) {
      playerScores.set(p.id, {
        id: p.id,
        name: p.name,
        team: p.team,
        rating: mathOptimizer.getExpectedBaseScore(p),
      });
    }
    const top20ByRating = Array.from(playerScores.values())
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 20);

    // ── Stage 3: LLM Evaluation (one call per lineup) ───────────────────────
    if (config.disableLLMEvaluation) {
      console.log(
        chalk.yellow(
          "\n⚠️  Stage 3 (LLM Evaluation) disabled - returning best math lineup\n",
        ),
      );
      const bestMathLineup = bestLineups[0]!;
      const finalPlayers = bestMathLineup.players.map((fp) => ({
        id: fp.id,
        name: fp.name,
        team: fp.team,
        role: "N/A (No LLM evaluation)",
        rating: fp.stats.rating,
      }));

      return {
        players: finalPlayers,
        analyzedAt: new Date(),
        sourceUrl,
        roles: {},
        reasoning:
          "No LLM evaluation performed - using highest expected score lineup",
        top3: [
          {
            players: finalPlayers,
            lineupIndex: 0,
            reasoning: "Highest expected base score from math optimizer",
            roles: {},
            score: bestMathLineup.expectedBaseScore,
          },
        ],
        allScoredLineups: bestLineups.map((lineup, idx) => ({
          players: lineup.players.map((fp) => ({
            id: fp.id,
            name: fp.name,
            team: fp.team,
            role: "N/A",
            rating: fp.stats.rating,
          })),
          lineupIndex: idx,
          reasoning: "Math-optimized lineup",
          roles: {},
          score: lineup.expectedBaseScore,
          totalPrice: lineup.totalPrice,
        })),
        top20ByRating,
      };
    }

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
    llmBar.done(`Top lineups selected`, bestLineups.length);

    // ── Assemble result ──────────────────────────────────────────────────────
    const chosenMathLineup =
      bestLineups[llmResult.top3[0]!.lineupIndex] || bestLineups[0];

    if (!chosenMathLineup) {
      throw new Error("No math lineup selected");
    }

    const finalPlayers = chosenMathLineup.players.map((fp) => ({
      id: fp.id,
      name: fp.name,
      team: fp.team,
      role: llmResult.top3[0]!.roles[fp.id] || "No Role Assigned",
      rating: fp.stats.rating,
    }));

    const top3: AnalysisResult["top3"] = llmResult.top3.map((t) => {
      const mathLineup = bestLineups[t.lineupIndex];
      if (!mathLineup) {
        return {
          ...t,
          players: [],
        };
      }
      return {
        ...t,
        players: mathLineup.players.map((fp) => ({
          id: fp.id,
          name: fp.name,
          team: fp.team,
          role: t.roles[fp.id] || "No Role Assigned",
          rating: fp.stats.rating,
        })),
      };
    });

    const allScoredLineups: AnalysisResult["allScoredLineups"] =
      llmResult.allScoredLineups.map((t) => {
        const mathLineup = bestLineups[t.lineupIndex];
        if (!mathLineup) {
          return {
            ...t,
            players: [],
            totalPrice: 0,
          };
        }
        return {
          ...t,
          players: mathLineup.players.map((fp) => ({
            id: fp.id,
            name: fp.name,
            team: fp.team,
            role: t.roles[fp.id] || "No Role Assigned",
            rating: fp.stats.rating,
          })),
          totalPrice: mathLineup.totalPrice,
        };
      });

    return {
      players: finalPlayers,
      analyzedAt: new Date(),
      sourceUrl,
      roles: llmResult.top3[0]!.roles,
      reasoning: llmResult.top3[0]!.reasoning,
      top3,
      allScoredLineups,
      top20ByRating,
    };
  }
}
