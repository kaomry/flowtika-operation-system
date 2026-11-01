import "dotenv/config";
import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_OWNER_ID: z.coerce.number().int().positive(),
  MODEL_BACKEND: z.enum(["claude-code", "api"]).default("claude-code"),
  ANTHROPIC_API_KEY: optionalString,
  MODEL_FAST: z.string().default("haiku"),
  MODEL_STANDARD: z.string().default("sonnet"),
  MODEL_DEEP: z.string().default("opus"),
  CLAUDE_BIN: z.string().default("claude"),
  WHISPER_BIN: z.string().default("whisper-cli"),
  WHISPER_MODEL: optionalString,
  WHISPER_LANGUAGE: z.string().default("auto"),
  FFMPEG_BIN: z.string().default("ffmpeg"),
  TIMEZONE: z.string().default("Asia/Jerusalem"),
  DAILY_BRIEF_CRON: optionalString,
  MEMORY_MESSAGES: z.coerce.number().int().positive().default(30),
  LOG_LEVEL: z.string().default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration. Check your .env file:\n${problems}`);
  }
  const config = parsed.data;
  if (config.MODEL_BACKEND === "api" && !config.ANTHROPIC_API_KEY) {
    throw new Error("MODEL_BACKEND=api needs ANTHROPIC_API_KEY to be set.");
  }
  return config;
}
