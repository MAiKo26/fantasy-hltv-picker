import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import {cacheService} from "./cacheService.ts";
import type {FantasyPlayer} from "../types/player.ts";

export interface historicalPlayerStat {
  name: string;
  rating: number;
  maps?: number;
  kd?: number;
}

export interface ParseDebugInfo {
  filename: string;
  totalRowsFound: number;
  validRowsParsed: number;
  skippedRows: number;
  sampleRows: Array<{
    rawName: string;
    rawRating: string;
    rawMaps: string;
    rawKd: string;
    parsed: historicalPlayerStat | null;
  }>;
}

export class StatsScraperService {
  private parseHtml(
    html: string,
    debug = false,
  ): {stats: historicalPlayerStat[]; debugInfo?: ParseDebugInfo} {
    const $ = cheerio.load(html);
    const stats: historicalPlayerStat[] = [];

    // Target only the player-ratings stats table to avoid picking up
    // other tables on the page (calendar, nav widgets, etc.)
    const tableSelector =
      "table.stats-table.player-ratings-table tbody tr, " +
      "table.stats-table tbody tr";

    const rows = $(tableSelector);
    let skipped = 0;
    const sampleRows: ParseDebugInfo["sampleRows"] = [];

    rows.each((_, row) => {
      const nameNode = $(row).find(".playerCol a");
      const rawName = nameNode.text().trim();

      // ratingCol may also have class ratingPositive/ratingNegative
      const ratingNode = $(row).find("td.ratingCol").first();
      const rawRating = ratingNode.text().trim();
      const rating = parseFloat(rawRating);

      const mapsNode = $(row).find("td.mapsCol, td.statsDetail").first();
      const rawMaps = mapsNode.text().trim();
      const maps = parseInt(rawMaps, 10) || undefined;

      const kdNode = $(row).find("td.kdCol").first();
      const rawKd = kdNode.text().trim();
      const kd = parseFloat(rawKd) || undefined;

      const parsed: historicalPlayerStat | null =
        rawName && !isNaN(rating) ? {name: rawName, rating, maps, kd} : null;

      if (debug && sampleRows.length < 5) {
        sampleRows.push({rawName, rawRating, rawMaps, rawKd, parsed});
      }

      if (parsed) {
        stats.push(parsed);
      } else {
        skipped++;
      }
    });

    if (!debug) return {stats};

    return {
      stats,
      debugInfo: {
        filename: "",
        totalRowsFound: rows.length,
        validRowsParsed: stats.length,
        skippedRows: skipped,
        sampleRows,
      },
    };
  }

  private async fetchAndParse(
    filename: string,
    cacheKey: string,
    debug = false,
  ): Promise<{stats: historicalPlayerStat[]; debugInfo?: ParseDebugInfo}> {
    if (!debug) {
      const cached = cacheService.get<historicalPlayerStat[]>(cacheKey);
      if (cached) return {stats: cached};
    }

    try {
      const filePath = path.join(process.cwd(), "stats", filename);
      const html = fs.readFileSync(filePath, "utf-8");
      const result = this.parseHtml(html, debug);

      if (result.debugInfo) result.debugInfo.filename = filename;

      if (!debug) cacheService.set(cacheKey, result.stats);

      return result;
    } catch (error) {
      console.warn(`Error reading stats from ${filename}:`, error);
      return {stats: []};
    }
  }

  async enrichPlayersWithHistoricalStats(
    players: FantasyPlayer[],
  ): Promise<FantasyPlayer[]> {
    const [r3m, r6m, r12m] = await Promise.all([
      this.fetchAndParse("last_3_months_top_20.html", "stats_3m_top20"),
      this.fetchAndParse("last_6_months_top_30.html", "stats_6m_top30"),
      this.fetchAndParse("last_12_months_top_50.html", "stats_12m_top50"),
    ]);

    const buildDict = (stats: historicalPlayerStat[]) => {
      const dict: Record<string, historicalPlayerStat> = {};
      stats.forEach((s) => (dict[s.name.toLowerCase()] = s));
      return dict;
    };

    const dict3m = buildDict(r3m.stats);
    const dict6m = buildDict(r6m.stats);
    const dict12m = buildDict(r12m.stats);

    return players.map((player) => {
      const key = player.name.toLowerCase();
      return {
        ...player,
        stats: {
          ...player.stats,
          rating3mTop20: dict3m[key]?.rating,
          rating6mTop30: dict6m[key]?.rating,
          rating12mTop50: dict12m[key]?.rating,
        },
      };
    });
  }

  /** Exposed for the show-stats debug script */
  async debugParse(filename: string, cacheKey: string) {
    return this.fetchAndParse(filename, cacheKey, true);
  }
}

export const statsScraperService = new StatsScraperService();
