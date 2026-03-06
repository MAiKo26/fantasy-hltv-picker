import type {
  EventBundleContext,
  FantasyPlayer,
  FantasyTeam,
  Strategy,
  FantasyConfig,
} from "../types/player.ts";
import {matchupPredictor} from "./matchupPredictor.ts";
import {env} from "../env.ts";
import {normalizePlayerName, normalizeTeamName} from "../utils/normalize.ts";

export interface MathLineup {
  players: FantasyPlayer[];
  totalPrice: number;
  expectedBaseScore: number;
  strategyUsed: Strategy;
  scoringBreakdown?: {
    baseSkillEV: number;
    roleEV: number;
    boosterEV: number;
    teamOutcomeEV: number;
    fieldLeverageEV: number;
    lineupLeverageEV: number;
    stackCorrelationEV: number;
    matchupRiskPenalty: number;
  };
}

interface PlayerProjection {
  total: number;
  baseSkillEV: number;
  roleEV: number;
  boosterEV: number;
  teamOutcomeEV: number;
  fieldLeverageEV: number;
}

export class MathOptimizer {
  private readonly MAX_BUDGET = 1000000;
  private readonly MAX_PLAYER_PRICE = 245000;
  private readonly TARGET_RESULTS = 20;
  private readonly CANDIDATE_POOL_LIMIT = 65;
  private readonly TEAM_CANDIDATES_LIMIT = 4;
  private readonly MAX_TRACKED_LINEUPS = 250;

  private readonly WEIGHTS = {
    // Base skill model
    historical3m: 0.25,
    historical6m: 0.12,
    historical12m: 0.05,
    teamRankBonus: 0.2,
    awpBonus: 0.01,
    survivalBonus: 0.02,
    sideVariancePenalty: 0.1,

    // Field-aware model
    rolePotential: 0.22,
    boosterPotential: 0.12,
    teamOutcome: 0.085,
    playerLeverage: 0.3,
    lineupLeverage: 0.45,
    stackCorrelation: 0.04,
    matchupRiskPenalty: 0.38,
  } as const;

  private teamRankings: Map<string, number> = new Map();
  private ownershipByPlayerKey: Map<string, number> = new Map();
  private fallbackOwnership = 0.2;

  setTeams(teams: FantasyTeam[]): void {
    this.teamRankings.clear();
    for (const team of teams) {
      this.teamRankings.set(normalizeTeamName(team.name), team.worldRank);
    }
  }

  getExpectedBaseScore(player: FantasyPlayer): number {
    const teamRank = this.teamRankings.get(normalizeTeamName(player.team));

    let score = player.stats.rating;

    const historicalBonus =
      (player.stats.rating3mTop20 ?? 0) * this.WEIGHTS.historical3m +
      (player.stats.rating6mTop30 ?? 0) * this.WEIGHTS.historical6m +
      (player.stats.rating12mTop50 ?? 0) * this.WEIGHTS.historical12m;
    score += historicalBonus;

    if (teamRank) {
      score += Math.log(1 + 1 / teamRank) * this.WEIGHTS.teamRankBonus;
    }

    if (player.stats.awpPerRound >= 0.25) score += this.WEIGHTS.awpBonus;

    if (player.stats.deathsPerRound <= 0.6) score += this.WEIGHTS.survivalBonus;

    const sideVariance = Math.abs(player.stats.ctRating - player.stats.tRating);
    score -= sideVariance * this.WEIGHTS.sideVariancePenalty;

    return score;
  }

  private setFieldOwnership(bundle?: EventBundleContext): void {
    this.ownershipByPlayerKey.clear();
    const picks = bundle?.overview?.mostPickedPlayers ?? [];
    if (picks.length === 0) {
      this.fallbackOwnership = 0.2;
      return;
    }

    const maxPickCount = Math.max(...picks.map((p) => p.pickCount), 1);
    let ownershipSum = 0;

    for (const pick of picks) {
      const relative = pick.pickCount / maxPickCount;
      // Compress tail so top-pick penalties are meaningful without overwhelming EV.
      const normalized = Math.min(0.92, 0.08 + Math.sqrt(relative) * 0.72);
      this.ownershipByPlayerKey.set(normalizePlayerName(pick.playerName), normalized);
      ownershipSum += normalized;
    }

    const knownAverage = ownershipSum / picks.length;
    this.fallbackOwnership = Math.max(0.08, Math.min(0.5, knownAverage * 0.55));
  }

