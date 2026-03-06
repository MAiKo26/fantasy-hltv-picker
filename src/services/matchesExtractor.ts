import * as fs from "node:fs";
import * as path from "node:path";
import * as cheerio from "cheerio";
import type {MatchesExtractionResult, TeamMatchInfo} from "../types/player.ts";
import {parseEventSlugFromFileName} from "../utils/normalize.ts";

const SOURCE_DIR = path.join(process.cwd(), "source-matches");

function parseMatchId(rawMatchId: string | undefined, matchUrl: string | null): string {
  if (rawMatchId && rawMatchId.trim().length > 0) return rawMatchId.trim();
  if (!matchUrl) return "";
  const match = matchUrl.match(/\/matches\/(\d+)\//);
  return match?.[1] ?? "";
}

function parseUnix(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function sanitize(value: string | undefined): string | null {
  const clean = value?.trim() ?? "";
  return clean.length > 0 ? clean : null;
}

function toAbsoluteMatchUrl(rawHref: string | undefined): string | null {
  if (!rawHref) return null;
  if (rawHref.startsWith("http://") || rawHref.startsWith("https://")) {
    return rawHref;
  }
  if (rawHref.startsWith("/")) return `https://www.hltv.org${rawHref}`;
  return null;
}

export async function listMatchesSourceFiles(): Promise<string[]> {
  if (!fs.existsSync(SOURCE_DIR)) return [];
  return fs.readdirSync(SOURCE_DIR).filter((file) => file.endsWith(".html"));
}

export async function extractMatchesFromHtml(
  sourceFile: string,
): Promise<MatchesExtractionResult> {
  const filePath = path.join(SOURCE_DIR, sourceFile);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Matches source file not found: ${filePath}`);
  }

  const html = fs.readFileSync(filePath, "utf-8");
  const $ = cheerio.load(html);
  const parseWarnings: string[] = [];
  const matches: TeamMatchInfo[] = [];
  const teamIdToName: Record<string, string> = {};
  const eventSlug = parseEventSlugFromFileName(sourceFile);
  const eventName = sanitize($(".event-hub-title").first().text());

  $(".matches-event-wrapper").each((_, dayWrapper) => {
    const dayLabel = sanitize($(dayWrapper).find(".event-headline").first().text());

    $(dayWrapper)
      .find(".match-wrapper")
      .each((__, matchEl) => {
        const node = $(matchEl);
        const team1Id = sanitize(node.attr("team1"));
        const team2Id = sanitize(node.attr("team2"));

        const teamsAnchor = node.find("a.match-teams").first();
        const topAnchor = node.find("a.match-top").first();
        const team1Name = sanitize(
          teamsAnchor.find(".match-team.team1 .match-teamname").first().text(),
        );
        const team2Name = sanitize(
          teamsAnchor.find(".match-team.team2 .match-teamname").first().text(),
        );

        if (team1Id && team1Name) teamIdToName[team1Id] = team1Name;
        if (team2Id && team2Name) teamIdToName[team2Id] = team2Name;

        const rawUrl = teamsAnchor.attr("href") ?? topAnchor.attr("href");
        const matchUrl = toAbsoluteMatchUrl(rawUrl);
        const matchId = parseMatchId(node.attr("data-match-id"), matchUrl);
        if (!matchId) return;

        const timeNode = node.find(".match-time").first();
        const startUnixMs =
          parseUnix(timeNode.attr("data-unix")) ??
          parseUnix(node.closest("[data-zonedgrouping-entry-unix]").attr("data-zonedgrouping-entry-unix"));
        const bestOf = sanitize(
          node
            .find(".match-meta")
            .filter((___, el) => !$(el).hasClass("match-meta-live"))
            .first()
            .text(),
        );

        const info: TeamMatchInfo = {
          matchId,
          matchUrl,
          startUnixMs,
          bestOf,
          eventId: sanitize(node.attr("data-event-id")),
          eventName,
          dayLabel,
          team1Id,
          team2Id,
          team1Name,
          team2Name,
          pairingKnown: Boolean((team1Name || team1Id) && (team2Name || team2Id)),
          isLive:
            node.attr("live") === "true" || node.find(".match-meta.match-meta-live").length > 0,
        };

        matches.push(info);
      });
  });

  if (matches.length === 0) {
    parseWarnings.push("No matches parsed from source file.");
  }

  return {
    eventSlug,
    sourceFile,
    matches,
    teamIdToName,
    parseWarnings,
    extractedAt: new Date(),
  };
}

export class MatchesExtractorService {
  async listFiles(): Promise<string[]> {
    return listMatchesSourceFiles();
  }

  async extract(sourceFile: string): Promise<MatchesExtractionResult> {
    return extractMatchesFromHtml(sourceFile);
  }
}

export const matchesExtractor = new MatchesExtractorService();
