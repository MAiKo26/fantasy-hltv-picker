import * as fs from "node:fs";
import * as path from "node:path";
import * as cheerio from "cheerio";
import {normalizePlayerName, normalizeTeamName} from "../utils/normalize.ts";

export interface PlayerFinalRating {
  name: string;
  team: string;
  rating: number;
  maps: number;
  rounds: number;
  kdDiff: number;
  kd: number;
}

export interface EventGroundTruth {
  eventSlug: string;
  sourceFile: string;
  ratingsSourceFile: string | null;
  bestValueSourceFile: string | null;
  ratings: PlayerFinalRating[];
  bestValuePlayers: string[];
  bestValueRaw: Array<{name: string; pricePerPoint: string}>;
  hasRatings: boolean;
  hasBestValue: boolean;
}

function parseSignedInt(text: string): number {
  const cleaned = text.replace(/[+\s,]/g, "").trim();
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : 0;
}

function parseFloatSafe(text: string | undefined): number {
  if (!text) return 0;
  const cleaned = text.replace(/[%,$\s]/g, "").trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseIntSafe(text: string | undefined): number {
  if (!text) return 0;
  const cleaned = text.replace(/[,\s]/g, "").trim();
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : 0;
}

function parseRatingsFromHtml(html: string): PlayerFinalRating[] {
  const $ = cheerio.load(html);
  const ratings: PlayerFinalRating[] = [];

  $("table.player-ratings-table tbody tr").each((_, rowEl) => {
    const cells = $(rowEl).find("td");
    if (cells.length < 7) return;

    const rawName = $(cells[0]).find("a").last().text().trim();
    if (!rawName) return;

    const rawTeam = $(cells[1]).find("a").last().text().trim();
    const maps = parseIntSafe($(cells[2]).text());
    if (maps === 0) return;

    const rounds = parseIntSafe($(cells[3]).text());
    const kdDiff = parseSignedInt($(cells[4]).text());
    const kd = parseFloatSafe($(cells[5]).text());
    const rating = parseFloatSafe($(cells[6]).text());

    ratings.push({
      name: normalizePlayerName(rawName),
      team: normalizeTeamName(rawTeam),
      rating,
      maps,
      rounds,
      kdDiff,
      kd,
    });
  });

  return ratings;
}

function parseBestValueFromHtml(html: string): {
  players: string[];
  raw: Array<{name: string; pricePerPoint: string}>;
} {
  const $ = cheerio.load(html);
  const players: string[] = [];
  const raw: Array<{name: string; pricePerPoint: string}> = [];

  $(".most-value-for-money-players .pickedPlayers .player-with-count").each(
    (_, el) => {
      const name = $(el).find(".card-player-tag").first().text().trim();
      const pricePerPoint = $(el).find(".price-per-point").text().trim();
      if (name) {
        players.push(normalizePlayerName(name));
        raw.push({name, pricePerPoint});
      }
    },
  );

  return {players, raw};
}

export interface ParseEventOptions {
  ratingsFile: string | null;
  bestValueFile: string | null;
  eventSlug: string;
}

export function parseEventGroundTruth(
  options: ParseEventOptions,
): EventGroundTruth {
  const {ratingsFile, bestValueFile, eventSlug} = options;

  let ratings: PlayerFinalRating[] = [];
  let bestValuePlayers: string[] = [];
  let bestValueRaw: Array<{name: string; pricePerPoint: string}> = [];

  if (ratingsFile && fs.existsSync(ratingsFile)) {
    const html = fs.readFileSync(ratingsFile, "utf-8");
    ratings = parseRatingsFromHtml(html);
  }

  if (bestValueFile && fs.existsSync(bestValueFile)) {
    const html = fs.readFileSync(bestValueFile, "utf-8");
    const bv = parseBestValueFromHtml(html);
    bestValuePlayers = bv.players;
    bestValueRaw = bv.raw;
  }

  return {
    eventSlug,
    sourceFile: ratingsFile ?? bestValueFile ?? "",
    ratingsSourceFile: ratingsFile,
    bestValueSourceFile: bestValueFile,
    ratings,
    bestValuePlayers,
    bestValueRaw,
    hasRatings: ratings.length > 0,
    hasBestValue: bestValuePlayers.length > 0,
  };
}

export function parseResultPage(filePath: string): EventGroundTruth {
  const html = fs.readFileSync(filePath, "utf-8");
  const eventSlug = path.basename(filePath, ".html");
  const ratings = parseRatingsFromHtml(html);
  const {players: bestValuePlayers, raw: bestValueRaw} =
    parseBestValueFromHtml(html);

  return {
    eventSlug,
    sourceFile: filePath,
    ratingsSourceFile: ratings.length > 0 ? filePath : null,
    bestValueSourceFile: bestValuePlayers.length > 0 ? filePath : null,
    ratings,
    bestValuePlayers,
    bestValueRaw,
    hasRatings: ratings.length > 0,
    hasBestValue: bestValuePlayers.length > 0,
  };
}
