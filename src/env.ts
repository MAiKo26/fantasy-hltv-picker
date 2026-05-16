import {z} from "zod";

const envSchema = z.object({
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
  WEIGHT_HISTORICAL_12M: z.coerce.number().optional(),
  WEIGHT_TEAM_RANK_BONUS: z.coerce.number().optional(),
  WEIGHT_AWP_BONUS: z.coerce.number().optional(),
  WEIGHT_SURVIVAL_BONUS: z.coerce.number().optional(),
  WEIGHT_SIDE_VARIANCE_PENALTY: z.coerce.number().optional(),
  WEIGHT_TEAM_OUTCOME: z.coerce.number().optional(),
  WEIGHT_STACK_CORRELATION: z.coerce.number().optional(),
  WEIGHT_MATCHUP_RISK_PENALTY: z.coerce.number().optional(),
  WEIGHT_STACK_RANK_BONUS: z.coerce.number().optional(),
});

export const env = envSchema.parse({
  BLACKLISTED_PLAYERS: process.env.BLACKLISTED_PLAYERS,
  SCORING_DIAGNOSTICS: process.env.SCORING_DIAGNOSTICS,
  WEIGHT_HISTORICAL_12M: process.env.WEIGHT_HISTORICAL_12M,
  WEIGHT_TEAM_RANK_BONUS: process.env.WEIGHT_TEAM_RANK_BONUS,
  WEIGHT_AWP_BONUS: process.env.WEIGHT_AWP_BONUS,
  WEIGHT_SURVIVAL_BONUS: process.env.WEIGHT_SURVIVAL_BONUS,
  WEIGHT_SIDE_VARIANCE_PENALTY: process.env.WEIGHT_SIDE_VARIANCE_PENALTY,
  WEIGHT_TEAM_OUTCOME: process.env.WEIGHT_TEAM_OUTCOME,
  WEIGHT_STACK_CORRELATION: process.env.WEIGHT_STACK_CORRELATION,
  WEIGHT_MATCHUP_RISK_PENALTY: process.env.WEIGHT_MATCHUP_RISK_PENALTY,
  WEIGHT_STACK_RANK_BONUS: process.env.WEIGHT_STACK_RANK_BONUS,
});
