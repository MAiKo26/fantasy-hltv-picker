export function normalizeKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizePlayerName(name: string): string {
  return normalizeKey(name);
}

export function normalizeTeamName(name: string): string {
  return normalizeKey(name);
}

export function parseTimesCount(raw: string): number {
  const match = raw.replace(/,/g, "").match(/(\d+)/);
  if (!match || !match[1]) return 0;
  return Number.parseInt(match[1], 10) || 0;
}

export function parseEventSlugFromFileName(fileName: string): string {
  return fileName.replace(/\.html$/i, "").trim();
}
