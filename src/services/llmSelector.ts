import {GoogleGenAI} from "@google/genai";
import {env} from "../env.ts";
import type {MathLineup} from "./mathOptimizer.ts";

export class LlmSelector {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({apiKey: env.GEMINI_API_KEY});
  }

  async selectBestLineup(lineups: MathLineup[]): Promise<{
    bestLineupIndex: number;
    reasoning: string;
    roles: Record<string, string>; // player ID -> role name
    boosters: Record<string, string>; // player ID -> booster name
  }> {
    // Dump the minimal data to keep prompt small
    const promptData = lineups.map((l, i) => ({
      index: i,
      strategy: l.strategyUsed,
      totalPrice: l.totalPrice,
      players: l.players.map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        stats: p.stats,
      })),
    }));

    const prompt = `
      You are an elite optimal Fantasy CS2 builder. Your goal is to reach the top 1% by picking the absolute best roster from these pre-validated options.
      I am providing you with the top ${lineups.length} mathematically optimal lineups. All lineups strictly obey the budget and team composition rules.
      
      Your task:
      1. Pick the ONE best lineup index. Focus on players with high variance/ceilings, good recent form, and strong team synergies.
      2. For the 5 players in your chosen lineup, assign exactly 5 ROLES.
      3. For the 5 players, assign exactly 5 BOOSTERS.

      Role Options: Main AWP, Support, Attacker, Leader, Stathunter, Entry Fragger, Camper, Defender, HS Machine, Noob, Multi Fragger, Eco Friendly.
      Booster Options: Best pistol round, Bottom of scoreboard, Clutch, Top of scoreboard, Avenger, Bait, Rambo, Flash, Mister consistent, Kobe, Saver, Assist, Aim bot, Quad, Carry, Cannon fodder, Farmer, Hellcase.

      Respond ONLY in the following JSON structure exactly, no markdown formatting out of bounds:
      {
        "bestLineupIndex": 0,
        "reasoning": "I chose this because...",
        "roles": { "player1_id": "Main AWP", "player2_id": "Attacker" },
        "boosters": { "player1_id": "Carry", "player2_id": "Clutch" }
      }

      Here are the lineups:
      ${JSON.stringify(promptData, null, 2)}
    `;

    try {
      const response = await this.ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
      });

      const text = response.text || "{}";
      const cleanText = text
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();
      const parsed = JSON.parse(cleanText);

      return {
        bestLineupIndex: parsed.bestLineupIndex ?? 0,
        reasoning: parsed.reasoning ?? "Fallback reasoning",
        roles: parsed.roles ?? {},
        boosters: parsed.boosters ?? {},
      };
    } catch (e) {
      console.error("LLM Selection failed, falling back to top math lineup", e);
      return {
        bestLineupIndex: 0,
        reasoning: "LLM failed, choosing highest raw math score.",
        roles: {},
        boosters: {},
      };
    }
  }
}

export const llmSelector = new LlmSelector();
