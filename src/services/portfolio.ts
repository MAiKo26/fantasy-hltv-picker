import type {OptimizationMode, Player} from "../types/player.ts";
import type {SimmedLineup} from "./contestSimulator";

export interface PortfolioOptions {
  size: number;
  /** Max shared players between any two portfolio lineups. */
  maxPairwiseOverlap: number;
  /** Max share of the portfolio a single player may appear in (0–1]. */
  maxPlayerExposure: number;
}

export const DEFAULT_PORTFOLIO: PortfolioOptions = {
  size: 5,
  maxPairwiseOverlap: 3,
  maxPlayerExposure: 0.6,
};

export interface PortfolioLineup {
  entry: SimmedLineup;
  rank: number;
}

/**
 * Greedy exposure-aware selection over simulator-ranked candidates.
 *
 * Walks candidates in objective order and admits a lineup only if:
 *  - it overlaps ≤ maxPairwiseOverlap with EVERY already-picked lineup,
 *  - none of its players would exceed maxPlayerExposure of the portfolio.
 *
 * This turns "top N list" into an actual submission portfolio: correlated
 * all-in duplicates are skipped in favor of genuinely different shots.
 */
export function selectPortfolio(
  ranked: SimmedLineup[],
  options: PortfolioOptions = DEFAULT_PORTFOLIO,
): PortfolioLineup[] {
  const selected: SimmedLineup[] = [];
  const exposure = new Map<string, number>();
  const maxExposureCount = Math.max(
    1,
    Math.ceil(options.maxPlayerExposure * options.size),
  );

  for (const candidate of ranked) {
    if (selected.length >= options.size) break;

    const ids = candidate.lineup.players.map((p) => p.id);
    const idSet = new Set(ids);

    // pairwise overlap constraint
    let tooSimilar = false;
    for (const chosen of selected) {
      let overlap = 0;
      for (const p of chosen.lineup.players) {
        if (idSet.has(p.id)) overlap++;
      }
      if (overlap > options.maxPairwiseOverlap) {
        tooSimilar = true;
        break;
      }
    }
    if (tooSimilar) continue;

    // exposure constraint
    let violatesExposure = false;
    for (const id of ids) {
      if ((exposure.get(id) ?? 0) + 1 > maxExposureCount) {
        violatesExposure = true;
        break;
      }
    }
    if (violatesExposure) continue;

    for (const id of ids) {
      exposure.set(id, (exposure.get(id) ?? 0) + 1);
    }
    selected.push(candidate);
  }

  return selected.map((entry, i) => ({entry, rank: i + 1}));
}

export function toPlayers(entry: SimmedLineup): Player[] {
  return [...entry.lineup.players]
    .sort((a, b) => b.price - a.price)
    .map((fp) => ({
      id: fp.id,
      name: fp.name,
      team: fp.team,
      rating: fp.stats.rating,
    }));
}

export function modeRecommendation(
  mode: OptimizationMode,
  portfolio: PortfolioLineup[],
): {recommendedIndex: number; text: string} {
  if (portfolio.length === 0) {
    return {recommendedIndex: 0, text: "No valid lineups."};
  }
  const best = portfolio[0]!.entry;
  if (portfolio.length === 1) {
    return {
      recommendedIndex: 0,
      text: "Single valid lineup — play it.",
    };
  }
  switch (mode) {
    case "consistency":
      return {
        recommendedIndex: 0,
        text:
          `Single entry → play #1 (P(top-30%)=${(best.metrics.pTop30 * 100).toFixed(0)}%, ` +
          `P(above median)=${(best.metrics.pTop50 * 100).toFixed(0)}%). ` +
          `With multiple entries, spread across the portfolio below — each was checked for overlap & exposure.`,
      };
    case "ceiling":
      return {
        recommendedIndex: 0,
        text:
          `Single entry → #1 maximizes top-decile odds (P(top-10%)=${(best.metrics.pTop10 * 100).toFixed(0)}%). ` +
          `High variance by design.`,
      };
    case "ev":
      return {
        recommendedIndex: 0,
        text: "Ranked purely by expected score — #1 is the highest-EV build.",
      };
  }
}
