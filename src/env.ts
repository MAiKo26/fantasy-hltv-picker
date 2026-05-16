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
  WEIGHT_ROLE_EXPECTED: z.coerce.number().optional(),
  WEIGHT_BOOSTER_EXPECTED: z.coerce.number().optional(),
  WEIGHT_TEAM_OUTCOME: z.coerce.number().optional(),
  WEIGHT_PLAYER_LEVERAGE: z.coerce.number().optional(),
  WEIGHT_LINEUP_LEVERAGE: z.coerce.number().optional(),
  WEIGHT_OWNERSHIP_BAND: z.coerce.number().optional(),
  WEIGHT_STACK_CORRELATION: z.coerce.number().optional(),
  WEIGHT_MATCHUP_RISK_PENALTY: z.coerce.number().optional(),
  WEIGHT_CHALK_WEAK_PENALTY: z.coerce.number().optional(),
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
  WEIGHT_ROLE_EXPECTED: process.env.WEIGHT_ROLE_EXPECTED,
  WEIGHT_BOOSTER_EXPECTED: process.env.WEIGHT_BOOSTER_EXPECTED,
  WEIGHT_TEAM_OUTCOME: process.env.WEIGHT_TEAM_OUTCOME,
  WEIGHT_PLAYER_LEVERAGE: process.env.WEIGHT_PLAYER_LEVERAGE,
  WEIGHT_LINEUP_LEVERAGE: process.env.WEIGHT_LINEUP_LEVERAGE,
  WEIGHT_OWNERSHIP_BAND: process.env.WEIGHT_OWNERSHIP_BAND,
  WEIGHT_STACK_CORRELATION: process.env.WEIGHT_STACK_CORRELATION,
  WEIGHT_MATCHUP_RISK_PENALTY: process.env.WEIGHT_MATCHUP_RISK_PENALTY,
  WEIGHT_CHALK_WEAK_PENALTY: process.env.WEIGHT_CHALK_WEAK_PENALTY,
  WEIGHT_STACK_RANK_BONUS: process.env.WEIGHT_STACK_RANK_BONUS,
});
