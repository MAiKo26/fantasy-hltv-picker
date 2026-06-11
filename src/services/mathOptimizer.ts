import type {
  FantasyPlayer,
  FantasyTeam,
  Strategy,
  FantasyConfig,
} from "../types/player.ts";
import {env} from "../env.ts";
import {normalizePlayerName, normalizeTeamName} from "../utils/normalize.ts";

interface ScoreWeights {
  cardRatingBenefit: number;
  historicalTop10RatingBenefit: number;
  historicalTop20RatingBenefit: number;
  historicalTop30RatingBenefit: number;
  historicalTop50RatingBenefit: number;
  topTeamRankBenefit: number;
  awperRoleBenefit: number;
  lowDeathRateBenefit: number;
  ctVsTRatingImbalancePenalty: number;
  stackCorrelationBenefit: number;
  topRankedTeamStackBenefit: number;
  awpPerRoundWeight: number;
  deathPenaltyWeight: number;
  priceEfficiencyBenefit: number;
}

const PRICE_EFFICIENCY_ANCHOR = 200000;

interface ScoreThresholds {
  awperRoleMinAwpPerRound: number;
  lowDeathRateMaxDeathsPerRound: number;
}

export type OptimizerWeightOverrides = Partial<ScoreWeights>;
export type OptimizerThresholdOverrides = Partial<ScoreThresholds>;

export interface MathLineup {
  players: FantasyPlayer[];
  totalPrice: number;
  expectedBaseScore: number;
  strategyUsed: Strategy;
  scoringBreakdown?: {
    baseSkillEV: number;
    stackCorrelationEV: number;
    stackRankBonus: number;
  };
}

interface PlayerProjection {
  total: number;
  baseSkillEV: number;
}

