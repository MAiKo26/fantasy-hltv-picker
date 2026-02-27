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
  // Scraped Historical Stats
  rating3mTop20?: number;
  rating6mTop20?: number;
  rating12mTop50?: number;
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
  role: string;
  rating: number;
}

export interface AnalysisResult {
  players: Player[];
  analyzedAt: Date;
  sourceUrl: string;
  roles: Record<string, string>;
  boosters: Record<string, string>;
  reasoning: string;
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
export type MinG2Players = "Auto" | 1 | 2;

export interface FantasyConfig {
  strategy: Strategy;
  minG2Players: MinG2Players;
}
