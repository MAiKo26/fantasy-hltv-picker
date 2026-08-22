import {z} from "zod";
import {HISTORICAL_SOURCES} from "./services/historicalSources.ts";

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
  WEIGHT_CARD_RATING_BENEFIT: z.coerce.number().optional(),
  WEIGHT_TOP_TEAM_RANK_BENEFIT: z.coerce.number().optional(),
  WEIGHT_AWPER_ROLE_BENEFIT: z.coerce.number().optional(),
  WEIGHT_LOW_DEATH_RATE_BENEFIT: z.coerce.number().optional(),
  WEIGHT_CT_VS_T_RATING_IMBALANCE_PENALTY: z.coerce.number().optional(),
  WEIGHT_STACK_CORRELATION_BENEFIT: z.coerce.number().optional(),
  WEIGHT_TOP_RANKED_TEAM_STACK_BENEFIT: z.coerce.number().optional(),
  WEIGHT_AWP_PER_ROUND_WEIGHT: z.coerce.number().optional(),
  WEIGHT_DEATH_PENALTY_WEIGHT: z.coerce.number().optional(),
  WEIGHT_PRICE_EFFICIENCY_BENEFIT: z.coerce.number().optional(),
  WEIGHT_FIELD_SIDE_3_PLAYER_PENALTY: z.coerce.number().optional(),
  WEIGHT_FIELD_SIDE_4PLUS_PLAYER_PENALTY: z.coerce.number().optional(),
  WEIGHT_FIELD_SIDE_CROSS_TEAM_PENALTY: z.coerce.number().optional(),
  THRESHOLD_AWPER_ROLE_MIN_AWP_PER_ROUND: z.coerce.number().optional(),
  THRESHOLD_LOW_DEATH_RATE_MAX_DEATHS_PER_ROUND: z.coerce.number().optional(),
});

const parsed = envSchema.parse(process.env);

/** Historical-source weights are resolved dynamically from the registry. */
const histWeightOverrides = {} as Record<string, number | undefined>;
for (const source of HISTORICAL_SOURCES) {
  const raw = process.env[source.envVar];
  if (raw != null && raw !== "") {
    const value = Number(raw);
    if (Number.isFinite(value)) {
      histWeightOverrides[source.envVar] = value;
    }
  }
}

/** Shrinkage controls. */
function parseShrinkage() {
  const enabled = process.env.SHRINKAGE_ENABLED;
  const prior = process.env.SHRINKAGE_LEAGUE_PRIOR;
  const strength = process.env.SHRINKAGE_STRENGTH;
  return {
    enabled: enabled == null ? true : enabled === "true",
    leaguePrior: prior != null && prior !== "" ? Number(prior) : undefined,
    strength: strength != null && strength !== "" ? Number(strength) : undefined,
  };
}

export const env = {
  ...parsed,
  HIST_WEIGHT_OVERRIDES: histWeightOverrides,
  SHRINKAGE: parseShrinkage(),
};