export interface PlayerScoreDiagnostics {
  playerId: string;
  name: string;
  team: string;
  price: number;
  total: number;
  baseSkillEV: number;
  cardRating: number;
  cardRatingWeight: number;
  historicalTop10Rating: number | null;
  historicalTop10RatingWeight: number;
  historicalTop20Rating: number | null;
  historicalTop20RatingWeight: number;
  historicalTop30Rating: number | null;
  historicalTop30RatingWeight: number;
  historicalTop50Rating: number | null;
  historicalTop50RatingWeight: number;
  availableRatingCount: number;
  combinedRatingContribution: number;
  topTeamRankBenefit: number;
  awperRoleBenefit: number;
  lowDeathRateBenefit: number;
  ctVsTRatingImbalancePenalty: number;
  awpPerRoundWeight: number;
  awpPerRoundContribution: number;
  deathPenaltyWeight: number;
  deathPenaltyContribution: number;
  priceEfficiencyBenefit: number;
  priceEfficiencyContribution: number;
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

// 0.25 step
const DEFAULT_WEIGHTS: ScoreWeights = {
  historicalTop10RatingBenefit: 1.75,
  historicalTop20RatingBenefit: 1.25,
  historicalTop30RatingBenefit: 1,
  historicalTop50RatingBenefit: 0.75,
  cardRatingBenefit: 0.25,
  topTeamRankBenefit: 0.5,
  ctVsTRatingImbalancePenalty: 0.75,
  awperRoleBenefit: 0,
  lowDeathRateBenefit: 0,

  // applies to assembling the team
  stackCorrelationBenefit: 0.5,
  topRankedTeamStackBenefit: 0.75,

  // v5 additions: continuous signals (default 0 = backward-compatible)
  awpPerRoundWeight: 0,
  deathPenaltyWeight: 0,
  priceEfficiencyBenefit: 0,
};

const DEFAULT_THRESHOLDS: ScoreThresholds = {
  awperRoleMinAwpPerRound: 0.25,
  lowDeathRateMaxDeathsPerRound: 0.6,
};

function resolveWeights(overrides?: OptimizerWeightOverrides): ScoreWeights {
  const envWeights: Partial<ScoreWeights> = {};
  if (env.WEIGHT_CARD_RATING_BENEFIT != null)
    envWeights.cardRatingBenefit = env.WEIGHT_CARD_RATING_BENEFIT;
  if (env.WEIGHT_HISTORICAL_TOP10_RATING_BENEFIT != null)
    envWeights.historicalTop10RatingBenefit =
      env.WEIGHT_HISTORICAL_TOP10_RATING_BENEFIT;
  if (env.WEIGHT_HISTORICAL_TOP20_RATING_BENEFIT != null)
    envWeights.historicalTop20RatingBenefit =
      env.WEIGHT_HISTORICAL_TOP20_RATING_BENEFIT;
  if (env.WEIGHT_HISTORICAL_TOP30_RATING_BENEFIT != null)
    envWeights.historicalTop30RatingBenefit =
      env.WEIGHT_HISTORICAL_TOP30_RATING_BENEFIT;
  if (env.WEIGHT_HISTORICAL_TOP50_RATING_BENEFIT != null)
    envWeights.historicalTop50RatingBenefit =
      env.WEIGHT_HISTORICAL_TOP50_RATING_BENEFIT;
  if (env.WEIGHT_TOP_TEAM_RANK_BENEFIT != null)
    envWeights.topTeamRankBenefit = env.WEIGHT_TOP_TEAM_RANK_BENEFIT;
  if (env.WEIGHT_AWPER_ROLE_BENEFIT != null)
    envWeights.awperRoleBenefit = env.WEIGHT_AWPER_ROLE_BENEFIT;
  if (env.WEIGHT_LOW_DEATH_RATE_BENEFIT != null)
    envWeights.lowDeathRateBenefit = env.WEIGHT_LOW_DEATH_RATE_BENEFIT;
  if (env.WEIGHT_CT_VS_T_RATING_IMBALANCE_PENALTY != null)
    envWeights.ctVsTRatingImbalancePenalty =
      env.WEIGHT_CT_VS_T_RATING_IMBALANCE_PENALTY;
  if (env.WEIGHT_STACK_CORRELATION_BENEFIT != null)
    envWeights.stackCorrelationBenefit = env.WEIGHT_STACK_CORRELATION_BENEFIT;
  if (env.WEIGHT_TOP_RANKED_TEAM_STACK_BENEFIT != null)
    envWeights.topRankedTeamStackBenefit =
      env.WEIGHT_TOP_RANKED_TEAM_STACK_BENEFIT;
  if (env.WEIGHT_AWP_PER_ROUND_WEIGHT != null)
    envWeights.awpPerRoundWeight = env.WEIGHT_AWP_PER_ROUND_WEIGHT;
  if (env.WEIGHT_DEATH_PENALTY_WEIGHT != null)
    envWeights.deathPenaltyWeight = env.WEIGHT_DEATH_PENALTY_WEIGHT;
  if (env.WEIGHT_PRICE_EFFICIENCY_BENEFIT != null)
    envWeights.priceEfficiencyBenefit = env.WEIGHT_PRICE_EFFICIENCY_BENEFIT;

  return {
    ...DEFAULT_WEIGHTS,
    ...envWeights,
    ...(overrides ?? {}),
  };
}

function resolveThresholds(
  overrides?: OptimizerThresholdOverrides,
): ScoreThresholds {
  const envThresholds: Partial<ScoreThresholds> = {};
  if (env.THRESHOLD_AWPER_ROLE_MIN_AWP_PER_ROUND != null)
    envThresholds.awperRoleMinAwpPerRound =
      env.THRESHOLD_AWPER_ROLE_MIN_AWP_PER_ROUND;
  if (env.THRESHOLD_LOW_DEATH_RATE_MAX_DEATHS_PER_ROUND != null)
    envThresholds.lowDeathRateMaxDeathsPerRound =
      env.THRESHOLD_LOW_DEATH_RATE_MAX_DEATHS_PER_ROUND;

  return {
    ...DEFAULT_THRESHOLDS,
    ...envThresholds,
    ...(overrides ?? {}),
  };
}

export class MathOptimizer {
  private readonly MAX_BUDGET = 1000000;
  private readonly MAX_PLAYER_PRICE = 251000;
  private readonly TARGET_RESULTS = 50;
  private readonly CANDIDATE_POOL_LIMIT = 65;
  private readonly TEAM_CANDIDATES_LIMIT = 4;
  private readonly MAX_TRACKED_LINEUPS = 50;

