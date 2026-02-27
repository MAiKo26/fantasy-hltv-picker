import {GoogleGenAI} from "@google/genai";
import {env} from "../env.ts";
import type {MathLineup} from "./mathOptimizer.ts";
import {writeFileSync, appendFileSync, existsSync} from "node:fs";
import {resolve} from "node:path";
import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";

const LOG_FILE = resolve(process.cwd(), "llm-errors.log");

function log(message: string) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}\n`;
  console.error(entry.trim());
  appendFileSync(LOG_FILE, entry);
}

function setupLogFile() {
  if (!existsSync(LOG_FILE)) {
    writeFileSync(LOG_FILE, "");
  }
}

setupLogFile();

export type LlmProgressCallback = (
  completed: number,
  total: number,
  label: string,
) => void;

const lineupScoreSchema = z.object({
  score: z.number().describe("0-100 score based on expected fantasy points"),
  reasoning: z
    .string()
    .describe(
      "ONE sentence reasoning focusing on point ceiling and role/booster synergy",
    ),
  roles: z
    .record(z.string(), z.string())
    .describe(
      "Assigned roles matching player stats. Keys are player names, values are roles.",
    ),
});

interface LineupScore {
  index: number;
  score: number;
  reasoning: string;
  roles: Record<string, string>;
}

export class LlmSelector {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({apiKey: env.GEMINI_API_KEY});
  }

  /** Score a single lineup and return its evaluation */
  private async scoreLineup(
    lineup: MathLineup,
    index: number,
    timeoutMs = 30000,
  ): Promise<LineupScore> {
    const promptData = {
      index,
      players: lineup.players.map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        stats: p.stats,
      })),
    };

    const prompt = `
You are an elite Fantasy CS2 analyst. Evaluate this lineup for HLTV Fantasy scoring potential.

## SCORING SYSTEM (CRITICAL - USE THIS TO EVALUATE)

### ROLES (5/2 points - can EARN or LOSE points based on performance)
Each role has MAX bonus, SMALL bonus, and PENALTY thresholds:
- Main AWP: AWP kills pr round. Max: >0.35, Small: ≥0.20, Penalty: <0.20
- Support: Support rounds (assist/survived/traded). Max: >25%, Small: ≥17%, Penalty: <17%
- Attacker: T side rating. Max: >1.30, Small: ≥0.9, Penalty: <0.9
- Leader: Team match result. Max: win all maps, Small: win with 1 loss or OT, Penalty: lose
- Stathunter: Match rating. Max: >1.30, Small: ≥1.00, Penalty: <1.00
- Entry Fragger: First kills pr round. Max: >0.15, Small: ≥0.08, Penalty: <0.08
- Camper: Deaths pr round (lower is better). Max: <0.55, Small: ≤0.65, Penalty: >0.65
- Defender: CT side rating. Max: >1.35, Small: ≥1.00, Penalty: <1.00
- HS Machine: Headshot %. Max: >60%, Small: ≥50%, Penalty: <50%
- Noob: Match rating (lower is better). Max: <0.85, Small: ≤1.12, Penalty: >1.12
- Multi Fragger: Multi kills pr round. Max: >0.20, Small: ≥0.14, Penalty: <0.14
- Eco Friendly: SMG/shotgun kills pr round. Max: >0.07, Small: ≥0.02, Penalty: <0.02

## YOUR TASK
1. Score 0-100 based on expected fantasy points (consider role potential)
2. Assign roles that MATCH player stats (e.g., high entry % → Entry Fragger, high AWP → Main AWP)
3. Write ONE sentence reasoning focusing on point ceiling and role/booster synergy

Lineup to evaluate:
${JSON.stringify(promptData, null, 2)}
`;

    const makeRequest = async () => {
      const response = await this.ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: zodToJsonSchema(lineupScoreSchema as any),
        },
      });

      const text = response.text || "{}";
      log(`Lineup ${index} raw response: ${text.substring(0, 500)}`);

      const parsed = lineupScoreSchema.parse(JSON.parse(text));

      return {
        index,
        score: parsed.score,
        reasoning: parsed.reasoning,
        roles: parsed.roles,
      };
    };

    try {
      return await Promise.race([
        makeRequest(),
        new Promise<LineupScore>((_, reject) =>
          setTimeout(() => reject(new Error("Request timeout")), timeoutMs),
        ),
      ]);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Lineup ${index} FAILED: ${errorMsg}`);
      return {
        index,
        score: 0,
        reasoning: "LLM evaluation failed for this lineup.",
        roles: {},
      };
    }
  }

  /**
   * Evaluate all lineups one-by-one (sequential), calling onProgress after each.
   * Returns the top 3 scoring lineups and all scored lineups.
   */
  async selectBestLineup(
    lineups: MathLineup[],
    onProgress?: LlmProgressCallback,
  ): Promise<{
    top3: Array<{
      lineupIndex: number;
      reasoning: string;
      roles: Record<string, string>;
      score: number;
    }>;
    allScoredLineups: Array<{
      lineupIndex: number;
      reasoning: string;
      roles: Record<string, string>;
      score: number;
    }>;
  }> {
    const scores: LineupScore[] = [];

    for (let i = 0; i < lineups.length; i++) {
      const lineup = lineups[i]!;
      const result = await this.scoreLineup(lineup, i);
      scores.push(result);

      onProgress?.(
        i + 1,
        lineups.length,
        `Evaluated lineup ${i + 1}/${lineups.length} — score: ${result.score}`,
      );
    }

    // Sort by score descending and take top 3
    const sorted = [...scores].sort((a, b) => b.score - a.score);
    const top3 = sorted.slice(0, 3);

    return {
      top3: top3.map((s) => ({
        lineupIndex: s.index,
        reasoning: s.reasoning,
        roles: s.roles,
        score: s.score,
      })),
      allScoredLineups: sorted.map((s) => ({
        lineupIndex: s.index,
        reasoning: s.reasoning,
        roles: s.roles,
        score: s.score,
      })),
    };
  }
}

export const llmSelector = new LlmSelector();
