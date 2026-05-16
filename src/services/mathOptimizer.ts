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
  teamOutcome: number;
  stackCorrelation: number;
  matchupRiskPenalty: number;
  stackRankBonus: number;
}

export type OptimizerWeightOverrides = Partial<ScoreWeights>;

export interface MathLineup {
  players: FantasyPlayer[];
  totalPrice: number;
  expectedBaseScore: number;
  strategyUsed: Strategy;
  scoringBreakdown?: {
    baseSkillEV: number;
    teamOutcomeEV: number;
    stackCorrelationEV: number;
    matchupRiskPenalty: number;
    stackRankBonus: number;
  };
}

interface PlayerProjection {
  total: number;
  baseSkillEV: number;
  teamOutcomeEV: number;
}

export interface PlayerScoreDiagnostics {
  playerId: string;
  name: string;
  team: string;
  price: number;
  total: number;
  baseSkillEV: number;
  teamOutcomeEV: number;
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

const DEFAULT_WEIGHTS: ScoreWeights = {
  historical12m: 0.15,
  teamRankBonus: 0.35,
  awpBonus: 0.01,
  survivalBonus: 0.02,
  sideVariancePenalty: 0.1,
  teamOutcome: 0.15,
  stackCorrelation: 0.05,
  matchupRiskPenalty: 0.2,
  stackRankBonus: 0.12,
};

function resolveWeights(overrides?: OptimizerWeightOverrides): ScoreWeights {
  const envWeights: Partial<ScoreWeights> = {};
  if (env.WEIGHT_HISTORICAL_12M != null)
    envWeights.historical12m = env.WEIGHT_HISTORICAL_12M;
  if (env.WEIGHT_TEAM_RANK_BONUS != null)
    envWeights.teamRankBonus = env.WEIGHT_TEAM_RANK_BONUS;
  if (env.WEIGHT_AWP_BONUS != null) envWeights.awpBonus = env.WEIGHT_AWP_BONUS;
  if (env.WEIGHT_SURVIVAL_BONUS != null)
    envWeights.survivalBonus = env.WEIGHT_SURVIVAL_BONUS;
  if (env.WEIGHT_SIDE_VARIANCE_PENALTY != null)
    envWeights.sideVariancePenalty = env.WEIGHT_SIDE_VARIANCE_PENALTY;
  if (env.WEIGHT_TEAM_OUTCOME != null)
    envWeights.teamOutcome = env.WEIGHT_TEAM_OUTCOME;
  if (env.WEIGHT_STACK_CORRELATION != null)
    envWeights.stackCorrelation = env.WEIGHT_STACK_CORRELATION;
  if (env.WEIGHT_MATCHUP_RISK_PENALTY != null)
    envWeights.matchupRiskPenalty = env.WEIGHT_MATCHUP_RISK_PENALTY;
  if (env.WEIGHT_STACK_RANK_BONUS != null)
    envWeights.stackRankBonus = env.WEIGHT_STACK_RANK_BONUS;

  return {
    ...DEFAULT_WEIGHTS,
    ...envWeights,
    ...(overrides ?? {}),
  };
}

export class MathOptimizer {
  private readonly MAX_BUDGET = 1000000;
  private readonly MAX_PLAYER_PRICE = 245000;
  private readonly TARGET_RESULTS = 30;
  private readonly CANDIDATE_POOL_LIMIT = 65;
  private readonly TEAM_CANDIDATES_LIMIT = 4;
  private readonly MAX_TRACKED_LINEUPS = 50;

  private teamRankings: Map<string, number> = new Map();
  private runtimeWeights: ScoreWeights = DEFAULT_WEIGHTS;
  private lastDiagnostics: OptimizationDiagnostics = {
    topPlayers: [],
    topLineups: [],
  };

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

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private getSkillGate(baseSkillEV: number): number {
    return this.clamp((baseSkillEV - 1.08) / 0.42, 0.15, 1);
  }

