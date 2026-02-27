import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";
import type { ExtractionResult, FantasyPlayer, FantasyTeam, CardLevel } from "../types/player.ts";

const SOURCE_DIR = path.join(process.cwd(), "source");

function getCardLevel(element: cheerio.Cheerio<any>): CardLevel {
  const classList = element.attr("class") || "";
  if (classList.includes("gold")) return "gold";
  if (classList.includes("silver")) return "silver";
  if (classList.includes("bronze")) return "bronze";
  return "silver";
}

function parsePrice(priceText: string | undefined): number {
  if (!priceText) return 0;
  const cleaned = priceText.replace(/[$,]/g, "").trim();
  return parseInt(cleaned, 10) || 0;
}

function parseRank(rankText: string): number {
  if (!rankText) return 0;
  const match = rankText.match(/#(\d+)/);
  return match && match[1] ? parseInt(match[1], 10) : 0;
}

function parseStatValue(valueText: string | undefined): number {
  if (!valueText) return 0;
  const cleaned = valueText.replace("%", "").trim();
  return parseFloat(cleaned) || 0;
}

export async function listSourceFiles(): Promise<string[]> {
  if (!fs.existsSync(SOURCE_DIR)) {
    return [];
  }
  const files = fs.readdirSync(SOURCE_DIR);
  return files.filter((f) => f.endsWith(".html"));
}

export async function extractFromHtml(sourceFile: string): Promise<ExtractionResult> {
  const filePath = path.join(SOURCE_DIR, sourceFile);
  
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const html = fs.readFileSync(filePath, "utf-8");
  const $ = cheerio.load(html);

  const teams: FantasyTeam[] = [];
  const players: FantasyPlayer[] = [];

  $(".teamCon").each((_, teamEl) => {
    const teamName = $(teamEl).find(".teamName").text().trim();
    const teamRankText = $(teamEl).find(".teamRank").text().trim();
    const teamRank = parseRank(teamRankText);

    const roster: string[] = [];

    $(teamEl).find(".teamPlayer").each((_playerIndex, playerEl) => {
      const nameEl = $(playerEl).find(".card-player-tag");
      const playerName = nameEl.text().trim();
      
      if (playerName) {
        roster.push(playerName);

        const cardLevelEl = $(playerEl).find(".player-card-level");
        const cardLevel = getCardLevel(cardLevelEl);

        const priceText = $(playerEl).find(".playerButtonText").first().text();
        const price = parsePrice(priceText);

        const statsUrlEl = $(playerEl).find(".player-stats-link");
        const statsUrl = statsUrlEl.attr("href") ?? "";

        const stats: Record<string, number> = {};
        $(playerEl).find(".stat-flex").each((_, statEl) => {
          const desc = $(statEl).find(".back-desc").text().trim();
          const value = $(statEl).find(".back-value").text().trim();
          
          const keyMap: Record<string, string> = {
            "Rating": "rating",
            "CT rating": "ctRating",
            "T rating": "tRating",
            "AWP": "awpPerRound",
            "HS %": "headshotPct",
            "Entry rounds": "entryRoundsPct",
            "Clutch rounds": "clutchRoundsPct",
            "Support rounds": "supportRoundsPct",
            "Multi kill rounds": "multiKillRoundsPct",
            "Deaths per round": "deathsPerRound",
          };
          
          const key = keyMap[desc];
          if (key) {
            stats[key] = parseStatValue(value);
          }
        });

        players.push({
          id: `${teamName.toLowerCase()}-${playerName.toLowerCase()}`,
          name: playerName,
          team: teamName,
          cardLevel,
          price,
          stats: {
            rating: stats.rating || 0,
            ctRating: stats.ctRating || 0,
            tRating: stats.tRating || 0,
            awpPerRound: stats.awpPerRound || 0,
            headshotPct: stats.headshotPct || 0,
            entryRoundsPct: stats.entryRoundsPct || 0,
            clutchRoundsPct: stats.clutchRoundsPct || 0,
            supportRoundsPct: stats.supportRoundsPct || 0,
            multiKillRoundsPct: stats.multiKillRoundsPct || 0,
            deathsPerRound: stats.deathsPerRound || 0,
          },
          statsUrl,
        });
      }
    });

    if (teamName) {
      teams.push({
        name: teamName,
        worldRank: teamRank,
        players: roster,
      });
    }
  });

  return {
    players,
    teams,
    sourceFile,
    extractedAt: new Date(),
  };
}

export class HtmlExtractorService {
  async extract(sourceFile: string): Promise<ExtractionResult> {
    return extractFromHtml(sourceFile);
  }

  async listFiles(): Promise<string[]> {
    return listSourceFiles();
  }
}
