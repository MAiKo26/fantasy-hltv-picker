import type {FantasyPlayer, FantasyTeam, OptimizationMode} from "../types/player.ts";
import type {MathLineup, MathOptimizer} from "./mathOptimizer.ts";
import {normalizeTeamName} from "../utils/normalize.ts";
import {
  TEAM_CORRELATION,
} from "./mathOptimizer.ts";

export interface ContestSimConfig {
  iterations: number;
  seed: number;
  /** Competitor lineups modeled as near-optimal (sharp field share). */
  sharpFieldCount: number;
  /** Competitor lineups modeled as casual/random builds. */
  casualFieldCount: number;
}

export const DEFAULT_SIM_CONFIG: ContestSimConfig = {
  iterations: 15000,
  seed: 1337,
  sharpFieldCount: 250,
  casualFieldCount: 200,
};

/** Softmax sharpness for casual lineups — higher = closer to optimal. */
const CASUAL_SHARPNESS = 5.0;

export interface SimmedLineup {
  lineup: MathLineup;
  objective: number;
  meanSimScore: number;
  metrics: {
    pTop50: number;
    pTop30: number;
    pTop10: number;
    pTop05: number;
    meanPercentile: number;
  };
}

/** Deterministic PRNG so runs are reproducible and testable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class NormalSampler {
  private cache: number | null = null;
  constructor(private readonly rand: () => number) {}

  next(): number {
    if (this.cache != null) {
      const v = this.cache;
      this.cache = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = this.rand();
    while (v === 0) v = this.rand();
    const mag = Math.sqrt(-2 * Math.log(u));
    this.cache = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  }
}

const MODE_OBJECTIVE: Record<
  OptimizationMode,
  (m: {
    pTop50: number;
    pTop30: number;
    pTop10: number;
    pTop05: number;
    meanPercentile: number;
    meanSimScore: number;
  }) => number
> = {
  // Your stated goal: reliably top-30%, never bottom half.
  consistency: (m) => 0.4 * m.pTop50 + 0.4 * m.pTop30 + 0.15 * m.pTop10 + 0.05 * m.meanPercentile,
  // Pure points expectation (old behavior).
  ev: (m) => m.meanSimScore / 10,
  // Tournament-takedown mode: chase top-decile outcomes.
  ceiling: (m) => 0.55 * m.pTop10 + 0.25 * m.pTop05 + 0.15 * m.pTop30 + 0.05 * m.meanPercentile,
};

export class ContestSimulator {
  /**
   * Simulates the event `iterations` times. Each iteration:
   *  1. every real player gets a score draw: μ + σ·(√ρ·teamShock + √(1−ρ)·idio),
   *     modeling same-team correlation (shared match outcomes);
   *  2. a model field of competitor lineups (sharp + casual mix) is scored;
   *  3. every candidate lineup is ranked against that field.
   *
   * Candidates are then ranked by the mode's objective.
   */
  simulate(
    candidates: MathLineup[],
    allPlayers: FantasyPlayer[],
    teams: FantasyTeam[],
    optimizer: MathOptimizer,
    mode: OptimizationMode,
    config: ContestSimConfig = DEFAULT_SIM_CONFIG,
    /** Extra strong field lineups, e.g. weight-perturbed optimizer runs. */
    extraFieldLineups: MathLineup[] = [],
  ): SimmedLineup[] {
    if (candidates.length < 2) return [];

    // ── Player index ────────────────────────────────────────────────
    const idToIdx = new Map<string, number>();
    const mu = new Float64Array(allPlayers.length);
    const sigma = new Float64Array(allPlayers.length);
    const teamOf = new Int32Array(allPlayers.length);

    const teamNameToIdx = new Map<string, number>();
    for (const team of teams) {
      const key = normalizeTeamName(team.name);
      if (!teamNameToIdx.has(key)) {
        teamNameToIdx.set(key, teamNameToIdx.size);
      }
    }
    const teamCount = Math.max(1, teamNameToIdx.size);

    allPlayers.forEach((player, i) => {
      idToIdx.set(player.id, i);
      mu[i] = optimizer.getExpectedBaseScore(player);
      sigma[i] = optimizer.getPlayerSigma(player);
      const teamKey = normalizeTeamName(player.team);
      let teamIdx = teamNameToIdx.get(teamKey);
      if (teamIdx == null) {
        teamIdx = teamNameToIdx.size;
        teamNameToIdx.set(teamKey, teamIdx);
      }
      teamOf[i] = teamIdx;
    });

    const resolve = (lineup: MathLineup): Int32Array | null => {
      const idxs = new Int32Array(lineup.players.length);
      for (let j = 0; j < lineup.players.length; j++) {
        const idx = idToIdx.get(lineup.players[j]!.id);
        if (idx == null) return null;
        idxs[j] = idx;
      }
      return idxs;
    };

    // ── Candidate + field lineups as index arrays ───────────────────
    const candidateIdx: Int32Array[] = [];
    for (const c of candidates) {
      const idxs = resolve(c);
      if (idxs) candidateIdx.push(idxs);
    }

    const fieldLineups: Int32Array[] = [];
    const pushField = (lineup: MathLineup) => {
      const idxs = resolve(lineup);
      if (idxs) fieldLineups.push(idxs);
    };
    for (const c of candidates.slice(0, config.sharpFieldCount)) {
      pushField(c);
    }
    for (const extra of extraFieldLineups) {
      pushField(extra);
    }

    const rand = mulberry32(config.seed);
    const sampler = new NormalSampler(rand);
    const casualNeeded = config.casualFieldCount;
    let attempts = 0;
    let made = 0;
    while (made < casualNeeded && attempts < casualNeeded * 30) {
      attempts++;
      const lineup = this.sampleCasualLineup(
        allPlayers,
        idToIdx,
        mu,
        rand,
      );
      if (lineup) {
        fieldLineups.push(lineup);
        made++;
      }
    }

    const F = fieldLineups.length;
    const C = candidateIdx.length;
    const iterations = config.iterations;

    const count50 = new Int32Array(C);
    const count30 = new Int32Array(C);
    const count10 = new Int32Array(C);
    const count05 = new Int32Array(C);
    const sumPct = new Float64Array(C);
    const sumScore = new Float64Array(C);
    const pctHist = new Int32Array(C * 20); // percentile buckets of field rank

    const teamShock = new Float64Array(teamCount + 1);
    const playerDraw = new Float64Array(allPlayers.length);
    const fieldScores = new Float64Array(F);

    const corr = TEAM_CORRELATION;
    const idioScale = Math.sqrt(Math.max(0, 1 - corr * corr));

    for (let it = 0; it < iterations; it++) {
      // 1) draw player performances
      for (let t = 0; t <= teamCount; t++) teamShock[t] = sampler.next();
      for (let i = 0; i < allPlayers.length; i++) {
        playerDraw[i] =
          mu[i]! +
          sigma[i]! * (corr * teamShock[teamOf[i]!]! + idioScale * sampler.next());
      }

      // 2) score model field
      for (let f = 0; f < F; f++) {
        const lu = fieldLineups[f]!;
        let s = 0;
        for (let j = 0; j < lu.length; j++) s += playerDraw[lu[j]!]!;
        fieldScores[f] = s;
      }
      const sortedField = Array.prototype.slice
        .call(fieldScores)
        .sort((a: number, b: number) => a - b) as number[];

      // 3) rank candidates against the field
      for (let c = 0; c < C; c++) {
        const lu = candidateIdx[c]!;
        let s = 0;
        for (let j = 0; j < lu.length; j++) s += playerDraw[lu[j]!]!;
        sumScore[c] = sumScore[c]! + s;

        // binary search: how many field lineups beat s?
        let lo = 0;
        let hi = sortedField.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (sortedField[mid]! > s) hi = mid;
          else lo = mid + 1;
        }
        const beaten = lo; // field entries strictly worse than s
        const pct = beaten / F;
        sumPct[c] = sumPct[c]! + pct;
        const histIdx = c * 20 + Math.min(19, Math.floor(pct * 20));
        pctHist[histIdx] = (pctHist[histIdx] ?? 0) + 1;
        if (pct >= 0.5) count50[c] = (count50[c] ?? 0) + 1;
        if (pct >= 0.7) count30[c] = (count30[c] ?? 0) + 1;
        if (pct >= 0.9) count10[c] = (count10[c] ?? 0) + 1;
        if (pct >= 0.95) count05[c] = (count05[c] ?? 0) + 1;
      }
    }

    const objectiveFn = MODE_OBJECTIVE[mode] ?? MODE_OBJECTIVE.consistency!;
    const out: SimmedLineup[] = [];
    for (let c = 0; c < C; c++) {
      const n = iterations;
      const metrics = {
        pTop50: count50[c]! / n,
        pTop30: count30[c]! / n,
        pTop10: count10[c]! / n,
        pTop05: count05[c]! / n,
        meanPercentile: sumPct[c]! / n,
      };
      const meanSimScore = sumScore[c]! / n;
      out.push({
        lineup: candidates[c]!,
        meanSimScore,
        metrics,
        objective: objectiveFn({...metrics, meanSimScore}),
      });
    }
    out.sort((a, b) => b.objective - a.objective);
    return out;
  }

  /**
   * Builds one plausible "casual drafter" lineup: soft-weighted random picks
   * that respect budget + max-2-per-team but are far from optimal.
   */
  private sampleCasualLineup(
    allPlayers: FantasyPlayer[],
    idToIdx: Map<string, number>,
    mu: Float64Array,
    rand: () => number,
  ): Int32Array | null {
    const MAX_BUDGET = 1000000;
    const picked: number[] = [];
    const usedIds = new Set<number>();
    const teamCounts = new Map<string, number>();
    let totalPrice = 0;

    let minMu = Infinity;
    for (let i = 0; i < allPlayers.length; i++) {
      if (mu[i]! < minMu) minMu = mu[i]!;
    }

    for (let slot = 0; slot < 5; slot++) {
      // softmax-ish weights over affordable players
      const weights: number[] = [];
      const indices: number[] = [];
      for (let i = 0; i < allPlayers.length; i++) {
        const p = allPlayers[i]!;
        if (usedIds.has(i)) continue;
        if (totalPrice + p.price > MAX_BUDGET) continue;
        if ((teamCounts.get(p.team) ?? 0) >= 2) continue;
        const w = Math.exp((mu[i]! - minMu) * CASUAL_SHARPNESS);
        weights.push(w);
        indices.push(i);
      }
      if (indices.length === 0) return null;

      let total = 0;
      for (const w of weights) total += w;
      let r = rand() * total;
      let chosen = indices[indices.length - 1]!;
      for (let k = 0; k < indices.length; k++) {
        const wk = weights[k];
        if (wk == null) continue;
        r -= wk;
        if (r <= 0) {
          chosen = indices[k]!;
          break;
        }
      }

      const player = allPlayers[chosen]!;
      picked.push(chosen);
      usedIds.add(chosen);
      teamCounts.set(player.team, (teamCounts.get(player.team) ?? 0) + 1);
      totalPrice += player.price;
    }

    if (totalPrice > MAX_BUDGET) return null;
    const result = new Int32Array(picked.length);
    for (let j = 0; j < picked.length; j++) result[j] = picked[j]!;
    void idToIdx;
    return result;
  }
}

export const contestSimulator = new ContestSimulator();
