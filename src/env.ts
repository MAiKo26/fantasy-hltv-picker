import {z} from "zod";

const envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  HLTV_STATS_3M_LAN_TOP20_URL: z.string().url("Must be a valid URL"),
  HLTV_STATS_6M_LAN_TOP20_URL: z.string().url("Must be a valid URL"),
  HLTV_STATS_12M_TOP50_URL: z.string().url("Must be a valid URL"),
});

export const env = envSchema.parse({
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  HLTV_STATS_3M_LAN_TOP20_URL: process.env.HLTV_STATS_3M_LAN_TOP20_URL,
  HLTV_STATS_6M_LAN_TOP20_URL: process.env.HLTV_STATS_6M_LAN_TOP20_URL,
  HLTV_STATS_12M_TOP50_URL: process.env.HLTV_STATS_12M_TOP50_URL,
});
