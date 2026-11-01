import { AgentRuntime } from "./agents/runtime.ts";
import { ApprovalService } from "./approvals/service.ts";
import { loadConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";
import { logger as log } from "./logger.ts";
import { createModelBackend } from "./models/index.ts";
import { startQueue } from "./queue/boss.ts";
import { applySchedules, defaultSchedules } from "./scheduler/schedules.ts";
import { createBot } from "./telegram/bot.ts";
import { TaskService } from "./tasks/service.ts";
import { WhisperCppTranscriber } from "./voice/transcriber.ts";
import { registerWorkers } from "./worker.ts";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);

const applied = await migrate(db);
if (applied.length) log.info({ applied }, "migrations applied");

const boss = await startQueue(config.DATABASE_URL, log);
const backend = createModelBackend(config);
const tasks = new TaskService(db, config.TIMEZONE);
const runtime = new AgentRuntime(db, backend, tasks, {
  memoryMessages: config.MEMORY_MESSAGES,
  timezone: config.TIMEZONE,
});
const approvals = new ApprovalService(db);

const { bot, outbox, presenter } = createBot({
  token: config.TELEGRAM_BOT_TOKEN,
  ownerId: config.TELEGRAM_OWNER_ID,
  db,
  boss,
  approvals,
  tasks,
  timezone: config.TIMEZONE,
  log,
});
approvals.setPresenter(presenter);

// A harmless action that exists so the approval flow can be tried end to end.
approvals.register("demo.note", async (payload) => {
  await outbox.toOwner(String(payload.text ?? ""));
  return { sent: true };
});

const transcriber = config.WHISPER_MODEL
  ? new WhisperCppTranscriber({
      whisperBin: config.WHISPER_BIN,
      modelPath: config.WHISPER_MODEL,
      ffmpegBin: config.FFMPEG_BIN,
      language: config.WHISPER_LANGUAGE,
    })
  : undefined;
if (!transcriber) log.warn("WHISPER_MODEL is not set, so voice notes are off");

await registerWorkers({
  boss,
  runtime,
  approvals,
  tasks,
  transcriber,
  outbox,
  ownerChatId: config.TELEGRAM_OWNER_ID,
  log,
});
await applySchedules(boss, defaultSchedules(config.DAILY_BRIEF_CRON), config.TIMEZONE, log);

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await bot.stop();
  await boss.stop();
  await db.end();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

log.info({ backend: backend.name }, "Flowtika OS is running. Message your bot on Telegram.");
await bot.start({ drop_pending_updates: false });
