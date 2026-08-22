import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import type {FantasyPlayer} from "../types/player.ts";
import {normalizePlayerName} from "../utils/normalize.ts";
import {
  HISTORICAL_SOURCES,
  HISTORICAL_SOURCE_FILES,
  type HistoricalSourceKey,
} from "./historicalSources.ts";

export type {HistoricalSourceKey} from "./historicalSources.ts";

interface historicalPlayerStat {
  name: string;
  rating: number;
  maps: number;
}

export interface SourceTable {
  ratingsByName: Map<string, {rating: number; maps: number}>;
  leagueMean: number;
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
      // Maps column sits right after rating on HLTV player stats tables.
      const mapsText = $(row).find("td").eq(2).text().trim();
      const maps = parseInt(mapsText.replace(/[^0-9]/g, ""), 10) || 0;

      if (rawName && !isNaN(rating)) {
        stats.push({name: rawName, rating, maps});
      }
    });

    return stats;
  }

  private loadSource(filename: string): SourceTable {
    const filePath = path.join(process.cwd(), "source", filename);
    if (!fs.existsSync(filePath)) {
      console.warn(`Missing historical source file: ${filePath}`);
      return {ratingsByName: new Map(), leagueMean: 1.06};
    }
    const stats = this.parseHtml(fs.readFileSync(filePath, "utf-8"));
    const ratingsByName = new Map<string, {rating: number; maps: number}>();
    let sum = 0;
    for (const s of stats) {
      ratingsByName.set(normalizePlayerName(s.name), {
        rating: s.rating,
        maps: s.maps,
      });
      sum += s.rating;
    }
    return {
      ratingsByName,
      leagueMean: stats.length > 0 ? sum / stats.length : 1.06,
    };
  }

  async enrichPlayersWithHistoricalStats(
    players: FantasyPlayer[],
  ): Promise<FantasyPlayer[]> {
    const tables = {} as Record<HistoricalSourceKey, SourceTable>;
    for (const source of HISTORICAL_SOURCES) {
      try {
        tables[source.key] = this.loadSource(
          HISTORICAL_SOURCE_FILES[source.key],
        );
      } catch (error) {
        console.warn(
          `Error reading stats from source/${source.filename}:`,
          error,
        );
        tables[source.key] = {ratingsByName: new Map(), leagueMean: 1.06};
      }
    }

    return players.map((player) => {
      const normalized = normalizePlayerName(player.name);
      const histRatings: Partial<Record<HistoricalSourceKey, number>> = {};
      const histMaps: Partial<Record<HistoricalSourceKey, number>> = {};
      for (const source of HISTORICAL_SOURCES) {
        const entry = tables[source.key].ratingsByName.get(normalized);
        if (entry) {
          histRatings[source.key] = entry.rating;
          histMaps[source.key] = entry.maps;
        }
      }
      return {
        ...player,
        stats: {
          ...player.stats,
          histRatings,
          histMaps,
        },
      };
    });
  }
}

export const statsScraperService = new StatsScraperService();