  private teamRankings: Map<string, number> = new Map();
  private teamRankMin = 0;
  private teamRankMax = 0;
  private runtimeWeights: ScoreWeights = DEFAULT_WEIGHTS;
  private runtimeThresholds: ScoreThresholds = DEFAULT_THRESHOLDS;
  private effectiveTargetResults = 50;
  private lastDiagnostics: OptimizationDiagnostics = {
    topPlayers: [],
    topLineups: [],
  };

  setTeams(teams: FantasyTeam[]): void {
    this.teamRankings.clear();
    let min = Infinity;
    let max = -Infinity;
    for (const team of teams) {
      const rank = team.worldRank;
      this.teamRankings.set(normalizeTeamName(team.name), rank);
      if (rank > 0) {
        if (rank < min) min = rank;
        if (rank > max) max = rank;
      }
    }
    this.teamRankMin = min === Infinity ? 0 : min;
    this.teamRankMax = max === -Infinity ? 0 : max;
  }

  private getFieldRelativeRankBonus(teamRank: number): number {
    if (teamRank <= 0) return 0;
    const range = this.teamRankMax - this.teamRankMin;
    if (range <= 0) return Math.log(2);
    const relative = 1 - (teamRank - this.teamRankMin) / range;
    return Math.log(1 + relative);
  }

  private getAvailableRatingCount(player: FantasyPlayer): number {
    let count = 0;
    if (player.stats.rating > 0) count++;
    if (player.stats.rating12mTop10 != null) count++;
    if (player.stats.rating12mTop20 != null) count++;
    if (player.stats.rating12mTop30 != null) count++;
    if (player.stats.rating12mTop50 != null) count++;
    return count;
  }

  private getCombinedRatingContribution(player: FantasyPlayer): number {
    const stats = player.stats;
    const weights = this.runtimeWeights;
    const numerator =
      stats.rating * weights.cardRatingBenefit +
      (stats.rating12mTop10 ?? 0) * weights.historicalTop10RatingBenefit +
      (stats.rating12mTop20 ?? 0) * weights.historicalTop20RatingBenefit +
      (stats.rating12mTop30 ?? 0) * weights.historicalTop30RatingBenefit +
      (stats.rating12mTop50 ?? 0) * weights.historicalTop50RatingBenefit;
    const count = this.getAvailableRatingCount(player);
    return count > 0 ? numerator / count : 0;
  }

  getExpectedBaseScore(player: FantasyPlayer): number {
    const teamRank = this.teamRankings.get(normalizeTeamName(player.team));

    let score = this.getCombinedRatingContribution(player);

    if (teamRank) {
      score +=
        this.getFieldRelativeRankBonus(teamRank) *
        this.runtimeWeights.topTeamRankBenefit;
    }

    if (
      player.stats.awpPerRound >= this.runtimeThresholds.awperRoleMinAwpPerRound
    ) {
      score += this.runtimeWeights.awperRoleBenefit;
    }

    if (
      player.stats.deathsPerRound <=
      this.runtimeThresholds.lowDeathRateMaxDeathsPerRound
    ) {
      score += this.runtimeWeights.lowDeathRateBenefit;
    }

    const sideVariance = Math.abs(player.stats.ctRating - player.stats.tRating);
    score -= sideVariance * this.runtimeWeights.ctVsTRatingImbalancePenalty;

    score += player.stats.awpPerRound * this.runtimeWeights.awpPerRoundWeight;
    score -=
      player.stats.deathsPerRound * this.runtimeWeights.deathPenaltyWeight;
    if (player.price > 0) {
      const priceRatio = player.price / PRICE_EFFICIENCY_ANCHOR;
      const efficiency = player.stats.rating / priceRatio;
      score += efficiency * this.runtimeWeights.priceEfficiencyBenefit;
    }

    return score;
  }

