import * as cheerio from "cheerio";
import {env} from "../env.ts";
import {cacheService} from "./cacheService.ts";
import type {FantasyPlayer} from "../types/player.ts";

export interface historicalPlayerStat {
  name: string;
  rating: number;
}

export class StatsScraperService {
  private async fetchAndParse(
    url: string,
    cacheKey: string,
  ): Promise<historicalPlayerStat[]> {
    const cached = cacheService.get<historicalPlayerStat[]>(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
      });

      if (!response.ok) {
        console.warn(
          `Failed to fetch stats from ${url}: ${response.statusText}`,
        );
        return [];
      }

      const html = await response.text();
      const $ = cheerio.load(html);
      const stats: historicalPlayerStat[] = [];

      $("tbody tr").each((_, row) => {
        const nameNode = $(row).find(".playerCol a");
        let name = nameNode.text().trim();
        const ratingNode = $(row).find(".ratingCol").first();
        const rating = parseFloat(ratingNode.text().trim());

        if (name && !isNaN(rating)) {
          stats.push({name, rating});
        }
      });

      cacheService.set(cacheKey, stats);
      return stats;
    } catch (error) {
      console.warn(`Error scraping stats from ${url}:`, error);
      return [];
    }
  }

  async enrichPlayersWithHistoricalStats(
    players: FantasyPlayer[],
  ): Promise<FantasyPlayer[]> {
    const [stats3m, stats6m, stats12m] = await Promise.all([
      this.fetchAndParse(env.HLTV_STATS_3M_LAN_TOP20_URL, "stats_3m_top20"),
      this.fetchAndParse(env.HLTV_STATS_6M_LAN_TOP20_URL, "stats_6m_top20"),
      this.fetchAndParse(env.HLTV_STATS_12M_TOP50_URL, "stats_12m_top50"),
    ]);

    const buildDict = (stats: historicalPlayerStat[]) => {
      const dict: Record<string, number> = {};
      stats.forEach((s) => (dict[s.name.toLowerCase()] = s.rating));
      return dict;
    };

    const dict3m = buildDict(stats3m);
    const dict6m = buildDict(stats6m);
    const dict12m = buildDict(stats12m);

    return players.map((player) => {
      const loweredName = player.name.toLowerCase();
      return {
        ...player,
        stats: {
          ...player.stats,
          rating3mTop20: dict3m[loweredName],
          rating6mTop20: dict6m[loweredName],
          rating12mTop50: dict12m[loweredName],
        },
      };
    });
  }
}
