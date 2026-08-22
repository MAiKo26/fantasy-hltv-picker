import type {
  FantasyPlayer,
  FantasyTeam,
  Strategy,
  FantasyConfig,
} from "../types/player.ts";
import {env} from "../env.ts";
import {normalizePlayerName, normalizeTeamName} from "../utils/normalize.ts";
import {toFieldSplitRuntime} from "../types/fieldSplit.ts";
import type {FieldSplitRuntime} from "../types/fieldSplit.ts";
import {
  HISTORICAL_SOURCES,
  type HistoricalSourceKey,
} from "./historicalSources.ts";
import {
  computeShrunkRatings,
  computeDataConfidence,
  computeFormVolatility,
  DEFAULT_SHRINKAGE,
  type ShrinkageOptions,
} from "./shrinkage.ts";

export type HistWeightKey = `hist_${HistoricalSourceKey}`;

export type PlayerWeightKey =
  | "cardRatingBenefit"
  | HistWeightKey
  | "topTeamRankBenefit"
  | "awperRoleBenefit"
  | "lowDeathRateBenefit"
  | "ctVsTRatingImbalancePenalty"
  | "awpPerRoundWeight"
  | "deathPenaltyWeight"
  | "priceEfficiencyBenefit";

export type LineupWeightKey =
  | "stackCorrelationBenefit"
  | "topRankedTeamStackBenefit"
  | "fieldSide3PlayerPenalty"
  | "fieldSide4PlusPlayerPenalty"
  | "fieldSideCrossTeamPenalty";

export type WeightKey = PlayerWeightKey | LineupWeightKey;

export type ScoreWeights = Record<WeightKey, number>;

export type OptimizerWeightOverrides = Partial<ScoreWeights>;
export type OptimizerThresholdOverrides = Partial<ScoreThresholds>;

const PRICE_EFFICIENCY_ANCHOR = 200000;

/** Typical std-dev of a player's event rating around their projection. */
const BASE_SIGMA = 0.1;
/** Extra σ per unit of cross-window form volatility. */
const VOLATILITY_SIGMA_SCALE = 0.9;
/** Extra σ when historical data is thin (confidence ∈ [0,1]). */
const THIN_DATA_SIGMA_SCALE = 0.08;
/** Share of a teammate's team-level shock that bleeds into a player's score. */
export const TEAM_CORRELATION = 0.3;

interface ScoreThresholds {
  awperRoleMinAwpPerRound: number;
  lowDeathRateMaxDeathsPerRound: number;
}

function buildDefaultWeights(): ScoreWeights {
  const weights = {
    cardRatingBenefit: 0.25,
    topTeamRankBenefit: 0.5,
    awperRoleBenefit: 0,
    lowDeathRateBenefit: 0,
    ctVsTRatingImbalancePenalty: 0.5,
    awpPerRoundWeight: 0,
    deathPenaltyWeight: 0,
    priceEfficiencyBenefit: 0,

    stackCorrelationBenefit: 0.5,
    topRankedTeamStackBenefit: 0.75,

    fieldSide3PlayerPenalty: 0.5,
    fieldSide4PlusPlayerPenalty: 0.75,
    fieldSideCrossTeamPenalty: 0.25,
  } as ScoreWeights;
  for (const source of HISTORICAL_SOURCES) {
    weights[`hist_${source.key}`] = source.defaultWeight;
  }
  return weights;
}

const DEFAULT_WEIGHTS: ScoreWeights = buildDefaultWeights();

const DEFAULT_THRESHOLDS: ScoreThresholds = {
  awperRoleMinAwpPerRound: 0.25,
  lowDeathRateMaxDeathsPerRound: 0.6,
};

const STATIC_ENV_KEYS: Partial<Record<WeightKey, string>> = {
  cardRatingBenefit: "WEIGHT_CARD_RATING_BENEFIT",
  topTeamRankBenefit: "WEIGHT_TOP_TEAM_RANK_BENEFIT",
  awperRoleBenefit: "WEIGHT_AWPER_ROLE_BENEFIT",
  lowDeathRateBenefit: "WEIGHT_LOW_DEATH_RATE_BENEFIT",
  ctVsTRatingImbalancePenalty: "WEIGHT_CT_VS_T_RATING_IMBALANCE_PENALTY",
  stackCorrelationBenefit: "WEIGHT_STACK_CORRELATION_BENEFIT",
  topRankedTeamStackBenefit: "WEIGHT_TOP_RANKED_TEAM_STACK_BENEFIT",
  awpPerRoundWeight: "WEIGHT_AWP_PER_ROUND_WEIGHT",
  deathPenaltyWeight: "WEIGHT_DEATH_PENALTY_WEIGHT",
  priceEfficiencyBenefit: "WEIGHT_PRICE_EFFICIENCY_BENEFIT",
  fieldSide3PlayerPenalty: "WEIGHT_FIELD_SIDE_3_PLAYER_PENALTY",
  fieldSide4PlusPlayerPenalty: "WEIGHT_FIELD_SIDE_4PLUS_PLAYER_PENALTY",
  fieldSideCrossTeamPenalty: "WEIGHT_FIELD_SIDE_CROSS_TEAM_PENALTY",
};

