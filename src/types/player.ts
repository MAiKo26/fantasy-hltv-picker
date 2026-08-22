import type {FieldSplitConfig} from "./fieldSplit.ts";
import type {HistoricalSourceKey} from "../services/historicalSources.ts";

export type CardLevel = "gold" | "silver" | "bronze";

export interface PlayerStats {
  rating: number;
  ctRating: number;
  tRating: number;
  awpPerRound: number;
  headshotPct: number;
  entryRoundsPct: number;
  clutchRoundsPct: number;
  supportRoundsPct: number;
  multiKillRoundsPct: number;
  deathsPerRound: number;
  /** Raw historical ratings keyed by source. */
  histRatings: Partial<Record<HistoricalSourceKey, number>>;
  /** Maps played backing each historical rating (drives shrinkage/uncertainty). */
  histMaps: Partial<Record<HistoricalSourceKey, number>>;
}

export interface FantasyPlayer {
  id: string;
  name: string;
  team: string;
  cardLevel: CardLevel;
  price: number;
  stats: PlayerStats;
  statsUrl: string;
}

export interface FantasyTeam {
  name: string;
  worldRank: number;
  players: string[];
}

export interface ExtractionResult {
  players: FantasyPlayer[];
  teams: FantasyTeam[];
  sourceFile: string;
  extractedAt: Date;
}

export interface Player {
  id: string;
  name: string;
  team: string;
  rating: number;
}

export type OptimizationMode = "ev" | "consistency" | "ceiling";

export interface ConsistencyMetrics {
  /** P(lineup beats field median) */
  pTop50: number;
  /** P(lineup finishes in top 30% of field) */
  pTop30: number;
  /** P(lineup finishes in top 10% of field) */
  pTop10: number;
  /** Mean percentile vs field (0 = last, 1 = first). */
  meanPercentile: number;
  /** Median simulated rank among field lineups (lower is better). */
  medianRank: number;
}

export interface PortfolioEntry {
  players: Player[];
  lineupIndex: number;
  score: number;
  totalPrice: number;
  consistency?: ConsistencyMetrics;
}

export interface AnalysisResult {
  players: Player[];
  analyzedAt: Date;
  sourceUrl: string;
  reasoning: string;
  mode: OptimizationMode;
  recommendedLineupIndex: number;
  recommendation: string;
  top3: Array<{
    players: Player[];
    lineupIndex: number;
    reasoning: string;
    score: number;
  }>;
  /** Exposure-managed submission portfolio (diverse, overlap-capped). */
  portfolio: PortfolioEntry[];
  allScoredLineups: PortfolioEntry[];
  top20ByRating: Array<{
    id: string;
    name: string;
    team: string;
    rating: number;
  }>;
}

export interface AnalyzerService {
  analyze(
    players: FantasyPlayer[],
    teams: FantasyTeam[],
    config: FantasyConfig,
    sourceUrl: string,
  ): Promise<AnalysisResult>;
}

export interface ExtractorService {
  extract(filePath: string): Promise<ExtractionResult>;
}

export type Strategy = "Auto" | "2-2-1" | "2-1-1-1" | "1-1-1-1-1";
export type MinTeamPlayers = "Auto" | 1 | 2;

export interface ForcedTeam {
  name: string;
  minPlayers: MinTeamPlayers;
}

export interface FantasyConfig {
  strategy: Strategy;
  forcedTeam?: ForcedTeam | null;
  excludedTeams?: string[];
  lineupLimit?: number;
  fieldSplit?: FieldSplitConfig | null;
  mode?: OptimizationMode;
}