  private getTeamOutcomeEV(player: FantasyPlayer): number {
    const raw = matchupPredictor.getTeamExpectedOutcomeScore(player.team);
    const bounded = this.clamp(Math.tanh(raw), -0.8, 0.8);
    return bounded * this.runtimeWeights.teamOutcome;
  }

  private getPlayerProjection(player: FantasyPlayer): PlayerProjection {
    const baseSkillEV = this.getExpectedBaseScore(player);
    const skillGate = this.getSkillGate(baseSkillEV);
    const teamOutcomeEV = this.getTeamOutcomeEV(player) * skillGate;

    return {
      total: baseSkillEV + teamOutcomeEV,
      baseSkillEV,
      teamOutcomeEV,
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
    this.runtimeWeights = resolveWeights(weightOverrides);
    this.setTeams(teams);
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

    const forcedTeamNormalized = config.forcedTeam
      ? normalizeTeamName(config.forcedTeam.name)
      : null;

    const search = (
      startIndex: number,
      totalPrice: number,
      forcedTeamCount: number,
      componentSums: {
        baseSkillEV: number;
        teamOutcomeEV: number;
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

        const rosterTeams = Object.keys(teamCounts);
        const matchupRiskPenalty =
          matchupPredictor.evaluateRosterRisk(rosterTeams) *
          this.runtimeWeights.matchupRiskPenalty;

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
              totalRankBonus += Math.log(1 + 1 / rank);
              rankCount++;
            }
          }
          if (rankCount > 0) {
            stackRankBonus =
              (totalRankBonus / rankCount) * this.runtimeWeights.stackRankBonus;
          }
        }

        const expectedBaseScore =
          componentSums.baseSkillEV +
          componentSums.teamOutcomeEV +
          stackCorrelationEV +
          stackRankBonus -
          matchupRiskPenalty;

        addLineup({
          players: [...selectedPlayers],
          totalPrice,
          expectedBaseScore,
          strategyUsed,
          scoringBreakdown: {
            baseSkillEV: componentSums.baseSkillEV,
            teamOutcomeEV: componentSums.teamOutcomeEV,
            stackCorrelationEV,
            matchupRiskPenalty,
            stackRankBonus,
          },
        });
        return;
      }

      if (pool.length - startIndex < remainingSlots) return;

      const optimisticUpperBound =
        componentSums.baseSkillEV +
        componentSums.teamOutcomeEV +
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
          teamOutcomeEV: componentSums.teamOutcomeEV + projection.teamOutcomeEV,
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
      teamOutcomeEV: 0,
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
          total: projection.total,
          baseSkillEV: projection.baseSkillEV,
          teamOutcomeEV: projection.teamOutcomeEV,
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);

    const topLineups: LineupScoreDiagnostics[] = lineups
      .slice(0, 5)
      .map((lineup, idx) => {
        const b = lineup.scoringBreakdown ?? {
          baseSkillEV: 0,
          teamOutcomeEV: 0,
          stackCorrelationEV: 0,
          matchupRiskPenalty: 0,
          stackRankBonus: 0,
        };

        const componentMagnitude =
          Math.abs(b.baseSkillEV) +
          Math.abs(b.teamOutcomeEV) +
          Math.abs(b.stackCorrelationEV) +
          Math.abs(b.matchupRiskPenalty) +
          Math.abs(b.stackRankBonus) +
          0.0001;

        const sharesPct: Record<string, number> = {
          baseSkill: (Math.abs(b.baseSkillEV) / componentMagnitude) * 100,
          teamOutcome: (Math.abs(b.teamOutcomeEV) / componentMagnitude) * 100,
          stackCorrelation:
            (Math.abs(b.stackCorrelationEV) / componentMagnitude) * 100,
          matchupRisk:
            (Math.abs(b.matchupRiskPenalty) / componentMagnitude) * 100,
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
}

export const mathOptimizer = new MathOptimizer();
