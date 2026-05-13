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

export interface MostPickedPlayer {
  rank: number;
  playerName: string;
  pickCount: number;
  pickCountRaw: string;
  statsUrl: string | null;
}

export interface AssignmentCount {
  name: string;
  assignedCount: number;
  assignedCountRaw: string;
}

export interface EventOverviewExtractionResult {
  eventSlug: string;
  sourceFile: string;
  mostPickedPlayers: MostPickedPlayer[];
  roleAssignments: AssignmentCount[];
  boosterAssignments: AssignmentCount[];
  parseWarnings: string[];
  extractedAt: Date;
}

export interface EventBundleContext {
  eventSlug: string;
  overview?: EventOverviewExtractionResult;
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
  role: string;
  rating: number;
}

export interface AnalysisResult {
  players: Player[];
  analyzedAt: Date;
  sourceUrl: string;
  roles: Record<string, string>;
  reasoning: string;
  top3: Array<{
    players: Player[];
    lineupIndex: number;
    reasoning: string;
    roles: Record<string, string>;
    score: number;
  }>;
  allScoredLineups: Array<{
    players: Player[];
    lineupIndex: number;
    reasoning: string;
    roles: Record<string, string>;
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
export type MinG2Players = "Auto" | 1 | 2;

export interface FantasyConfig {
  strategy: Strategy;
  minG2Players: MinG2Players;
  disableLLMEvaluation?: boolean;
}
