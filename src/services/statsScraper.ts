import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import type {FantasyPlayer} from "../types/player.ts";
import {normalizePlayerName} from "../utils/normalize.ts";

export interface historicalPlayerStat {
  name: string;
  rating: number;
}

export type HistoricalSourceKey =
  | "rating12mTop10"
  | "rating12mTop20"
  | "rating12mTop30"
  | "rating12mTop50";

const HISTORICAL_SOURCE_FILES: Record<HistoricalSourceKey, string> = {
  rating12mTop10: "last_12_months_top_10.html",
  rating12mTop20: "last_12_months_top_20.html",
  rating12mTop30: "last_12_months_top_30.html",
  rating12mTop50: "last_12_months_top_50.html",
};

export class StatsScraperService {
  private parseHtml(html: string): historicalPlayerStat[] {
    const $ = cheerio.load(html);
    const stats: historicalPlayerStat[] = [];

    const tableSelector =
      "table.stats-table.player-ratings-table tbody tr, " +
      "table.stats-table tbody tr";

    $(tableSelector).each((_, row) => {
      const nameNode = $(row).find(".playerCol a");
      const rawName = nameNode.text().trim();
      const ratingNode = $(row).find("td.ratingCol").first();
      const rating = parseFloat(ratingNode.text().trim());

      if (rawName && !isNaN(rating)) {
        stats.push({name: rawName, rating});
      }
    });

    return stats;
  }

  private loadSourceDict(filename: string): Record<string, number> {
    const filePath = path.join(process.cwd(), "source", filename);
    if (!fs.existsSync(filePath)) {
      console.warn(`Missing historical source file: ${filePath}`);
      return {};
    }
    const stats = this.parseHtml(fs.readFileSync(filePath, "utf-8"));
    const dict: Record<string, number> = {};
    for (const s of stats) {
      dict[normalizePlayerName(s.name)] = s.rating;
    }
    return dict;
  }

  async enrichPlayersWithHistoricalStats(
    players: FantasyPlayer[],
  ): Promise<FantasyPlayer[]> {
    const dicts: Record<HistoricalSourceKey, Record<string, number>> = {
      rating12mTop10: {},
      rating12mTop20: {},
      rating12mTop30: {},
      rating12mTop50: {},
    };

    for (const key of Object.keys(HISTORICAL_SOURCE_FILES) as HistoricalSourceKey[]) {
      const filename = HISTORICAL_SOURCE_FILES[key];
      try {
        dicts[key] = this.loadSourceDict(filename);
      } catch (error) {
        console.warn(`Error reading stats from source/${filename}:`, error);
      }
    }

    return players.map((player) => {
      const normalized = normalizePlayerName(player.name);
      const updates: Partial<FantasyPlayer["stats"]> = {};
      for (const key of Object.keys(HISTORICAL_SOURCE_FILES) as HistoricalSourceKey[]) {
        const value = dicts[key][normalized];
        if (value !== undefined) {
          updates[key] = value;
        }
      }
      return {
        ...player,
        stats: {
          ...player.stats,
          ...updates,
        },
      };
    });
  }
}

export const statsScraperService = new StatsScraperService();
