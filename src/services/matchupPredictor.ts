import type {FantasyTeam} from "../types/player.ts";

export class MatchupPredictor {
  /**
   * Future implementation hook:
   * Returns a risk score between 0 and 1.
   * 0 means no risk (good matchup or no cannibalization).
   * 1 means catastrophic risk (players guaranteed to eliminate each other early).
   */
  getMatchupRiskScore(teamA: string, teamB: string): number {
    // Placeholder logic for future matchup parsing
    return 0;
  }

  evaluateRosterRisk(rosterTeams: string[]): number {
    // In the future, this will loop over pairs of teams in the 5-man roster
    // and sum or multiply their matchup risk scores.
    let totalRisk = 0;
    return totalRisk;
  }
}

export const matchupPredictor = new MatchupPredictor();