  private getPlayerOwnership(player: FantasyPlayer): number {
    return (
      this.ownershipByPlayerKey.get(normalizePlayerName(player.name)) ??
      this.fallbackOwnership
    );
  }

  private normalizeRate(value: number, threshold: number): number {
    if (threshold <= 1 && value > 1.2) return value / 100;
    return value;
  }

  private thresholdScore(
    value: number,
    maxThreshold: number,
    smallThreshold: number,
    inverse = false,
  ): number {
    const normalizedValue = this.normalizeRate(value, maxThreshold);
    const isMax = inverse
      ? normalizedValue < maxThreshold
      : normalizedValue > maxThreshold;
    if (isMax) return 1;

    const isSmall = inverse
      ? normalizedValue <= smallThreshold
      : normalizedValue >= smallThreshold;
    if (isSmall) return 0.4;

    return -0.6;
  }

  private getRolePotentialScore(player: FantasyPlayer): number {
    const roleScores = [
      this.thresholdScore(player.stats.awpPerRound, 0.35, 0.2), // Main AWP
      this.thresholdScore(player.stats.supportRoundsPct, 25, 17), // Support
      this.thresholdScore(player.stats.tRating, 1.3, 0.9), // Attacker
      this.thresholdScore(player.stats.rating, 1.3, 1.0), // Stathunter
      this.thresholdScore(player.stats.entryRoundsPct, 0.15, 0.08), // Entry
      this.thresholdScore(player.stats.deathsPerRound, 0.55, 0.65, true), // Camper
      this.thresholdScore(player.stats.ctRating, 1.35, 1.0), // Defender
      this.thresholdScore(player.stats.headshotPct, 60, 50), // HS Machine
      this.thresholdScore(player.stats.multiKillRoundsPct, 0.2, 0.14), // Multi Fragger
      this.thresholdScore(player.stats.rating, 0.85, 1.12, true), // Noob
    ];

    const teamOutcome = matchupPredictor.getTeamExpectedOutcomeScore(player.team);
    const leaderSignal = Math.max(-1, Math.min(1, teamOutcome / 3.5));
    roleScores.push(leaderSignal);

    return Math.max(...roleScores);
  }

  private getBoosterPotentialScore(player: FantasyPlayer): number {
    const ratingSignal = Math.max(-1, Math.min(1, (player.stats.rating - 1) / 0.35));
    const entrySignal = Math.max(
      -1,
      Math.min(1, (this.normalizeRate(player.stats.entryRoundsPct, 0.15) - 0.08) / 0.08),
    );
    const multiSignal = Math.max(
      -1,
      Math.min(
        1,
        (this.normalizeRate(player.stats.multiKillRoundsPct, 0.2) - 0.12) / 0.08,
      ),
    );
    const hsSignal = Math.max(-1, Math.min(1, (player.stats.headshotPct - 50) / 18));

    return ratingSignal * 0.45 + entrySignal * 0.2 + multiSignal * 0.25 + hsSignal * 0.1;
  }

