import { Bot, InlineKeyboard } from "grammy";
import type { PgBoss } from "pg-boss";
import type { ApprovalPresenter, ApprovalService } from "../approvals/service.ts";
import { audit } from "../db/audit.ts";
import { clearMessages } from "../db/messages.ts";
import type { Db } from "../db/pool.ts";
import type { Logger } from "../logger.ts";
import { Jobs, type ApprovalExecuteJob, type InboundMessageJob, type InboundVoiceJob } from "../queue/jobs.ts";
import { describeTask } from "../agents/taskActions.ts";
import type { Task, TaskService } from "../tasks/service.ts";
import { formatLocal, parseDueDate } from "../tasks/time.ts";
import type { Outbox } from "../worker.ts";
import {
  approvalCallback,
  approvalCardText,
  parseApprovalCallback,
  parseTaskCallback,
  splitForTelegram,
  taskCallback,
} from "./format.ts";

const HELP = `Flowtika OS

Write or send a voice note, in Hebrew or English. I remember our conversation and keep your task list: "remind me to call Dana tomorrow at 10", "the proposal is waiting on the client", "what's on my plate?"

/tasks  all open tasks
/today  tasks due today or overdue
/done 3  mark task #3 done
/pending  approvals waiting for you
/reset  forget this conversation
/demo_approval  try the approval buttons
/help  this message`;

