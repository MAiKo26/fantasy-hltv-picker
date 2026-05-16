import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import type {FantasyPlayer} from "../types/player.ts";
import {normalizePlayerName} from "../utils/normalize.ts";

export interface historicalPlayerStat {
  name: string;
  rating: number;
}

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

  async enrichPlayersWithHistoricalStats(
    players: FantasyPlayer[],
  ): Promise<FantasyPlayer[]> {
    try {
      const filePath = path.join(process.cwd(), "source", "last_12_months_top_50.html");
      const html = fs.readFileSync(filePath, "utf-8");
      const stats = this.parseHtml(html);

      const dict: Record<string, number> = {};
      for (const s of stats) {
        dict[normalizePlayerName(s.name)] = s.rating;
      }

      return players.map((player) => ({
        ...player,
        stats: {
          ...player.stats,
          rating12mTop50: dict[normalizePlayerName(player.name)],
        },
      }));
    } catch (error) {
      console.warn("Error reading stats from source/last_12_months_top_50.html:", error);
      return players;
    }
  }
}

export const statsScraperService = new StatsScraperService();
