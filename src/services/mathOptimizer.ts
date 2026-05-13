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

interface ScoreWeights {
  historical12m: number;
  teamRankBonus: number;
  awpBonus: number;
  survivalBonus: number;
  sideVariancePenalty: number;
  roleExpected: number;
  boosterExpected: number;
  teamOutcome: number;
  playerLeverage: number;
  lineupLeverage: number;
  ownershipBand: number;
  stackCorrelation: number;
  matchupRiskPenalty: number;
  chalkWeakPenalty: number;
}

export type OptimizerWeightOverrides = Partial<ScoreWeights>;

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
    ownershipBandEV: number;
    stackCorrelationEV: number;
    chalkWeakPenalty: number;
    diversityPenalty: number;
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
  roleName: string | null;
  roleExpectedPoints: number;
  roleDownsideRisk: number;
  ownership: number;
  isWeakChalk: boolean;
}

export interface PlayerScoreDiagnostics {
  playerId: string;
  name: string;
  team: string;
  price: number;
  ownership: number;
  total: number;
  baseSkillEV: number;
  roleEV: number;
  boosterEV: number;
  teamOutcomeEV: number;
  fieldLeverageEV: number;
  roleName: string | null;
  roleExpectedPoints: number;
  roleDownsideRisk: number;
}

export interface LineupScoreDiagnostics {
  rank: number;
  playerNames: string[];
  totalScore: number;
  breakdown: NonNullable<MathLineup["scoringBreakdown"]>;
  sharesPct: Record<string, number>;
}

export interface OptimizationDiagnostics {
  topPlayers: PlayerScoreDiagnostics[];
  topLineups: LineupScoreDiagnostics[];
}

export class MathOptimizer {
  private readonly MAX_BUDGET = 1000000;
  private readonly MAX_PLAYER_PRICE = 245000;
  private readonly TARGET_RESULTS = 30;
  private readonly CANDIDATE_POOL_LIMIT = 65;
  private readonly TEAM_CANDIDATES_LIMIT = 4;
  private readonly MAX_TRACKED_LINEUPS = 250;
  private readonly TARGET_MIN_AVG_OWNERSHIP = 0.23;
  private readonly TARGET_MAX_AVG_OWNERSHIP = 0.4;

  private readonly DEFAULT_WEIGHTS: ScoreWeights = {
    historical12m: 0.05,
    teamRankBonus: 0.4,
    awpBonus: 0.01,
    survivalBonus: 0.02,
    sideVariancePenalty: 0.1,
    roleExpected: 0.075,
    boosterExpected: 0.03,
    teamOutcome: 0.04,
    playerLeverage: 0.2,
    lineupLeverage: 0.24,
    ownershipBand: 0.14,
    stackCorrelation: 0.015,
    matchupRiskPenalty: 0.55,
    chalkWeakPenalty: 0.16,
  };

  private teamRankings: Map<string, number> = new Map();
  private ownershipByPlayerKey: Map<string, number> = new Map();
  private rolePopularityByName: Map<string, number> = new Map();
  private boosterPopularityByName: Map<string, number> = new Map();
  private runtimeWeights: ScoreWeights = this.DEFAULT_WEIGHTS;
  private fallbackOwnership = 0.2;
  private lastDiagnostics: OptimizationDiagnostics = {
    topPlayers: [],
    topLineups: [],
  };

  private resolveWeights(overrides?: OptimizerWeightOverrides): ScoreWeights {
    return {
      ...this.DEFAULT_WEIGHTS,
      ...(overrides ?? {}),
    };
  }

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
      (player.stats.rating12mTop50 ?? 0) * this.runtimeWeights.historical12m;
    score += historicalBonus;

    if (teamRank) {
      score += Math.log(1 + 1 / teamRank) * this.runtimeWeights.teamRankBonus;
    }

    if (player.stats.awpPerRound >= 0.25) score += this.runtimeWeights.awpBonus;

    if (player.stats.deathsPerRound <= 0.6)
      score += this.runtimeWeights.survivalBonus;

    const sideVariance = Math.abs(player.stats.ctRating - player.stats.tRating);
    score -= sideVariance * this.runtimeWeights.sideVariancePenalty;

