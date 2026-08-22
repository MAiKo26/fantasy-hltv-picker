import type {FantasyPlayer} from "../types/player.ts";
import {
  HISTORICAL_SOURCES,
  SOURCES_BY_RECENCY,
  type HistoricalSourceDef,
  type HistoricalSourceKey,
} from "./historicalSources.ts";

export interface ShrinkageOptions {
  /** Disable shrinkage entirely (use raw ratings). */
  enabled: boolean;
  /** League-wide fallback prior when no longer-horizon rating exists. */
  leaguePrior: number;
  /** Scale on each source's shrinkPriorMaps (lower = trust raw ratings sooner). */
  strength: number;
}

export const DEFAULT_SHRINKAGE: ShrinkageOptions = {
  enabled: true,
  leaguePrior: 1.06,
  strength: 1,
};

/**
 * Empirical-Bayes shrinkage for windowed HLTV ratings.
 *
 * A rating over a short window (1 month MVP events = maybe 8 maps) is noisy.
 * We shrink it toward a hierarchical prior:
 *
 *   shrunk_i = prior_i + (raw_i - prior_i) * n_i / (n_i + k_i)
 *
 * where k_i is the source's `shrinkPriorMaps` scaled by `strength`, n_i is the
 * maps played in that window, and prior_i is the player's own shrunk rating
 * from the next-longer horizon (recursively), falling back to the league mean.
 */
export function computeShrunkRatings(
  player: FantasyPlayer,
  options: ShrinkageOptions = DEFAULT_SHRINKAGE,
): Partial<Record<HistoricalSourceKey, number>> {
  const out: Partial<Record<HistoricalSourceKey, number>> = {};

  if (!options.enabled) {
    return {...player.stats.histRatings};
  }

  // Walk longest horizon → shortest so shorter windows inherit stable priors.
  const ordered = [...SOURCES_BY_RECENCY].reverse();

  // League mean per source as last-resort prior (computed lazily from what we have).
  let fallbackPrior = options.leaguePrior;

  for (const source of ordered) {
    const raw = player.stats.histRatings[source.key];
    if (raw == null) continue;

    const maps = player.stats.histMaps[source.key] ?? 0;
    const k = Math.max(1, source.shrinkPriorMaps * options.strength);
    const weight = maps > 0 ? maps / (maps + k) : 0;

    out[source.key] = fallbackPrior + (raw - fallbackPrior) * weight;
    // Next-shorter window shrinks toward this (more reliable) estimate.
    fallbackPrior = out[source.key]!;
  }

  return out;
}

/** How much data backs a player across all sources ∈ [0,1]. Used for σ scaling. */
export function computeDataConfidence(player: FantasyPlayer): number {
  let score = 0;
  let total = 0;
  for (const source of HISTORICAL_SOURCES) {
    total += 1;
    const maps = player.stats.histMaps[source.key] ?? 0;
    if (player.stats.histRatings[source.key] != null) {
      const k = source.shrinkPriorMaps;
      score += maps > 0 ? maps / (maps + k) : 0.15;
    }
  }
  return total === 0 ? 0 : score / total;
}

/**
 * Cross-window form volatility: std-dev of the player's shrunk ratings.
 * A player whose 1m/3m/12m ratings disagree is genuinely less predictable.
 */
export function computeFormVolatility(
  shrunk: Partial<Record<HistoricalSourceKey, number>>,
): number {
  const values = Object.values(shrunk).filter(
    (v): v is number => v != null,
  );
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export interface SourceLeagueStats {
  key: HistoricalSourceKey;
  count: number;
  meanRating: number;
}

/** Per-source league means from one parsed table — better fallback priors. */
export function computeLeagueMeans(
  players: FantasyPlayer[],
): Record<HistoricalSourceKey, SourceLeagueStats> {
  const stats = {} as Record<HistoricalSourceKey, SourceLeagueStats>;
  for (const def of HISTORICAL_SOURCES) {
    let sum = 0;
    let count = 0;
    for (const p of players) {
      const r = p.stats.histRatings[def.key];
      if (r != null) {
        sum += r;
        count++;
      }
    }
    stats[def.key] = {
      key: def.key,
      count,
      meanRating: count > 0 ? sum / count : DEFAULT_SHRINKAGE.leaguePrior,
    };
  }
  return stats;
}

export type {HistoricalSourceDef};
