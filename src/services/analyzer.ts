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
    const statsBar = createProgressBar("Stage 1 · Enriching player stats");
    statsBar.tick(0, 1, "Fetching historical HLTV stats (cache or disk)...");
    const scraper = new StatsScraperService();
    const enrichedPlayers =
      await scraper.enrichPlayersWithHistoricalStats(players);
    statsBar.done("Stats enriched", 1);

    const mathBar = createProgressBar("Stage 2 · Generating optimal lineups");
    mathBar.tick(0, 1, "Crunching combinations...");
    const bestLineups = mathOptimizer.optimize(
      enrichedPlayers,
      teams,
      config,
      bundle,
    );

    if (bestLineups.length === 0) {
      throw new Error(
        "Could not find any mathematically valid lineups for given budget and constraints.",
      );
    }
    mathBar.done(`Generated ${bestLineups.length} valid lineups`, 1);

    const lineupPreviewBar = createProgressBar("Previewing lineups");
    lineupPreviewBar.tick(0, 1, "Showing math-optimized lineups...");
    console.log(
      chalk.bold.white("\n📊 TOP MATH-OPTIMIZED LINEUPS:\n"),
    );
    bestLineups.slice(0, 30).forEach((lineup, idx) => {
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
      .slice(0, 30);

    const bestMathLineup = bestLineups[0]!;
    const finalPlayers = bestMathLineup.players.map((fp) => ({
      id: fp.id,
      name: fp.name,
      team: fp.team,
      rating: fp.stats.rating,
    }));

    return {
      players: finalPlayers,
      analyzedAt: new Date(),
      sourceUrl,
      reasoning: "Highest expected base score from math optimizer",
      top3: [
        {
          players: finalPlayers,
          lineupIndex: 0,
          reasoning: "Highest expected base score from math optimizer",
          score: bestMathLineup.expectedBaseScore,
        },
      ],
      allScoredLineups: bestLineups.map((lineup, idx) => ({
        players: lineup.players.map((fp) => ({
          id: fp.id,
          name: fp.name,
          team: fp.team,
          rating: fp.stats.rating,
        })),
        lineupIndex: idx,
        reasoning: "Math-optimized lineup",
        score: lineup.expectedBaseScore,
        totalPrice: lineup.totalPrice,
      })),
      top20ByRating,
    };
  }
}
