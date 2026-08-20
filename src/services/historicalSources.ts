import sourcesConfig from "./historical-sources.json";

export type HistoricalSourceKey =
  | "rating12mTop10"
  | "rating12mTop20"
  | "rating12mTop30"
  | "rating12mTop50"
  | "rating1mTop30MVPEvents";

export interface HistoricalSourceDef {
  key: HistoricalSourceKey;
  filename: string;
  label: string;
  rankingFilter: "Top10" | "Top20" | "Top30" | "Top50";
  monthsBack: number;
  matchType: "Lan" | "MvpEvents";
  minMapCount: number;
}

export const HISTORICAL_SOURCES = sourcesConfig as HistoricalSourceDef[];

export const HISTORICAL_SOURCE_FILES: Record<HistoricalSourceKey, string> =
  Object.fromEntries(
    HISTORICAL_SOURCES.map((source) => [source.key, source.filename]),
  ) as Record<HistoricalSourceKey, string>;

export function formatLocalIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildStatsUrl(
  source: HistoricalSourceDef,
  now: Date = new Date(),
): string {
  const end = new Date(now.getTime());
  const start = new Date(now.getTime());
  start.setMonth(start.getMonth() - source.monthsBack);

  const params = new URLSearchParams({
    startDate: formatLocalIsoDate(start),
    endDate: formatLocalIsoDate(end),
    matchType: source.matchType,
    rankingFilter: source.rankingFilter,
    minMapCount: String(source.minMapCount),
  });
  return `https://www.hltv.org/stats/players?${params.toString()}`;
}