export function createBot(deps: {
  token: string;
  ownerId: number;
  db: Db;
  boss: PgBoss;
  approvals: ApprovalService;
  tasks: TaskService;
  timezone: string;
  log: Logger;
}) {
  const { token, ownerId, db, boss, approvals, tasks, timezone, log } = deps;
  const taskLines = (list: Task[]) => list.map((t) => `${describeTask(t, timezone)}`).join("\n");
  const bot = new Bot(token);

  // Only the owner can use the bot. Anyone else is ignored and logged.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id === ownerId) return next();
    await audit(db, "telegram", "access.denied", { fromId: ctx.from?.id, username: ctx.from?.username });
    log.warn({ fromId: ctx.from?.id }, "ignored message from a non-owner");
  });

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP));

  bot.command("reset", async (ctx) => {
    await clearMessages(db, ctx.chat.id);
    await audit(db, "owner", "memory.reset", { chatId: ctx.chat.id });
    await ctx.reply("Done. I've forgotten this conversation.");
  });

  bot.command("pending", async (ctx) => {
    const pending = await approvals.listPending();
    if (!pending.length) return ctx.reply("Nothing is waiting for your approval.");
    await ctx.reply(pending.map((a, i) => `${i + 1}. ${a.kind}: ${a.summary}`).join("\n"));
  });

  bot.command("tasks", async (ctx) => {
    const open = await tasks.listOpen();
    await ctx.reply(open.length ? `Open tasks:\n${taskLines(open)}` : "No open tasks.");
  });

  bot.command("today", async (ctx) => {
    const due = await tasks.dueToday();
    await ctx.reply(due.length ? `Due today or overdue:\n${taskLines(due)}` : "Nothing is due today.");
  });

  bot.command("done", async (ctx) => {
    const id = Number(ctx.match.trim().replace(/^#/, ""));
    if (!Number.isInteger(id) || id <= 0) return ctx.reply("Which task? For example: /done 3");
    const task = await tasks.update(id, { status: "done" }, "owner");
    await ctx.reply(task ? `✓ Done: ${task.title}` : `There is no task #${id}.`);
  });

  bot.command("demo_approval", async (ctx) => {
    await approvals.request({
      kind: "demo.note",
      summary: 'Send you the note "The approval gate works." Nothing leaves Telegram.',
      payload: { text: "The approval gate works." },
      requestedBy: "chief-of-staff",
    });
  });

  bot.on("callback_query:data", async (ctx, next) => {
    const parsed = parseTaskCallback(ctx.callbackQuery.data);
    if (!parsed) return next();
    let task: Task | null;
    let note: string;
    if (parsed.button === "done") {
      task = await tasks.update(parsed.id, { status: "done" }, "owner");
      note = "Marked done";
    } else {
      const dueAt =
        parsed.button === "hour"
          ? new Date(Date.now() + 60 * 60 * 1000)
          : tomorrowAtNine(timezone);
      task = await tasks.update(parsed.id, { dueAt }, "owner");
      note = `Snoozed to ${formatLocal(dueAt, timezone)}`;
    }
    if (!task) return ctx.answerCallbackQuery({ text: "That task no longer exists." });
    await ctx.editMessageText(`⏰ ${task.title}\n\n${note}`).catch(() => undefined);
    await ctx.answerCallbackQuery({ text: note });
  });

  bot.on("callback_query:data", async (ctx) => {
    const parsed = parseApprovalCallback(ctx.callbackQuery.data);
    if (!parsed) return ctx.answerCallbackQuery();
    const decided = await approvals.decide(parsed.id, parsed.decision);
    if (!decided) return ctx.answerCallbackQuery({ text: "This was already decided." });
    if (decided.status === "approved") {
      await boss.send(Jobs.approvalExecute, { approvalId: decided.id } satisfies ApprovalExecuteJob);
    }
    await ctx.answerCallbackQuery({ text: decided.status === "approved" ? "Approved" : "Rejected" });
  });

  bot.on("message:text", async (ctx) => {
    await boss.send(Jobs.inboundMessage, { chatId: ctx.chat.id, text: ctx.message.text } satisfies InboundMessageJob);
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const file = ctx.message.voice ?? ctx.message.audio;
    if (!file) return;
    // Telegram's Bot API only serves files up to 20 MB.
    if ((file.file_size ?? 0) > 20 * 1024 * 1024) {
      return ctx.reply("That recording is over Telegram's 20 MB limit for bots. Please send a shorter one.");
    }
    await boss.send(Jobs.inboundVoice, { chatId: ctx.chat.id, fileId: file.file_id } satisfies InboundVoiceJob);
  });

  bot.catch((err) => log.error({ err: err.error }, "telegram handler failed"));

  const outbox: Outbox = {
    async toOwner(text) {
      for (const chunk of splitForTelegram(text)) await bot.api.sendMessage(ownerId, chunk);
    },
    async taskReminder(task) {
      const keyboard = new InlineKeyboard()
        .text("Done", taskCallback(task.id, "done"))
        .text("+1 hour", taskCallback(task.id, "hour"))
        .text("Tomorrow 9:00", taskCallback(task.id, "tomorrow"));
      const lines = [`⏰ ${task.title}`];
      if (task.notes) lines.push(task.notes);
      if (task.dueAt) lines.push(`Due ${formatLocal(task.dueAt, timezone)} · #${task.id}`);
      await bot.api.sendMessage(ownerId, lines.join("\n"), { reply_markup: keyboard });
    },
    async downloadFile(fileId) {
      const file = await bot.api.getFile(fileId);
      if (!file.file_path) throw new Error("Telegram didn't return a download path");
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async typing(chatId) {
      await bot.api.sendChatAction(chatId, "typing").catch(() => undefined);
    },
  };

  const keyboard = (id: string) =>
    new InlineKeyboard().text("Approve", approvalCallback(id, "a")).text("Reject", approvalCallback(id, "r"));

  const presenter: ApprovalPresenter = {
    async present(approval) {
      const msg = await bot.api.sendMessage(ownerId, approvalCardText(approval), {
        reply_markup: keyboard(approval.id),
      });
      return { chatId: msg.chat.id, messageId: msg.message_id };
    },
    async update(approval) {
      if (approval.telegramChatId === null || approval.telegramMessageId === null) return;
      await bot.api
        .editMessageText(approval.telegramChatId, approval.telegramMessageId, approvalCardText(approval), {
          reply_markup: approval.status === "pending" ? keyboard(approval.id) : undefined,
        })
        .catch((err) => log.warn({ err }, "could not update approval card"));
    },
  };

  return { bot, outbox, presenter };
}

function tomorrowAtNine(timezone: string): Date {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return parseDueDate(`${d.toISOString().slice(0, 10)}T09:00`, timezone);
}
