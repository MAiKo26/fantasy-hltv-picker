import type {FantasyTeam, MatchesExtractionResult} from "../types/player.ts";
import {normalizeTeamName} from "../utils/normalize.ts";

export class MatchupPredictor {
  private teamRankings: Map<string, number> = new Map();
  private teamExpectedOutcome: Map<string, number> = new Map();
  private teamOutcomeMatchCount: Map<string, number> = new Map();
  private pairRisk: Map<string, number> = new Map();

  private getPairKey(teamA: string, teamB: string): string {
    const a = normalizeTeamName(teamA);
    const b = normalizeTeamName(teamB);
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  private estimateWinProbability(rankA: number, rankB: number): number {
    if (!rankA || !rankB) return 0.5;
    const rankDelta = rankB - rankA;
    const logistic = 1 / (1 + Math.exp(-rankDelta / 8));
    return Math.min(0.9, Math.max(0.1, logistic));
  }

  configure(teams: FantasyTeam[], matches?: MatchesExtractionResult): void {
    this.teamRankings.clear();
    this.teamExpectedOutcome.clear();
    this.teamOutcomeMatchCount.clear();
    this.pairRisk.clear();

    for (const team of teams) {
      this.teamRankings.set(normalizeTeamName(team.name), team.worldRank);
    }

    if (!matches) return;

    for (const match of matches.matches) {
      const teamA = match.team1Name;
      const teamB = match.team2Name;
      if (!teamA || !teamB) continue;

      const keyA = normalizeTeamName(teamA);
      const keyB = normalizeTeamName(teamB);
      const rankA = this.teamRankings.get(keyA) ?? 0;
      const rankB = this.teamRankings.get(keyB) ?? 0;
      const winProbA = this.estimateWinProbability(rankA, rankB);
      const winProbB = 1 - winProbA;

      // Keep matchups as risk-control input; team outcome is bounded and averaged.
      const expectedTeamPointsA = 9 * winProbA - 3;
      const expectedTeamPointsB = 9 * winProbB - 3;
      const boundedA = Math.tanh(expectedTeamPointsA / 6);
      const boundedB = Math.tanh(expectedTeamPointsB / 6);
      this.teamExpectedOutcome.set(
        keyA,
        (this.teamExpectedOutcome.get(keyA) ?? 0) + boundedA,
      );
      this.teamExpectedOutcome.set(
        keyB,
        (this.teamExpectedOutcome.get(keyB) ?? 0) + boundedB,
      );
      this.teamOutcomeMatchCount.set(
        keyA,
        (this.teamOutcomeMatchCount.get(keyA) ?? 0) + 1,
      );
      this.teamOutcomeMatchCount.set(
        keyB,
        (this.teamOutcomeMatchCount.get(keyB) ?? 0) + 1,
      );

      // Direct opponents in same opening round should be penalized in stacks.
      const formatBoost = match.bestOf?.toLowerCase() === "bo1" ? 0.25 : 0.1;
      const risk = 1 + formatBoost;
      const pairKey = this.getPairKey(teamA, teamB);
      this.pairRisk.set(pairKey, (this.pairRisk.get(pairKey) ?? 0) + risk);
    }
  }

  getTeamExpectedOutcomeScore(team: string): number {
    const key = normalizeTeamName(team);
    const total = this.teamExpectedOutcome.get(key) ?? 0;
    const count = this.teamOutcomeMatchCount.get(key) ?? 0;
    if (count === 0) return 0;
    return total / count;
  }

  getMatchupRiskScore(teamA: string, teamB: string): number {
    if (normalizeTeamName(teamA) === normalizeTeamName(teamB)) return 0;
    return this.pairRisk.get(this.getPairKey(teamA, teamB)) ?? 0;
  }

  evaluateRosterRisk(rosterTeams: string[]): number {
    let totalRisk = 0;
    for (let i = 0; i < rosterTeams.length; i++) {
      for (let j = i + 1; j < rosterTeams.length; j++) {
        const teamA = rosterTeams[i];
        const teamB = rosterTeams[j];
        if (!teamA || !teamB) continue;
        totalRisk += this.getMatchupRiskScore(teamA, teamB);
      }
    }
    return totalRisk;
  }
}

export const matchupPredictor = new MatchupPredictor();
