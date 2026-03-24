import {z} from "zod";

const envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  BLACKLISTED_PLAYERS: z
    .string()
    .default("")
    .transform((val) =>
      val
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  SCORING_DIAGNOSTICS: z
    .string()
    .optional()
    .transform((val) => val === "true"),
});

export const env = envSchema.parse({
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  BLACKLISTED_PLAYERS: process.env.BLACKLISTED_PLAYERS,
  SCORING_DIAGNOSTICS: process.env.SCORING_DIAGNOSTICS,
});
