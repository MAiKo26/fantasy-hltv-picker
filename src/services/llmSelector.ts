import {GoogleGenAI} from "@google/genai";
import {env} from "../env.ts";
import type {MathLineup} from "./mathOptimizer.ts";

export type LlmProgressCallback = (
  completed: number,
  total: number,
  label: string,
) => void;

interface LineupScore {
  index: number;
  score: number;
  reasoning: string;
  roles: Record<string, string>;
  boosters: Record<string, string>;
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

    try {
      const response = await this.ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
      });

      const text = response.text || "{}";
      const cleanText = text
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();
      const parsed = JSON.parse(cleanText);

      return {
        index,
        score: typeof parsed.score === "number" ? parsed.score : 50,
        reasoning: parsed.reasoning ?? "",
        roles: parsed.roles ?? {},
        boosters: parsed.boosters ?? {},
      };
    } catch {
      return {
        index,
        score: 0,
        reasoning: "LLM evaluation failed for this lineup.",
        roles: {},
        boosters: {},
      };
    }
  }

  /**
   * Evaluate all lineups one-by-one (sequential), calling onProgress after each.
   * Returns the best-scoring lineup's full result.
   */
  async selectBestLineup(
    lineups: MathLineup[],
    onProgress?: LlmProgressCallback,
  ): Promise<{
    bestLineupIndex: number;
    reasoning: string;
    roles: Record<string, string>;
    boosters: Record<string, string>;
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

    // Pick the highest scoring lineup
    const best = scores.reduce((a, b) => (b.score > a.score ? b : a));

    return {
      bestLineupIndex: best.index,
      reasoning: best.reasoning,
      roles: best.roles,
      boosters: best.boosters,
    };
  }
}

export const llmSelector = new LlmSelector();