  private getPlayerProjection(player: FantasyPlayer): PlayerProjection {
    const baseSkillEV = this.getExpectedBaseScore(player);
    const roleEV = this.getRolePotentialScore(player) * this.WEIGHTS.rolePotential;
    const boosterEV = this.getBoosterPotentialScore(player) * this.WEIGHTS.boosterPotential;
    const teamOutcomeEV =
      matchupPredictor.getTeamExpectedOutcomeScore(player.team) * this.WEIGHTS.teamOutcome;
    const ownership = this.getPlayerOwnership(player);
    const fieldLeverageEV = (0.5 - ownership) * this.WEIGHTS.playerLeverage;

    return {
      total: baseSkillEV + roleEV + boosterEV + teamOutcomeEV + fieldLeverageEV,
      baseSkillEV,
      roleEV,
      boosterEV,
      teamOutcomeEV,
      fieldLeverageEV,
    };
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

  private buildCandidatePool(
    players: FantasyPlayer[],
    projectionById: Map<string, PlayerProjection>,
  ): FantasyPlayer[] {
    const sorted = [...players].sort((a, b) => {
      const scoreA = projectionById.get(a.id)?.total ?? 0;
      const scoreB = projectionById.get(b.id)?.total ?? 0;
      return scoreB - scoreA;
    });

    const merged = new Map<string, FantasyPlayer>();
    for (const p of sorted.slice(0, this.CANDIDATE_POOL_LIMIT)) {
      merged.set(p.id, p);
    }

    const byTeam = new Map<string, FantasyPlayer[]>();
    for (const p of sorted) {
      const key = normalizeTeamName(p.team);
      const list = byTeam.get(key) ?? [];
      if (list.length < this.TEAM_CANDIDATES_LIMIT) {
        list.push(p);
        byTeam.set(key, list);
      }
    }
    for (const list of byTeam.values()) {
      for (const player of list) merged.set(player.id, player);
    }

    return [...merged.values()].sort((a, b) => {
      const scoreA = projectionById.get(a.id)?.total ?? 0;
      const scoreB = projectionById.get(b.id)?.total ?? 0;
      return scoreB - scoreA;
    });
  }

  private getOptimisticUpperBound(
    sortedScores: number[],
    startIndex: number,
    remainingSlots: number,
  ): number {
    let sum = 0;
    let taken = 0;
    for (let i = startIndex; i < sortedScores.length && taken < remainingSlots; i++) {
      const score = sortedScores[i];
      if (score === undefined) continue;
      sum += score;
      taken++;
    }
    return taken === remainingSlots ? sum : Number.NEGATIVE_INFINITY;
  }

  optimize(
    players: FantasyPlayer[],
    teams: FantasyTeam[],
    config: FantasyConfig,
    bundle?: EventBundleContext,
  ): MathLineup[] {
    this.setTeams(teams);
    this.setFieldOwnership(bundle);
    matchupPredictor.configure(teams, bundle?.matches);

    const targetStrategies: Strategy[] =
      config.strategy === "Auto"
        ? ["2-2-1", "2-1-1-1", "1-1-1-1-1"]
        : [config.strategy];

    const blacklist = new Set(
      env.BLACKLISTED_PLAYERS.map((name) => normalizePlayerName(name)),
    );
    const validPlayers = players.filter(
      (p) =>
        p.price <= this.MAX_PLAYER_PRICE &&
        !blacklist.has(normalizePlayerName(p.name)),
    );
    if (validPlayers.length < 5) return [];

    const projectionById = new Map<string, PlayerProjection>();
    for (const player of validPlayers) {
      projectionById.set(player.id, this.getPlayerProjection(player));
    }

    const pool = this.buildCandidatePool(validPlayers, projectionById);
    const sortedScores = pool.map((p) => projectionById.get(p.id)?.total ?? 0);

    const selectedPlayers: FantasyPlayer[] = [];
    const teamCounts: Record<string, number> = {};
    const validLineups: MathLineup[] = [];

    const addLineup = (lineup: MathLineup) => {
      validLineups.push(lineup);
      validLineups.sort((a, b) => b.expectedBaseScore - a.expectedBaseScore);
      if (validLineups.length > this.MAX_TRACKED_LINEUPS) {
        validLineups.length = this.MAX_TRACKED_LINEUPS;
      }
    };

    const getCutoffScore = () => {
      if (validLineups.length < this.MAX_TRACKED_LINEUPS) return Number.NEGATIVE_INFINITY;
      return validLineups[validLineups.length - 1]?.expectedBaseScore ?? Number.NEGATIVE_INFINITY;
    };

    const search = (
      startIndex: number,
      totalPrice: number,
      g2Count: number,
      componentSums: {
        baseSkillEV: number;
        roleEV: number;
        boosterEV: number;
        teamOutcomeEV: number;
        fieldLeverageEV: number;
      },
    ) => {
      const remainingSlots = 5 - selectedPlayers.length;
      if (remainingSlots === 0) {
        if (totalPrice > this.MAX_BUDGET) return;
        if (config.minG2Players !== "Auto" && g2Count < config.minG2Players) return;

        let strategyUsed: Strategy | null = null;
        for (const strategy of targetStrategies) {
          if (this.isValidStrategy(teamCounts, strategy)) {
            strategyUsed = strategy;
            break;
          }
        }
        if (!strategyUsed) return;

        const rosterTeams = Object.keys(teamCounts);
        const matchupRiskPenalty =
          matchupPredictor.evaluateRosterRisk(rosterTeams) *
          this.WEIGHTS.matchupRiskPenalty;

        const totalOwnership = selectedPlayers.reduce(
          (sum, p) => sum + this.getPlayerOwnership(p),
          0,
        );
        const avgOwnership = totalOwnership / selectedPlayers.length;
        const lineupLeverageEV = (0.5 - avgOwnership) * this.WEIGHTS.lineupLeverage;

        let stackCorrelationEV = 0;
        for (const [team, count] of Object.entries(teamCounts)) {
          if (count <= 1) continue;
          stackCorrelationEV +=
            matchupPredictor.getTeamExpectedOutcomeScore(team) *
            (count - 1) *
            this.WEIGHTS.stackCorrelation;
        }

        const expectedBaseScore =
          componentSums.baseSkillEV +
          componentSums.roleEV +
          componentSums.boosterEV +
          componentSums.teamOutcomeEV +
          componentSums.fieldLeverageEV +
          lineupLeverageEV +
          stackCorrelationEV -
          matchupRiskPenalty;

        addLineup({
          players: [...selectedPlayers],
          totalPrice,
          expectedBaseScore,
          strategyUsed,
          scoringBreakdown: {
            baseSkillEV: componentSums.baseSkillEV,
            roleEV: componentSums.roleEV,
            boosterEV: componentSums.boosterEV,
            teamOutcomeEV: componentSums.teamOutcomeEV,
            fieldLeverageEV: componentSums.fieldLeverageEV,
            lineupLeverageEV,
            stackCorrelationEV,
            matchupRiskPenalty,
          },
        });
        return;
      }

      if (pool.length - startIndex < remainingSlots) return;

      const optimisticUpperBound =
        componentSums.baseSkillEV +
        componentSums.roleEV +
        componentSums.boosterEV +
        componentSums.teamOutcomeEV +
        componentSums.fieldLeverageEV +
        this.getOptimisticUpperBound(sortedScores, startIndex, remainingSlots) +
        1.5;

      if (optimisticUpperBound <= getCutoffScore()) return;

      for (let i = startIndex; i < pool.length; i++) {
        const player = pool[i];
        if (!player) continue;

        if (totalPrice + player.price > this.MAX_BUDGET) continue;

        const teamCount = teamCounts[player.team] ?? 0;
        if (teamCount >= 2) continue;

        const nextG2Count =
          g2Count + (normalizeTeamName(player.team) === "g2" ? 1 : 0);
        if (
          config.minG2Players !== "Auto" &&
          nextG2Count + (remainingSlots - 1) < config.minG2Players
        ) {
          continue;
        }

        const projection = projectionById.get(player.id);
        if (!projection) continue;

        selectedPlayers.push(player);
        teamCounts[player.team] = teamCount + 1;

        search(i + 1, totalPrice + player.price, nextG2Count, {
          baseSkillEV: componentSums.baseSkillEV + projection.baseSkillEV,
          roleEV: componentSums.roleEV + projection.roleEV,
          boosterEV: componentSums.boosterEV + projection.boosterEV,
          teamOutcomeEV: componentSums.teamOutcomeEV + projection.teamOutcomeEV,
          fieldLeverageEV: componentSums.fieldLeverageEV + projection.fieldLeverageEV,
        });

        selectedPlayers.pop();
        if (teamCount === 0) {
          delete teamCounts[player.team];
        } else {
          teamCounts[player.team] = teamCount;
        }
      }
    };

    search(0, 0, 0, {
      baseSkillEV: 0,
      roleEV: 0,
      boosterEV: 0,
      teamOutcomeEV: 0,
      fieldLeverageEV: 0,
    });

    return validLineups.slice(0, this.TARGET_RESULTS);
  }
}

export const mathOptimizer = new MathOptimizer();