function envValueFor(key: WeightKey): number | undefined {
  if (key.startsWith("hist_")) {
    const sourceKey = key.slice("hist_".length) as HistoricalSourceKey;
    const def = HISTORICAL_SOURCES.find((s) => s.key === sourceKey);
    if (!def) return undefined;
    return env.HIST_WEIGHT_OVERRIDES[def.envVar];
  }
  const envKey = STATIC_ENV_KEYS[key];
  return envKey
    ? ((env as unknown as Record<string, number | undefined>)[envKey])
    : undefined;
}

export function resolveWeights(
  overrides?: OptimizerWeightOverrides,
): ScoreWeights {
  const resolved = {...DEFAULT_WEIGHTS};
  for (const key of Object.keys(resolved) as WeightKey[]) {
    const envVal = envValueFor(key);
    if (envVal != null) resolved[key] = envVal;
  }
  return {...resolved, ...(overrides ?? {})};
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

export interface MathLineup {
  players: FantasyPlayer[];
  totalPrice: number;
  expectedBaseScore: number;
  strategyUsed: Strategy;
  scoringBreakdown?: {
    baseSkillEV: number;
    stackCorrelationEV: number;
    stackRankBonus: number;
    fieldSidePenaltyEV: number;
  };
}

interface PlayerProjection {
  total: number;
  baseSkillEV: number;
  sigma: number;
}

export interface ScoreComponent {
  key: string;
  label: string;
  value: number;
  weight: number;
  contribution: number;
}

export interface PlayerScoreDiagnostics {
  playerId: string;
  name: string;
  team: string;
  price: number;
  total: number;
  baseSkillEV: number;
  sigma: number;
  dataConfidence: number;
  formVolatility: number;
  components: ScoreComponent[];
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
  private readonly MAX_PLAYER_PRICE = 251000;
  private readonly TARGET_RESULTS = 50;
  private readonly CANDIDATE_POOL_LIMIT = 80;
  private readonly TEAM_CANDIDATES_LIMIT = 4;
  private readonly VALUE_TIER_COUNT = 2;
  private readonly PRICE_BUCKET_COUNT = 5;
  private readonly MAX_TRACKED_LINEUPS = 50;

  private teamRankings: Map<string, number> = new Map();
  private teamRankMin = 0;
  private teamRankMax = 0;
  private runtimeWeights: ScoreWeights = DEFAULT_WEIGHTS;
  private runtimeThresholds: ScoreThresholds = DEFAULT_THRESHOLDS;
  private runtimeShrinkage: ShrinkageOptions = {...DEFAULT_SHRINKAGE};
  private fieldSplitRuntime: FieldSplitRuntime | null = null;
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

  setShrinkage(options: Partial<ShrinkageOptions>): void {
    this.runtimeShrinkage = {...this.runtimeShrinkage, ...options};
  }

  private getFieldRelativeRankBonus(teamRank: number): number {
    if (teamRank <= 0) return 0;
    const range = this.teamRankMax - this.teamRankMin;
    if (range <= 0) return Math.log(2);
    const relative = 1 - (teamRank - this.teamRankMin) / range;
    return Math.log(1 + relative);
  }

  getShrunkRatings(
    player: FantasyPlayer,
  ): Partial<Record<HistoricalSourceKey, number>> {
    const shrinkageFromEnv = env.SHRINKAGE;
    const options: ShrinkageOptions = {
      enabled:
        this.runtimeShrinkage.enabled && shrinkageFromEnv.enabled !== false,
      leaguePrior:
        this.runtimeShrinkage.leaguePrior ?? shrinkageFromEnv.leaguePrior ?? 1.06,
      strength:
        this.runtimeShrinkage.strength ?? shrinkageFromEnv.strength ?? 1,
    };
    return computeShrunkRatings(player, options);
  }

  private getAvailableRatingCount(shrunk: Partial<Record<HistoricalSourceKey, number>>): number {
    return Object.values(shrunk).filter((v) => v != null).length;
  }

  private getCombinedRatingContribution(
    shrunk: Partial<Record<HistoricalSourceKey, number>>,
  ): number {
    const weights = this.runtimeWeights;
    let numerator = 0;
    for (const source of HISTORICAL_SOURCES) {
      const rating = shrunk[source.key];
      if (rating == null) continue;
      numerator += rating * weights[`hist_${source.key}`];
    }
    const count = this.getAvailableRatingCount(shrunk);
    return count > 0 ? numerator / count : 0;
  }

  /** Per-player σ used by the contest simulator. */
  getPlayerSigma(player: FantasyPlayer): number {
    const shrunk = this.getShrunkRatings(player);
    const volatility = computeFormVolatility(shrunk);
    const confidence = computeDataConfidence(player);
    return (
      BASE_SIGMA +
      VOLATILITY_SIGMA_SCALE * Math.min(volatility, 0.12) +
      THIN_DATA_SIGMA_SCALE * (1 - confidence)
    );
  }

  getDataConfidence(player: FantasyPlayer): number {
    return computeDataConfidence(player);
  }

  /**
   * Trait vector: the per-player feature values multiplied by their weight keys.
   * Used by backtest scripts to re-score players without re-running extraction.
   */
  getTraitVector(
    player: FantasyPlayer,
  ): {traits: Record<PlayerWeightKey, number>} {
    const teamRank = this.teamRankings.get(normalizeTeamName(player.team));
    const shrunk = this.getShrunkRatings(player);
    const sideVariance = Math.abs(player.stats.ctRating - player.stats.tRating);
    const priceRatio =
      player.price > 0 ? player.price / PRICE_EFFICIENCY_ANCHOR : 0;
    const efficiencyTrait =
      priceRatio > 0 ? player.stats.rating / priceRatio : 0;

    const traits = {} as Record<PlayerWeightKey, number>;
    traits.cardRatingBenefit = player.stats.rating;
    for (const source of HISTORICAL_SOURCES) {
      traits[`hist_${source.key}`] = shrunk[source.key] ?? 0;
    }
    traits.topTeamRankBenefit = teamRank
      ? this.getFieldRelativeRankBonus(teamRank)
      : 0;
    traits.awperRoleBenefit =
      player.stats.awpPerRound >=
      this.runtimeThresholds.awperRoleMinAwpPerRound
        ? 1
        : 0;
    traits.lowDeathRateBenefit =
      player.stats.deathsPerRound <=
      this.runtimeThresholds.lowDeathRateMaxDeathsPerRound
        ? 1
        : 0;
    traits.ctVsTRatingImbalancePenalty = -sideVariance;
    traits.awpPerRoundWeight = player.stats.awpPerRound;
    traits.deathPenaltyWeight = -player.stats.deathsPerRound;
    traits.priceEfficiencyBenefit = efficiencyTrait;
    return {traits};
  }

  getExpectedBaseScore(player: FantasyPlayer): number {
    const traits = this.getTraitVector(player).traits;
    const weights = this.runtimeWeights;
    let score = 0;
    for (const key of Object.keys(traits) as PlayerWeightKey[]) {
      score += traits[key] * weights[key];
    }
    return score;
  }

  private getPlayerProjection(player: FantasyPlayer): PlayerProjection {
    const baseSkillEV = this.getExpectedBaseScore(player);
    return {
      total: baseSkillEV,
      baseSkillEV,
      sigma: this.getPlayerSigma(player),
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

  private computeFieldSidePenalty(
    players: FantasyPlayer[],
    projectionById: Map<string, PlayerProjection>,
  ): number {
    if (!this.fieldSplitRuntime) return 0;

    const playersBySide = new Map<number, FantasyPlayer[]>();
    for (const player of players) {
      const side = this.fieldSplitRuntime.teamSideByNormalizedName.get(
        normalizeTeamName(player.team),
      );
      if (side == null) continue;
      const list = playersBySide.get(side) ?? [];
      list.push(player);
      playersBySide.set(side, list);
    }

    let totalPenalty = 0;
    for (const sidePlayers of playersBySide.values()) {
      if (sidePlayers.length === 0) continue;

      const avgSideSkill =
        sidePlayers.reduce(
          (sum, player) =>
            sum + (projectionById.get(player.id)?.baseSkillEV ?? 0),
          0,
        ) / sidePlayers.length;

      if (sidePlayers.length >= 4) {
        totalPenalty +=
          avgSideSkill *
          this.runtimeWeights.fieldSide4PlusPlayerPenalty *
          (sidePlayers.length - 3);
      } else if (sidePlayers.length === 3) {
        totalPenalty +=
          avgSideSkill * this.runtimeWeights.fieldSide3PlayerPenalty;
      }

      const distinctTeams = new Set(
        sidePlayers.map((player) => normalizeTeamName(player.team)),
      ).size;
      if (distinctTeams >= 2) {
        totalPenalty +=
          avgSideSkill *
          this.runtimeWeights.fieldSideCrossTeamPenalty *
          (distinctTeams - 1);
      }
    }

    return totalPenalty;
  }

  /**
   * Candidate pool: top scorers + per-team depth + best value (points per $)
   * in each price bucket so budget-constrained lineups keep access to enablers.
   */
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

    // Value tiers: best score-per-dollar within each price bucket.
    const prices = sorted.map((p) => p.price).filter((v) => v > 0);
    if (prices.length >= this.PRICE_BUCKET_COUNT * 4) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const span = (max - min) / this.PRICE_BUCKET_COUNT;
      for (let b = 0; b < this.PRICE_BUCKET_COUNT; b++) {
        const lo = min + b * span;
        const hi = lo + span;
        const bucket = sorted.filter(
          (p) => p.price >= lo && (b === this.PRICE_BUCKET_COUNT - 1 ? p.price <= hi : p.price < hi),
        );
        bucket.sort((x, y) => {
          const vx = (projectionById.get(x.id)?.baseSkillEV ?? 0) / x.price;
          const vy = (projectionById.get(y.id)?.baseSkillEV ?? 0) / y.price;
          return vy - vx;
        });
        for (const p of bucket.slice(0, this.VALUE_TIER_COUNT)) {
          merged.set(p.id, p);
        }
      }
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
    this.fieldSplitRuntime = toFieldSplitRuntime(config.fieldSplit);
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
      const maxTracked = Math.max(
        this.MAX_TRACKED_LINEUPS,
        this.effectiveTargetResults,
      );
      if (validLineups.length > maxTracked) {
        validLineups.length = maxTracked;
      }
    };

    const getCutoffScore = () => {
      const maxTracked = Math.max(
        this.MAX_TRACKED_LINEUPS,
        this.effectiveTargetResults,
      );
      if (validLineups.length < maxTracked) return Number.NEGATIVE_INFINITY;
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

        const fieldSidePenaltyEV = this.computeFieldSidePenalty(
          selectedPlayers,
          projectionById,
        );

        const expectedBaseScore =
          componentSums.baseSkillEV +
          stackCorrelationEV +
          stackRankBonus -
          fieldSidePenaltyEV;

        addLineup({
          players: [...selectedPlayers],
          totalPrice,
          expectedBaseScore,
          strategyUsed,
          scoringBreakdown: {
            baseSkillEV: componentSums.baseSkillEV,
            stackCorrelationEV,
            stackRankBonus,
            fieldSidePenaltyEV,
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
    if (lineups.length <= 1)
      return lineups.slice(0, this.effectiveTargetResults);
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

  private buildComponentList(
    player: FantasyPlayer,
    shrunk: Partial<Record<HistoricalSourceKey, number>>,
  ): ScoreComponent[] {
    const weights = this.runtimeWeights;
    const thresholds = this.runtimeThresholds;
    const components: ScoreComponent[] = [
      {
        key: "cardRating",
        label: "card",
        value: player.stats.rating,
        weight: weights.cardRatingBenefit,
        contribution: player.stats.rating * weights.cardRatingBenefit,
      },
    ];

    for (const source of HISTORICAL_SOURCES) {
      const rating = shrunk[source.key];
      const weight = weights[`hist_${source.key}`];
      components.push({
        key: `hist_${source.key}`,
        label: source.label,
        value: rating ?? Number.NaN,
        weight,
        contribution: rating != null ? rating * weight : 0,
      });
    }

    const teamRank = this.teamRankings.get(normalizeTeamName(player.team));
    components.push({
      key: "teamRank",
      label: "team rank",
      value: teamRank ? this.getFieldRelativeRankBonus(teamRank) : 0,
      weight: weights.topTeamRankBenefit,
      contribution: teamRank
        ? this.getFieldRelativeRankBonus(teamRank) * weights.topTeamRankBenefit
        : 0,
    });
    components.push({
      key: "awperRole",
      label: "awp gate",
      value: player.stats.awpPerRound >= thresholds.awperRoleMinAwpPerRound ? 1 : 0,
      weight: weights.awperRoleBenefit,
      contribution:
        player.stats.awpPerRound >= thresholds.awperRoleMinAwpPerRound
          ? weights.awperRoleBenefit
          : 0,
    });
    components.push({
      key: "lowDeathRate",
      label: "survival gate",
      value:
        player.stats.deathsPerRound <= thresholds.lowDeathRateMaxDeathsPerRound
          ? 1
          : 0,
      weight: weights.lowDeathRateBenefit,
      contribution:
        player.stats.deathsPerRound <= thresholds.lowDeathRateMaxDeathsPerRound
          ? weights.lowDeathRateBenefit
          : 0,
    });
    const sideVariance = Math.abs(player.stats.ctRating - player.stats.tRating);
    components.push({
      key: "ctVsT",
      label: "CT/T imbalance",
      value: -sideVariance,
      weight: weights.ctVsTRatingImbalancePenalty,
      contribution: -sideVariance * weights.ctVsTRatingImbalancePenalty,
    });
    components.push({
      key: "awpPerRound",
      label: "awp/round",
      value: player.stats.awpPerRound,
      weight: weights.awpPerRoundWeight,
      contribution: player.stats.awpPerRound * weights.awpPerRoundWeight,
    });
    components.push({
      key: "deaths",
      label: "deaths/round",
      value: -player.stats.deathsPerRound,
      weight: weights.deathPenaltyWeight,
      contribution: -player.stats.deathsPerRound * weights.deathPenaltyWeight,
    });
    const priceRatio =
      player.price > 0 ? player.price / PRICE_EFFICIENCY_ANCHOR : 0;
    const efficiency = priceRatio > 0 ? player.stats.rating / priceRatio : 0;
    components.push({
      key: "priceEfficiency",
      label: "$ efficiency",
      value: efficiency,
      weight: weights.priceEfficiencyBenefit,
      contribution: efficiency * weights.priceEfficiencyBenefit,
    });

    return components;
  }

  private buildDiagnostics(
    lineups: MathLineup[],
    projectionById: Map<string, PlayerProjection>,
    playerById: Map<FantasyPlayer["id"], FantasyPlayer>,
  ): OptimizationDiagnostics {
    const topPlayers = [...projectionById.entries()]
      .map(([playerId, projection]) => {
        const player = playerById.get(playerId);
        if (!player) {
          return {
            playerId,
            name: playerId,
            team: "",
            price: 0,
            total: projection.total,
            baseSkillEV: projection.baseSkillEV,
            sigma: projection.sigma,
            dataConfidence: 0,
            formVolatility: 0,
            components: [] as ScoreComponent[],
          };
        }
        const shrunk = this.getShrunkRatings(player);
        const components = this.buildComponentList(player, shrunk);
        return {
          playerId,
          name: player.name,
          team: player.team,
          price: player.price,
          total: projection.total,
          baseSkillEV: projection.baseSkillEV,
          sigma: projection.sigma,
          dataConfidence: computeDataConfidence(player),
          formVolatility: computeFormVolatility(shrunk),
          components,
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
          fieldSidePenaltyEV: 0,
        };

        const componentMagnitude =
          Math.abs(b.baseSkillEV) +
          Math.abs(b.stackCorrelationEV) +
          Math.abs(b.stackRankBonus) +
          Math.abs(b.fieldSidePenaltyEV) +
          0.0001;

        const sharesPct: Record<string, number> = {
          baseSkill: (Math.abs(b.baseSkillEV) / componentMagnitude) * 100,
          stackCorrelation:
            (Math.abs(b.stackCorrelationEV) / componentMagnitude) * 100,
          stackRankBonus:
            (Math.abs(b.stackRankBonus) / componentMagnitude) * 100,
          fieldSidePenalty:
            (Math.abs(b.fieldSidePenaltyEV) / componentMagnitude) * 100,
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

  getCurrentWeights(): ScoreWeights {
    return this.runtimeWeights;
  }

  /** Restores runtime scoring state after override-based optimize() calls. */
  applyWeights(weights?: ScoreWeights): void {
    this.runtimeWeights = weights ?? resolveWeights();
  }

  /** One-off optimize with explicit overrides that never leak into runtime state. */
  optimizeIsolated(
    players: FantasyPlayer[],
    teams: FantasyTeam[],
    config: FantasyConfig,
    weightOverrides: OptimizerWeightOverrides,
  ): MathLineup[] {
    return this.optimize(players, teams, config, weightOverrides);
  }
}

export const mathOptimizer = new MathOptimizer();
