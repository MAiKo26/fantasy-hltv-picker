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

export interface TeamMatchInfo {
  matchId: string;
  matchUrl: string | null;
  startUnixMs: number | null;
  bestOf: string | null;
  eventId: string | null;
  eventName: string | null;
  dayLabel: string | null;
  team1Id: string | null;
  team2Id: string | null;
  team1Name: string | null;
  team2Name: string | null;
  pairingKnown: boolean;
  isLive: boolean;
}

export interface MatchesExtractionResult {
  eventSlug: string;
  sourceFile: string;
  matches: TeamMatchInfo[];
  teamIdToName: Record<string, string>;
  parseWarnings: string[];
  extractedAt: Date;
}

export interface EventBundleContext {
  eventSlug: string;
  matches?: MatchesExtractionResult;
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

export interface AnalysisResult {
  players: Player[];
  analyzedAt: Date;
  sourceUrl: string;
  reasoning: string;
  top3: Array<{
    players: Player[];
    lineupIndex: number;
    reasoning: string;
    score: number;
  }>;
  allScoredLineups: Array<{
    players: Player[];
    lineupIndex: number;
    reasoning: string;
    score: number;
    totalPrice: number;
  }>;
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
    bundle?: EventBundleContext,
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
}
