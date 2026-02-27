import type {
  FantasyPlayer,
  FantasyTeam,
  Strategy,
  FantasyConfig,
} from "../types/player.ts";
import {matchupPredictor} from "./matchupPredictor.ts";
import {env} from "../env.ts";

export interface MathLineup {
  players: FantasyPlayer[];
  totalPrice: number;
  expectedBaseScore: number;
  strategyUsed: Strategy;
}

export class MathOptimizer {
  private MAX_BUDGET = 1000000;
  private teamRankings: Map<string, number> = new Map();

  setTeams(teams: FantasyTeam[]): void {
    this.teamRankings.clear();
    for (const team of teams) {
      this.teamRankings.set(team.name, team.worldRank);
    }
  }

  getExpectedBaseScore(player: FantasyPlayer): number {
    const teamRank = this.teamRankings.get(player.team);
    let score = player.stats.rating;

    if (player.stats.rating3mTop20) score += player.stats.rating3mTop20 * 0.5;
    if (player.stats.rating6mTop20) score += player.stats.rating6mTop20 * 0.3;
    if (player.stats.rating12mTop50)
      score += player.stats.rating12mTop50 * 0.15;

    if (teamRank) score += (1 / teamRank) * 2.0;

    if (player.stats.awpPerRound >= 0.15) score += 0.01;

    const ctToTRatingDiff = player.stats.ctRating - player.stats.tRating;
    if (ctToTRatingDiff > 0) score += ctToTRatingDiff * 0.1;
    else if (ctToTRatingDiff < 0) score += ctToTRatingDiff * 0.2;

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

  optimize(
    players: FantasyPlayer[],
    teams: FantasyTeam[],
    config: FantasyConfig,
  ): MathLineup[] {
    this.setTeams(teams);

    const targetStrategies: Strategy[] =
      config.strategy === "Auto"
        ? ["2-2-1", "2-1-1-1", "1-1-1-1-1"]
        : [config.strategy];

    // Filter out wildly bad picks to save permutation CPU time
    // Only keep players with base score > some threshold OR cheap price
    const blacklist = new Set(
      env.BLACKLISTED_PLAYERS.map((name) => name.toLowerCase()),
    );
    const validPlayers = players.filter(
      (p) => p.price <= 230000 && !blacklist.has(p.name.toLowerCase()),
    );

    // We can't do combinations of all players, it's C(80, 5) = 24 million
    // So we first sort players by cost-efficiency or raw score and take top N
    const pool = [...validPlayers].sort(
      (a, b) => this.getExpectedBaseScore(b) - this.getExpectedBaseScore(a),
    );

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
