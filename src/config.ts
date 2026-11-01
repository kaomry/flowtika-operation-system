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
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  // Comma-separated addresses that are all the owner's, so mail between them isn't outreach
  OWNER_EMAILS: z
    .string()
    .optional()
    .transform((v) => (v ?? "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean)),
  NOTION_TOKEN: optionalString,
  NOTION_LEADS_DATA_SOURCE: z.string().default("c84cae23-1208-8343-973d-871608f38a92"),
  OUTREACH_STYLE_GUIDE: z.string().default("~/.flowtika/data/cold-email-style-guide.md"),
  // Lines separated by "\n" in .env
  OUTREACH_SIGNATURE: z
    .string()
    .default("Omry Kaufman\nFounder & RevOps Strategic\n055-4222014")
    .transform((v) => v.replace(/\\n/g, "\n")),
  OUTREACH_STATUS_SYNC_CRON: z.string().default("*/30 * * * *").transform((v) => v.trim() || undefined),
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
