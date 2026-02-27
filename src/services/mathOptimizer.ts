import type {FantasyPlayer, Strategy, FantasyConfig} from "../types/player.ts";
import {matchupPredictor} from "./matchupPredictor.ts";

export interface MathLineup {
  players: FantasyPlayer[];
  totalPrice: number;
  expectedBaseScore: number;
  strategyUsed: Strategy;
}

export class MathOptimizer {
  private MAX_BUDGET = 1000000;

  getExpectedBaseScore(player: FantasyPlayer): number {
    let score = player.stats.rating;

    // Weight historical LAN/Top20 form (Good/Elite indicators)
    if (player.stats.rating3mTop20) score += player.stats.rating3mTop20 * 0.3;
    if (player.stats.rating6mTop20) score += player.stats.rating6mTop20 * 0.2;
    if (player.stats.rating12mTop50) score += player.stats.rating12mTop50 * 0.1;

    // Weight team's world rank (better team -> more likely to win more rounds -> more points)
    // Assuming we do this later or we can do it on the whole roster, but for now we just care about player stats
    return score;
  }

  private isValidStrategy(
    teamCounts: Record<string, number>,
    strategy: Strategy,
  ): boolean {
    const counts = Object.values(teamCounts).sort((a, b) => b - a);

    if (strategy === "2-2-1") {
      return (
        counts.length === 3 &&
        (counts[0] ?? 0) <= 2 &&
        (counts[1] ?? 0) <= 2 &&
        counts[2] === 1
      );
    }
    if (strategy === "2-1-1-1") {
      return (
        counts.length === 4 &&
        (counts[0] ?? 0) <= 2 &&
        counts[1] === 1 &&
        counts[2] === 1 &&
        counts[3] === 1
      );
    }
    if (strategy === "1-1-1-1-1") {
      return counts.length === 5 && counts.every((c) => c === 1);
    }
    return false;
  }

  private getCombinations(
    players: FantasyPlayer[],
    k: number,
  ): FantasyPlayer[][] {
    const result: FantasyPlayer[][] = [];

    function combine(start: number, combo: FantasyPlayer[]) {
      if (combo.length === k) {
        result.push([...combo]);
        return;
      }
      for (let i = start; i < players.length; i++) {
        const p = players[i];
        if (p) {
          combine(i + 1, [...combo, p]);
        }
      }
    }
    combine(0, []);
    return result;
  }

  optimize(players: FantasyPlayer[], config: FantasyConfig): MathLineup[] {
    const targetStrategies: Strategy[] =
      config.strategy === "Auto"
        ? ["2-2-1", "2-1-1-1", "1-1-1-1-1"]
        : [config.strategy];

    // Filter out wildly bad picks to save permutation CPU time
    // Only keep players with base score > some threshold OR cheap price
    const validPlayers = players.filter((p) => p.price <= 230000);

    // We can't do combinations of all players, it's C(80, 5) = 24 million
    // So we first sort players by cost-efficiency or raw score and take top N
    const sortedPlayers = [...validPlayers].sort(
      (a, b) => this.getExpectedBaseScore(b) - this.getExpectedBaseScore(a),
    );
    const pool = sortedPlayers.slice(0, 35); // top 35 players

    const combinations = this.getCombinations(pool, 5);
    const validLineups: MathLineup[] = [];

    for (const combo of combinations) {
      let totalPrice = 0;
      let expectedBaseScore = 0;
      let g2Count = 0;
      const teamCounts: Record<string, number> = {};

      for (const p of combo) {
        totalPrice += p.price;
        expectedBaseScore += this.getExpectedBaseScore(p);
        teamCounts[p.team] = (teamCounts[p.team] || 0) + 1;
        if (p.team === "G2") g2Count++;
      }

      if (totalPrice > this.MAX_BUDGET) continue;

      if (config.minG2Players !== "Auto" && g2Count < config.minG2Players)
        continue;

      // Penalize for matchup risks
      const rosterTeams = Object.keys(teamCounts);
      const matchupRisk = matchupPredictor.evaluateRosterRisk(rosterTeams);
      expectedBaseScore -= matchupRisk * 2.5; // Arbitrary penalty weight

      for (const strat of targetStrategies) {
        if (this.isValidStrategy(teamCounts, strat)) {
          validLineups.push({
            players: combo,
            totalPrice,
            expectedBaseScore,
            strategyUsed: strat,
          });
          break; // Don't add same combo multiple times
        }
      }
    }

    return validLineups
      .sort((a, b) => b.expectedBaseScore - a.expectedBaseScore)
      .slice(0, 20);
  }
}

export const mathOptimizer = new MathOptimizer();
