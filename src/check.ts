/**
 * Setup check: runs one message through the database, the queue, the agent runtime and the
 * model backend, without Telegram. Run with `npm run check` after setup.
 */
import "dotenv/config";
import { chiefOfStaff } from "./agents/chiefOfStaff.ts";
import { AgentRuntime } from "./agents/runtime.ts";
import { ApprovalService } from "./approvals/service.ts";
import { migrate } from "./db/migrate.ts";
import { clearMessages } from "./db/messages.ts";
import { createPool } from "./db/pool.ts";
import { logger as log } from "./logger.ts";
import { createModelBackend } from "./models/index.ts";
import { startQueue } from "./queue/boss.ts";
import { Jobs } from "./queue/jobs.ts";
import { TaskService } from "./tasks/service.ts";
import { registerWorkers } from "./worker.ts";
import type { Config } from "./config.ts";

const CHECK_CHAT_ID = -1;

const env = process.env;
const config = {
  MODEL_BACKEND: (env.MODEL_BACKEND as Config["MODEL_BACKEND"]) ?? "claude-code",
  MODEL_FAST: env.MODEL_FAST ?? "haiku",
  MODEL_STANDARD: env.MODEL_STANDARD ?? "sonnet",
  MODEL_DEEP: env.MODEL_DEEP ?? "opus",
  CLAUDE_BIN: env.CLAUDE_BIN ?? "claude",
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
} as Config;

const url = env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");

const db = createPool(url);
await migrate(db);
console.log("✓ database reachable and migrated");

const boss = await startQueue(url, log);
console.log("✓ queue started");

const tasks = new TaskService(db, env.TIMEZONE ?? "UTC");
const runtime = new AgentRuntime(db, createModelBackend(config), tasks, { memoryMessages: 10, timezone: env.TIMEZONE ?? "UTC" });
const replies: string[] = [];
const done = new Promise<void>((resolve) => {
  void registerWorkers({
    boss,
    runtime,
    approvals: new ApprovalService(db),
    tasks,
    outbox: {
      toOwner: async (text) => {
        replies.push(text);
        resolve();
      },
      taskReminder: async () => undefined,
      typing: async () => undefined,
    },
    ownerChatId: CHECK_CHAT_ID,
    log,
  });
});

await boss.send(Jobs.inboundMessage, { chatId: CHECK_CHAT_ID, text: "This is a setup check. Reply with one short sentence confirming you're online." });
const timeout = setTimeout(() => {
  console.error("✗ no reply within 3 minutes");
  process.exit(1);
}, 180_000);
await done;
clearTimeout(timeout);

console.log(`✓ ${chiefOfStaff.name} replied via ${config.MODEL_BACKEND}: ${replies[0]}`);
await clearMessages(db, CHECK_CHAT_ID);
await boss.stop();
await db.end();