    return score;
  }

  private setFieldOwnership(bundle?: EventBundleContext): void {
    this.ownershipByPlayerKey.clear();
    this.rolePopularityByName.clear();
    this.boosterPopularityByName.clear();

    const roleAssignments = bundle?.overview?.roleAssignments ?? [];
    const boosterAssignments = bundle?.overview?.boosterAssignments ?? [];
    const maxRoleCount = Math.max(
      ...roleAssignments.map((entry) => entry.assignedCount),
      1,
    );
    const maxBoosterCount = Math.max(
      ...boosterAssignments.map((entry) => entry.assignedCount),
      1,
    );

    for (const role of roleAssignments) {
      this.rolePopularityByName.set(
        role.name,
        Math.min(1, role.assignedCount / maxRoleCount),
      );
    }
    for (const booster of boosterAssignments) {
      this.boosterPopularityByName.set(
        booster.name,
        Math.min(1, booster.assignedCount / maxBoosterCount),
      );
    }

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
      this.ownershipByPlayerKey.set(
        normalizePlayerName(pick.playerName),
        normalized,
      );
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

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private normalizeRate(value: number, threshold: number): number {
    if (threshold <= 1 && value > 1.2) return value / 100;
    return value;
  }

  private thresholdToExpectedPoints(
    value: number,
    maxThreshold: number,
    smallThreshold: number,
    inverse = false,
  ): number {
    const normalizedValue = this.normalizeRate(value, maxThreshold);
    const denominator = Math.max(
      Math.abs(maxThreshold - smallThreshold),
      0.0001,
    );
    const quality = inverse
      ? (smallThreshold - normalizedValue) / denominator
      : (normalizedValue - smallThreshold) / denominator;

    if (quality >= 1) return 4.2;
    if (quality >= 0) return 1.2 + quality * 2.8;
    if (quality >= -1) return -1.4 + (quality + 1) * 2.6;
    return -2;
  }

  private getLeaderExpectedPoints(player: FantasyPlayer): number {
    const teamOutcome = matchupPredictor.getTeamExpectedOutcomeScore(
      player.team,
    );
    const bounded = Math.tanh(teamOutcome);
    return bounded * 2.6 + 1.2;
  }

  private getSkillGate(baseSkillEV: number): number {
    return this.clamp((baseSkillEV - 1.08) / 0.42, 0.15, 1);
  }

  private getRoleExpectedPointsAndRisk(player: FantasyPlayer): {
    roleName: string | null;
    expectedPoints: number;
    downsideRisk: number;
  } {
    const roleCandidates: Array<{
      role: string;
      expected: number;
      risk: number;
    }> = [];

    if (player.stats.awpPerRound >= 0.12) {
      const expected = this.thresholdToExpectedPoints(
        player.stats.awpPerRound,
        0.35,
        0.2,
      );
      roleCandidates.push({
        role: "Main AWP",
        expected,
        risk: this.clamp((2 - expected) / 6, 0, 1),
      });
    }
    if (player.stats.supportRoundsPct >= 14) {
      const expected = this.thresholdToExpectedPoints(
        player.stats.supportRoundsPct,
        25,
        17,
      );
      roleCandidates.push({
        role: "Support",
        expected,
        risk: this.clamp((2 - expected) / 6, 0, 1),
      });
    }
    if (player.stats.tRating >= 0.9) {
      const expected = this.thresholdToExpectedPoints(
        player.stats.tRating,
        1.3,
        0.9,
      );
      roleCandidates.push({
        role: "Attacker",
        expected,
        risk: this.clamp((2 - expected) / 6, 0, 1),
      });
    }
    if (player.stats.rating >= 0.95) {
      const expected = this.thresholdToExpectedPoints(
        player.stats.rating,
        1.3,
        1.0,
      );
      roleCandidates.push({
        role: "Stathunter",
        expected,
        risk: this.clamp((2 - expected) / 6, 0, 1),
      });
    }
    if (this.normalizeRate(player.stats.entryRoundsPct, 0.15) >= 0.06) {
      const expected = this.thresholdToExpectedPoints(
        player.stats.entryRoundsPct,
        0.15,
        0.08,
      );
      roleCandidates.push({
        role: "Entry Fragger",
        expected,
        risk: this.clamp((2 - expected) / 6, 0, 1),
      });
    }
    if (player.stats.deathsPerRound <= 0.75) {
      const expected = this.thresholdToExpectedPoints(
        player.stats.deathsPerRound,
        0.55,
        0.65,
        true,
      );
      roleCandidates.push({
        role: "Camper",
        expected,
        risk: this.clamp((2 - expected) / 6, 0, 1),
      });
    }
    if (player.stats.ctRating >= 0.95) {
      const expected = this.thresholdToExpectedPoints(
        player.stats.ctRating,
        1.35,
        1.0,
      );
      roleCandidates.push({
        role: "Defender",
        expected,
        risk: this.clamp((2 - expected) / 6, 0, 1),
      });
    }
    if (player.stats.headshotPct >= 45) {
      const expected = this.thresholdToExpectedPoints(
        player.stats.headshotPct,
        60,
        50,
      );
      roleCandidates.push({
        role: "HS Machine",
        expected,
        risk: this.clamp((2 - expected) / 6, 0, 1),
      });
    }
    if (this.normalizeRate(player.stats.multiKillRoundsPct, 0.2) >= 0.1) {
      const expected = this.thresholdToExpectedPoints(
        player.stats.multiKillRoundsPct,
        0.2,
        0.14,
      );
      roleCandidates.push({
        role: "Multi Fragger",
        expected,
        risk: this.clamp((2 - expected) / 6, 0, 1),
      });
    }
    if (player.stats.rating <= 1.08) {
      const expected = this.thresholdToExpectedPoints(
        player.stats.rating,
        0.85,
        1.12,
        true,
      );
      roleCandidates.push({
        role: "Noob",
        expected,
        risk: this.clamp((2 - expected) / 6, 0, 1),
      });
    }
    if (player.stats.rating >= 1.0) {
      const expected = this.getLeaderExpectedPoints(player);
      roleCandidates.push({
        role: "Leader",
        expected,
        risk: this.clamp((2.4 - expected) / 7, 0, 1),
      });
    }

    if (roleCandidates.length === 0) {
      return {roleName: null, expectedPoints: 0, downsideRisk: 0.45};
    }

    roleCandidates.sort((a, b) => b.expected - a.expected);
    const best = roleCandidates[0]!;
    const rolePopularity = this.rolePopularityByName.get(best.role) ?? 0.45;
    const popularityBoost = (rolePopularity - 0.5) * 0.2;

    return {
      roleName: best.role,
      expectedPoints: best.expected + popularityBoost,
      downsideRisk: best.risk,
    };
  }

  private getBoosterExpectedPoints(player: FantasyPlayer): number {
    const fragSignal = this.clamp((player.stats.rating - 0.95) / 0.45, 0, 1);
    const entrySignal = this.clamp(
      (this.normalizeRate(player.stats.entryRoundsPct, 0.15) - 0.06) / 0.12,
      0,
      1,
    );
    const supportSignal = this.clamp(
      (player.stats.supportRoundsPct - 14) / 16,
      0,
      1,
    );
    const hsSignal = this.clamp((player.stats.headshotPct - 45) / 20, 0, 1);

    const fragBoosterPopularity =
      (this.boosterPopularityByName.get("Top of scoreboard") ?? 0) * 0.3 +
      (this.boosterPopularityByName.get("Carry") ?? 0) * 0.25 +
      (this.boosterPopularityByName.get("Aim bot") ?? 0) * 0.25 +
      (this.boosterPopularityByName.get("Quad") ?? 0) * 0.2;
    const supportBoosterPopularity =
      (this.boosterPopularityByName.get("Assist") ?? 0) * 0.35 +
      (this.boosterPopularityByName.get("Flash") ?? 0) * 0.25 +
      (this.boosterPopularityByName.get("Avenger") ?? 0) * 0.2 +
      (this.boosterPopularityByName.get("Bait") ?? 0) * 0.2;

    const styleScore =
      fragSignal * 0.5 +
      entrySignal * 0.25 +
      hsSignal * 0.15 +
      supportSignal * 0.1;
    const prior =
      fragSignal >= supportSignal
        ? fragBoosterPopularity
        : supportBoosterPopularity;
    return styleScore * 2.5 + (prior - 0.5) * 0.35;
  }

  private getPlayerProjection(player: FantasyPlayer): PlayerProjection {
    const baseSkillEV = this.getExpectedBaseScore(player);
    const ownership = this.getPlayerOwnership(player);
    const roleModel = this.getRoleExpectedPointsAndRisk(player);

    const skillGate = this.getSkillGate(baseSkillEV);
    const roleEV =
      roleModel.expectedPoints *
      this.runtimeWeights.roleExpected *
      (0.6 + 0.4 * skillGate) *
      (1 - roleModel.downsideRisk * 0.35);
    const boosterEV =
      this.getBoosterExpectedPoints(player) *
      this.runtimeWeights.boosterExpected *
      (0.65 + 0.35 * skillGate);
    const teamOutcomeRaw = matchupPredictor.getTeamExpectedOutcomeScore(
      player.team,
    );
    const boundedTeamOutcome = this.clamp(Math.tanh(teamOutcomeRaw), -0.8, 0.8);
    const teamOutcomeEV =
      boundedTeamOutcome * this.runtimeWeights.teamOutcome * skillGate;
    const leverageEdge = this.clamp(0.45 - ownership, -0.25, 0.25);
    const fieldLeverageEV = leverageEdge * this.runtimeWeights.playerLeverage;
    const isWeakChalk = ownership >= 0.58 && baseSkillEV < 1.18;

    return {
      total: baseSkillEV + roleEV + boosterEV + teamOutcomeEV + fieldLeverageEV,
      baseSkillEV,
      roleEV,
      boosterEV,
      teamOutcomeEV,
      fieldLeverageEV,
      roleName: roleModel.roleName,
      roleExpectedPoints: roleModel.expectedPoints,
      roleDownsideRisk: roleModel.downsideRisk,
      ownership,
      isWeakChalk,
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
    for (
      let i = startIndex;
      i < sortedScores.length && taken < remainingSlots;
      i++
    ) {
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
    weightOverrides?: OptimizerWeightOverrides,
  ): MathLineup[] {
    this.runtimeWeights = this.resolveWeights(weightOverrides);
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
      if (validLineups.length < this.MAX_TRACKED_LINEUPS)
        return Number.NEGATIVE_INFINITY;
      return (
        validLineups[validLineups.length - 1]?.expectedBaseScore ??
        Number.NEGATIVE_INFINITY
      );
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
        if (config.minG2Players !== "Auto" && g2Count < config.minG2Players)
          return;

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
          this.runtimeWeights.matchupRiskPenalty;

        const totalOwnership = selectedPlayers.reduce(
          (sum, p) => sum + this.getPlayerOwnership(p),
          0,
        );
        const avgOwnership = totalOwnership / selectedPlayers.length;
        const lineupLeverageEV =
          this.clamp(0.42 - avgOwnership, -0.18, 0.18) *
          this.runtimeWeights.lineupLeverage;

        let ownershipBandEV = 0;
        if (avgOwnership < this.TARGET_MIN_AVG_OWNERSHIP) {
          ownershipBandEV =
            -(this.TARGET_MIN_AVG_OWNERSHIP - avgOwnership) *
            this.runtimeWeights.ownershipBand *
            3.5;
        } else if (avgOwnership > this.TARGET_MAX_AVG_OWNERSHIP) {
          ownershipBandEV =
            -(avgOwnership - this.TARGET_MAX_AVG_OWNERSHIP) *
            this.runtimeWeights.ownershipBand *
            3.5;
        } else {
          ownershipBandEV = this.runtimeWeights.ownershipBand * 0.1;
        }

        let stackCorrelationEV = 0;
        for (const [team, count] of Object.entries(teamCounts)) {
          if (count <= 1) continue;
          const stackSkill = selectedPlayers
            .filter((p) => p.team === team)
            .reduce(
              (sum, p) => sum + (projectionById.get(p.id)?.baseSkillEV ?? 0),
              0,
            );
          const avgStackSkill = stackSkill / count;
          const stackGate = this.getSkillGate(avgStackSkill);
          stackCorrelationEV +=
            matchupPredictor.getTeamExpectedOutcomeScore(team) *
            (count - 1) *
            this.runtimeWeights.stackCorrelation *
            stackGate;
        }

        const weakChalkCount = selectedPlayers.reduce((sum, player) => {
          const projection = projectionById.get(player.id);
          return sum + (projection?.isWeakChalk ? 1 : 0);
        }, 0);
        const chalkWeakPenalty =
          weakChalkCount * this.runtimeWeights.chalkWeakPenalty;

        const expectedBaseScore =
          componentSums.baseSkillEV +
          componentSums.roleEV +
          componentSums.boosterEV +
          componentSums.teamOutcomeEV +
          componentSums.fieldLeverageEV +
          lineupLeverageEV +
          ownershipBandEV +
          stackCorrelationEV -
          chalkWeakPenalty -
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
            ownershipBandEV,
            stackCorrelationEV,
            chalkWeakPenalty,
            diversityPenalty: 0,
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
          fieldLeverageEV:
            componentSums.fieldLeverageEV + projection.fieldLeverageEV,
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

    const diversified = this.selectDiverseLineups(validLineups);
    const playerById = new Map(
      validPlayers.map((player) => [player.id, player]),
    );
    this.lastDiagnostics = this.buildDiagnostics(
      diversified,
      projectionById,
      playerById,
    );
    return diversified;
  }

  private getOverlapCount(lineupA: MathLineup, lineupB: MathLineup): number {
    const ids = new Set(lineupA.players.map((player) => player.id));
    return lineupB.players.reduce(
      (count, player) => count + (ids.has(player.id) ? 1 : 0),
      0,
    );
  }

  private selectDiverseLineups(lineups: MathLineup[]): MathLineup[] {
    if (lineups.length <= 1) return lineups.slice(0, this.TARGET_RESULTS);
    const sorted = [...lineups].sort(
      (a, b) => b.expectedBaseScore - a.expectedBaseScore,
    );
    const anchor = sorted[0]!;
    const selected: MathLineup[] = [anchor];
    const used = new Set<number>([0]);

    for (
      let i = 1;
      i < sorted.length && selected.length < this.TARGET_RESULTS;
      i++
    ) {
      const candidate = sorted[i];
      if (!candidate) continue;
      const overlapWithAnchor = this.getOverlapCount(anchor, candidate);
      const allowedOverlap = selected.length < 5 ? 3 : 4;
      if (overlapWithAnchor > allowedOverlap) continue;
      selected.push(candidate);
      used.add(i);
    }

    for (
      let i = 1;
      i < sorted.length && selected.length < this.TARGET_RESULTS;
      i++
    ) {
      if (used.has(i)) continue;
      const candidate = sorted[i];
      if (!candidate) continue;
      selected.push(candidate);
    }

    return selected.slice(0, this.TARGET_RESULTS);
  }

  private buildDiagnostics(
    lineups: MathLineup[],
    projectionById: Map<string, PlayerProjection>,
    playerById: Map<string, FantasyPlayer>,
  ): OptimizationDiagnostics {
    const topPlayers = [...projectionById.entries()]
      .map(([playerId, projection]) => {
        const player = playerById.get(playerId);
        return {
          playerId,
          name: player?.name ?? playerId,
          team: player?.team ?? "",
          price: player?.price ?? 0,
          ownership: projection.ownership,
          total: projection.total,
          baseSkillEV: projection.baseSkillEV,
          roleEV: projection.roleEV,
          boosterEV: projection.boosterEV,
          teamOutcomeEV: projection.teamOutcomeEV,
          fieldLeverageEV: projection.fieldLeverageEV,
          roleName: projection.roleName,
          roleExpectedPoints: projection.roleExpectedPoints,
          roleDownsideRisk: projection.roleDownsideRisk,
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);

    const topLineups: LineupScoreDiagnostics[] = lineups
      .slice(0, 5)
      .map((lineup, idx) => {
        const b = lineup.scoringBreakdown ?? {
          baseSkillEV: 0,
          roleEV: 0,
          boosterEV: 0,
          teamOutcomeEV: 0,
          fieldLeverageEV: 0,
          lineupLeverageEV: 0,
          ownershipBandEV: 0,
          stackCorrelationEV: 0,
          chalkWeakPenalty: 0,
          diversityPenalty: 0,
          matchupRiskPenalty: 0,
        };

        const componentMagnitude =
          Math.abs(b.baseSkillEV) +
          Math.abs(b.roleEV) +
          Math.abs(b.boosterEV) +
          Math.abs(b.teamOutcomeEV) +
          Math.abs(b.fieldLeverageEV) +
          Math.abs(b.lineupLeverageEV) +
          Math.abs(b.ownershipBandEV) +
          Math.abs(b.stackCorrelationEV) +
          Math.abs(b.chalkWeakPenalty) +
          Math.abs(b.matchupRiskPenalty) +
          0.0001;

        const sharesPct: Record<string, number> = {
          baseSkill: (Math.abs(b.baseSkillEV) / componentMagnitude) * 100,
          role: (Math.abs(b.roleEV) / componentMagnitude) * 100,
          booster: (Math.abs(b.boosterEV) / componentMagnitude) * 100,
          teamOutcome: (Math.abs(b.teamOutcomeEV) / componentMagnitude) * 100,
          playerLeverage:
            (Math.abs(b.fieldLeverageEV) / componentMagnitude) * 100,
          lineupLeverage:
            (Math.abs(b.lineupLeverageEV) / componentMagnitude) * 100,
          ownershipBand:
            (Math.abs(b.ownershipBandEV) / componentMagnitude) * 100,
          stackCorrelation:
            (Math.abs(b.stackCorrelationEV) / componentMagnitude) * 100,
          chalkWeakPenalty:
            (Math.abs(b.chalkWeakPenalty) / componentMagnitude) * 100,
          matchupRisk:
            (Math.abs(b.matchupRiskPenalty) / componentMagnitude) * 100,
        };

        return {
          rank: idx + 1,
          playerNames: lineup.players.map((player) => player.name),
          totalScore: lineup.expectedBaseScore,
          breakdown: b,
          sharesPct,
        };
      });

    return {
      topPlayers,
      topLineups,
    };
  }

  getLatestDiagnostics(): OptimizationDiagnostics {
    return this.lastDiagnostics;
  }
}

export const mathOptimizer = new MathOptimizer();