  private getPlayerProjection(player: FantasyPlayer): PlayerProjection {
    const baseSkillEV = this.getExpectedBaseScore(player);

    return {
      total: baseSkillEV,
      baseSkillEV,
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
    weightOverrides?: OptimizerWeightOverrides,
    thresholdOverrides?: OptimizerThresholdOverrides,
  ): MathLineup[] {
    this.runtimeWeights = resolveWeights(weightOverrides);
    this.runtimeThresholds = resolveThresholds(thresholdOverrides);
    this.effectiveTargetResults = config.lineupLimit ?? this.TARGET_RESULTS;
    this.setTeams(teams);

    const targetStrategies: Strategy[] =
      config.strategy === "Auto"
        ? ["2-2-1", "2-1-1-1", "1-1-1-1-1"]
        : [config.strategy];

    const blacklist = new Set(
      env.BLACKLISTED_PLAYERS.map((name) => normalizePlayerName(name)),
    );
    const excludedTeams = new Set(
      (config.excludedTeams ?? []).map((name) => normalizeTeamName(name)),
    );
    const validPlayers = players.filter(
      (p) =>
        p.price <= this.MAX_PLAYER_PRICE &&
        !blacklist.has(normalizePlayerName(p.name)) &&
        !excludedTeams.has(normalizeTeamName(p.team)),
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
      const maxTracked = Math.max(this.MAX_TRACKED_LINEUPS, this.effectiveTargetResults);
      if (validLineups.length > maxTracked) {
        validLineups.length = maxTracked;
      }
    };

    const getCutoffScore = () => {
      const maxTracked = Math.max(this.MAX_TRACKED_LINEUPS, this.effectiveTargetResults);
      if (validLineups.length < maxTracked)
        return Number.NEGATIVE_INFINITY;
      return (
        validLineups[validLineups.length - 1]?.expectedBaseScore ??
        Number.NEGATIVE_INFINITY
      );
    };

    const forcedTeamNormalized = config.forcedTeam
      ? normalizeTeamName(config.forcedTeam.name)
      : null;

    const search = (
      startIndex: number,
      totalPrice: number,
      forcedTeamCount: number,
      componentSums: {
        baseSkillEV: number;
      },
    ) => {
      const remainingSlots = 5 - selectedPlayers.length;
      if (remainingSlots === 0) {
        if (totalPrice > this.MAX_BUDGET) return;
        if (
          config.forcedTeam &&
          config.forcedTeam.minPlayers !== "Auto" &&
          forcedTeamCount < config.forcedTeam.minPlayers
        )
          return;

        let strategyUsed: Strategy | null = null;
        for (const strategy of targetStrategies) {
          if (this.isValidStrategy(teamCounts, strategy)) {
            strategyUsed = strategy;
            break;
          }
        }
        if (!strategyUsed) return;

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
          stackCorrelationEV +=
            avgStackSkill *
            (count - 1) *
            this.runtimeWeights.stackCorrelationBenefit;
        }

        let stackRankBonus = 0;
        if (strategyUsed === "2-2-1") {
          const stackTeams = Object.entries(teamCounts)
            .filter(([, count]) => count === 2)
            .map(([team]) => team);
          let totalRankBonus = 0;
          let rankCount = 0;
          for (const team of stackTeams) {
            const rank = this.teamRankings.get(normalizeTeamName(team));
            if (rank) {
              totalRankBonus += this.getFieldRelativeRankBonus(rank);
              rankCount++;
            }
          }
          if (rankCount > 0) {
            stackRankBonus =
              (totalRankBonus / rankCount) *
              this.runtimeWeights.topRankedTeamStackBenefit;
          }
        }

        const expectedBaseScore =
          componentSums.baseSkillEV + stackCorrelationEV + stackRankBonus;

        addLineup({
          players: [...selectedPlayers],
          totalPrice,
          expectedBaseScore,
          strategyUsed,
          scoringBreakdown: {
            baseSkillEV: componentSums.baseSkillEV,
            stackCorrelationEV,
            stackRankBonus,
          },
        });
        return;
      }

      if (pool.length - startIndex < remainingSlots) return;

      const optimisticUpperBound =
        componentSums.baseSkillEV +
        this.getOptimisticUpperBound(sortedScores, startIndex, remainingSlots) +
        1.5;

      if (optimisticUpperBound <= getCutoffScore()) return;

      for (let i = startIndex; i < pool.length; i++) {
        const player = pool[i];
        if (!player) continue;

        if (totalPrice + player.price > this.MAX_BUDGET) continue;

        const teamCount = teamCounts[player.team] ?? 0;
        if (teamCount >= 2) continue;

        const isForcedTeamPlayer =
          forcedTeamNormalized != null &&
          normalizeTeamName(player.team) === forcedTeamNormalized;
        const nextForcedTeamCount =
          forcedTeamCount + (isForcedTeamPlayer ? 1 : 0);
        if (
          config.forcedTeam &&
          config.forcedTeam.minPlayers !== "Auto" &&
          nextForcedTeamCount + (remainingSlots - 1) <
            config.forcedTeam.minPlayers
        ) {
          continue;
        }

        const projection = projectionById.get(player.id);
        if (!projection) continue;

        selectedPlayers.push(player);
        teamCounts[player.team] = teamCount + 1;

        search(i + 1, totalPrice + player.price, nextForcedTeamCount, {
          baseSkillEV: componentSums.baseSkillEV + projection.baseSkillEV,
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
    if (lineups.length <= 1) return lineups.slice(0, this.effectiveTargetResults);
    const sorted = [...lineups].sort(
      (a, b) => b.expectedBaseScore - a.expectedBaseScore,
    );
    const anchor = sorted[0]!;
    const selected: MathLineup[] = [anchor];
    const used = new Set<number>([0]);

    for (
      let i = 1;
      i < sorted.length && selected.length < this.effectiveTargetResults;
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
      i < sorted.length && selected.length < this.effectiveTargetResults;
      i++
    ) {
      if (used.has(i)) continue;
      const candidate = sorted[i];
      if (!candidate) continue;
      selected.push(candidate);
    }

    return selected.slice(0, this.effectiveTargetResults);
  }

  private buildDiagnostics(
    lineups: MathLineup[],
    projectionById: Map<string, PlayerProjection>,
    playerById: Map<FantasyPlayer["id"], FantasyPlayer>,
  ): OptimizationDiagnostics {
    const topPlayers = [...projectionById.entries()]
      .map(([playerId, projection]) => {
        const player = playerById.get(playerId);
        const teamRank = player
          ? this.teamRankings.get(normalizeTeamName(player.team))
          : undefined;
        const sideVariance = player
          ? Math.abs(player.stats.ctRating - player.stats.tRating)
          : 0;
        const awpPerRound = player?.stats.awpPerRound ?? 0;
        const deathsPerRound = player?.stats.deathsPerRound ?? 0;
        const priceRatio =
          player && player.price > 0
            ? player.price / PRICE_EFFICIENCY_ANCHOR
            : 0;
        const efficiencyTrait =
          player && priceRatio > 0
            ? (player.stats.rating ?? 0) / priceRatio
            : 0;
        return {
          playerId,
          name: player?.name ?? playerId,
          team: player?.team ?? "",
          price: player?.price ?? 0,
          total: projection.total,
          baseSkillEV: projection.baseSkillEV,
          cardRating: player?.stats.rating ?? 0,
          cardRatingWeight: this.runtimeWeights.cardRatingBenefit,
          historicalTop10Rating: player?.stats.rating12mTop10 ?? null,
          historicalTop10RatingWeight:
            this.runtimeWeights.historicalTop10RatingBenefit,
          historicalTop20Rating: player?.stats.rating12mTop20 ?? null,
          historicalTop20RatingWeight:
            this.runtimeWeights.historicalTop20RatingBenefit,
          historicalTop30Rating: player?.stats.rating12mTop30 ?? null,
          historicalTop30RatingWeight:
            this.runtimeWeights.historicalTop30RatingBenefit,
          historicalTop50Rating: player?.stats.rating12mTop50 ?? null,
          historicalTop50RatingWeight:
            this.runtimeWeights.historicalTop50RatingBenefit,
          availableRatingCount: player
            ? this.getAvailableRatingCount(player)
            : 0,
          combinedRatingContribution: player
            ? this.getCombinedRatingContribution(player)
            : 0,
          topTeamRankBenefit: teamRank
            ? this.getFieldRelativeRankBonus(teamRank) *
              this.runtimeWeights.topTeamRankBenefit
            : 0,
          awperRoleBenefit:
            player &&
            player.stats.awpPerRound >=
              this.runtimeThresholds.awperRoleMinAwpPerRound
              ? this.runtimeWeights.awperRoleBenefit
              : 0,
          lowDeathRateBenefit:
            player &&
            player.stats.deathsPerRound <=
              this.runtimeThresholds.lowDeathRateMaxDeathsPerRound
              ? this.runtimeWeights.lowDeathRateBenefit
              : 0,
          ctVsTRatingImbalancePenalty:
            sideVariance * this.runtimeWeights.ctVsTRatingImbalancePenalty,
          awpPerRoundWeight: this.runtimeWeights.awpPerRoundWeight,
          awpPerRoundContribution:
            awpPerRound * this.runtimeWeights.awpPerRoundWeight,
          deathPenaltyWeight: this.runtimeWeights.deathPenaltyWeight,
          deathPenaltyContribution:
            deathsPerRound * this.runtimeWeights.deathPenaltyWeight,
          priceEfficiencyBenefit: this.runtimeWeights.priceEfficiencyBenefit,
          priceEfficiencyContribution:
            efficiencyTrait * this.runtimeWeights.priceEfficiencyBenefit,
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 100);

    const topLineups: LineupScoreDiagnostics[] = lineups
      .slice(0, 5)
      .map((lineup, idx) => {
        const b = lineup.scoringBreakdown ?? {
          baseSkillEV: 0,
          stackCorrelationEV: 0,
          stackRankBonus: 0,
        };

        const componentMagnitude =
          Math.abs(b.baseSkillEV) +
          Math.abs(b.stackCorrelationEV) +
          Math.abs(b.stackRankBonus) +
          0.0001;

        const sharesPct: Record<string, number> = {
          baseSkill: (Math.abs(b.baseSkillEV) / componentMagnitude) * 100,
          stackCorrelation:
            (Math.abs(b.stackCorrelationEV) / componentMagnitude) * 100,
          stackRankBonus:
            (Math.abs(b.stackRankBonus) / componentMagnitude) * 100,
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

  getPlayerTraitVector(player: FantasyPlayer): {
    traits: Record<keyof ScoreWeights, number>;
  } {
    const teamRank = this.teamRankings.get(normalizeTeamName(player.team));
    const sideVariance = Math.abs(player.stats.ctRating - player.stats.tRating);
    const priceRatio =
      player.price > 0 ? player.price / PRICE_EFFICIENCY_ANCHOR : 0;
    const efficiencyTrait =
      priceRatio > 0 ? player.stats.rating / priceRatio : 0;

    return {
      traits: {
        cardRatingBenefit: player.stats.rating,
        historicalTop10RatingBenefit: player.stats.rating12mTop10 ?? 0,
        historicalTop20RatingBenefit: player.stats.rating12mTop20 ?? 0,
        historicalTop30RatingBenefit: player.stats.rating12mTop30 ?? 0,
        historicalTop50RatingBenefit: player.stats.rating12mTop50 ?? 0,
        topTeamRankBenefit: teamRank
          ? this.getFieldRelativeRankBonus(teamRank)
          : 0,
        awperRoleBenefit:
          player.stats.awpPerRound >=
          this.runtimeThresholds.awperRoleMinAwpPerRound
            ? 1
            : 0,
        lowDeathRateBenefit:
          player.stats.deathsPerRound <=
          this.runtimeThresholds.lowDeathRateMaxDeathsPerRound
            ? 1
            : 0,
        ctVsTRatingImbalancePenalty: -sideVariance,
        stackCorrelationBenefit: 0,
        topRankedTeamStackBenefit: 0,
        awpPerRoundWeight: player.stats.awpPerRound,
        deathPenaltyWeight: -player.stats.deathsPerRound,
        priceEfficiencyBenefit: efficiencyTrait,
      },
    };
  }
}

export const mathOptimizer = new MathOptimizer();
