import * as fs from "node:fs";
import * as path from "node:path";
import * as cheerio from "cheerio";
import type {
  AssignmentCount,
  EventOverviewExtractionResult,
  MostPickedPlayer,
} from "../types/player.ts";
import {parseEventSlugFromFileName, parseTimesCount} from "../utils/normalize.ts";

const SOURCE_DIR = path.join(process.cwd(), "source-event-overview");

function parseMostPicked($: cheerio.CheerioAPI): MostPickedPlayer[] {
  const items: MostPickedPlayer[] = [];

  $(".pickedPlayers .player-with-count").each((index, el) => {
    const node = $(el);
    const playerName =
      node.find(".card-player-tag .text-ellipsis").first().text().trim() ||
      node.find(".back .card-player-tag").first().text().trim();
    const pickCountRaw = node.find(".nr-of-times").first().text().trim();
    const pickCount = parseTimesCount(pickCountRaw);
    const statsUrl = node.find("a.player-stats-link").first().attr("href") ?? null;

    if (!playerName || pickCount <= 0) return;

    items.push({
      rank: index + 1,
      playerName,
      pickCount,
      pickCountRaw,
      statsUrl,
    });
  });

  return items;
}

function parseAssignmentSection(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<any>,
): AssignmentCount[] {
  const result: AssignmentCount[] = [];

  root.find(".roles-assigned-container .counted-role").each((_, el) => {
    const node = $(el);
    const name = node.find(".counted-role-name").first().text().trim();
    const assignedCountRaw = node
      .find(".counted-role-count-text")
      .first()
      .text()
      .trim();
    const assignedCount = parseTimesCount(assignedCountRaw);

    if (!name || assignedCount <= 0) return;
    result.push({name, assignedCount, assignedCountRaw});
  });

  return result;
}

function getRolesSection($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  const byClass = $(".mostAssignedRoles.g-grid").not(".mostAssignedBoost").first();
  if (byClass.length > 0) return byClass;

  return $(".mostAssignedRoles")
    .filter((_, el) =>
      $(el).find(".hint-headline").first().text().toLowerCase().includes("player roles"),
    )
    .first();
}

function getBoostersSection($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  const byClass = $(".mostAssignedRoles.mostAssignedBoost.g-grid").first();
  if (byClass.length > 0) return byClass;

  return $(".mostAssignedRoles")
    .filter((_, el) =>
      $(el).find(".hint-headline").first().text().toLowerCase().includes("boosters"),
    )
    .first();
}

export async function listEventOverviewFiles(): Promise<string[]> {
  if (!fs.existsSync(SOURCE_DIR)) return [];
  return fs.readdirSync(SOURCE_DIR).filter((file) => file.endsWith(".html"));
}

export async function extractEventOverviewFromHtml(
  sourceFile: string,
): Promise<EventOverviewExtractionResult> {
  const filePath = path.join(SOURCE_DIR, sourceFile);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Event overview file not found: ${filePath}`);
  }

  const html = fs.readFileSync(filePath, "utf-8");
  const $ = cheerio.load(html);
  const eventSlug = parseEventSlugFromFileName(sourceFile);
  const parseWarnings: string[] = [];

  const mostPickedPlayers = parseMostPicked($);
  const roleAssignments = parseAssignmentSection($, getRolesSection($));
  const boosterAssignments = parseAssignmentSection($, getBoostersSection($));

  if (mostPickedPlayers.length === 0) {
    parseWarnings.push("Could not parse most-picked players.");
  }
  if (roleAssignments.length === 0) {
    parseWarnings.push("Could not parse role assignment counts.");
  }
  if (boosterAssignments.length === 0) {
    parseWarnings.push("Could not parse booster assignment counts.");
  }

  return {
    eventSlug,
    sourceFile,
    mostPickedPlayers,
    roleAssignments,
    boosterAssignments,
    parseWarnings,
    extractedAt: new Date(),
  };
}

export class EventOverviewExtractorService {
  async listFiles(): Promise<string[]> {
    return listEventOverviewFiles();
  }

  async extract(sourceFile: string): Promise<EventOverviewExtractionResult> {
    return extractEventOverviewFromHtml(sourceFile);
  }
}

export const eventOverviewExtractor = new EventOverviewExtractorService();
