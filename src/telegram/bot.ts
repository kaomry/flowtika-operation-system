import { Bot, InlineKeyboard } from "grammy";
import type { PgBoss } from "pg-boss";
import type { ApprovalPresenter, ApprovalService } from "../approvals/service.ts";
import { audit } from "../db/audit.ts";
import { clearMessages } from "../db/messages.ts";
import type { Db } from "../db/pool.ts";
import type { Logger } from "../logger.ts";
import type { DraftStore } from "../outreach/drafts.ts";
import type { ExampleStore } from "../outreach/examples.ts";
import {
  Jobs,
  type ApprovalExecuteJob,
  type InboundMessageJob,
  type InboundVoiceJob,
  type OutreachBatchJob,
  type OutreachCollectJob,
  type OutreachDraftJob,
  type OutreachReviseJob,
  type OutreachSaveJob,
} from "../queue/jobs.ts";
import { describeTask } from "../agents/taskActions.ts";
import type { Task, TaskService } from "../tasks/service.ts";
import { formatLocal, parseDueDate } from "../tasks/time.ts";
import { sendReviewBatch, type Outbox } from "../worker.ts";
import {
  approvalCallback,
  approvalCardText,
  draftCallback,
  draftCardText,
  exampleCallback,
  exampleCardText,
  parseApprovalCallback,
  parseDraftCallback,
  parseExampleCallback,
  parseTaskCallback,
  splitForTelegram,
  taskCallback,
} from "./format.ts";

const HELP = `Flowtika OS

Write or send a voice note, in Hebrew or English. I remember our conversation and keep your task list: "remind me to call Dana tomorrow at 10", "the proposal is waiting on the client", "what's on my plate?"

/tasks  all open tasks
/today  tasks due today or overdue
/done 3  mark task #3 done
/collect_emails  find your past cold emails in Gmail
/review_emails  keep or skip the ones found
/draft Dana  write a cold email to a Notion lead
/draft_batch 5  draft for leads at "פוטנציאל"
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
  examples: ExampleStore;
  drafts: DraftStore;
  timezone: string;
  log: Logger;
}) {
  const { token, ownerId, db, boss, approvals, tasks, examples, drafts, timezone, log } = deps;
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

  bot.command("collect_emails", async (ctx) => {
    const months = Number(ctx.match.trim()) || 24;
    await boss.send(Jobs.outreachCollect, { months } satisfies OutreachCollectJob);
    await ctx.reply("On it. This can take a few minutes.");
  });

  bot.command("review_emails", async () => {
    await sendReviewBatch(examples, outbox);
  });

  bot.command("draft", async (ctx) => {
    const query = ctx.match.trim();
    if (!query) return ctx.reply("Which lead? For example: /draft Dana Levi");
    await boss.send(Jobs.outreachDraft, { query } satisfies OutreachDraftJob);
    await ctx.reply(`Writing a draft for ${query}. This takes a minute or two.`);
  });

  bot.command("draft_batch", async (ctx) => {
    const limit = Math.min(Number(ctx.match.trim()) || 12, 25);
    await boss.send(Jobs.outreachBatch, { limit } satisfies OutreachBatchJob);
    await ctx.reply("Looking for leads to write to…");
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

  bot.on("callback_query:data", async (ctx, next) => {
    const parsed = parseExampleCallback(ctx.callbackQuery.data);
    if (!parsed) return next();
    const example = await examples.review(parsed.id, parsed.button);
    if (!example) return ctx.answerCallbackQuery({ text: "That email is no longer in the list." });
    await ctx.editMessageText(exampleCardText(example, parsed.button, 300)).catch(() => undefined);
    await ctx.answerCallbackQuery({ text: parsed.button === "skip" ? "Skipped" : "Kept" });
  });

  bot.on("callback_query:data", async (ctx, next) => {
    const parsed = parseDraftCallback(ctx.callbackQuery.data);
    if (!parsed) return next();
    const draft = await drafts.get(parsed.id);
    if (!draft) return ctx.answerCallbackQuery({ text: "That draft no longer exists." });
    if (parsed.button === "rule") {
      if (!draft.feedback) return ctx.answerCallbackQuery({ text: "This draft has no comment to keep." });
      await drafts.addRule(draft.feedback, draft.id);
      return ctx.answerCallbackQuery({ text: "Kept. Every future draft will follow it." });
    }
    if (draft.status !== "pending") {
      return ctx.answerCallbackQuery({ text: `This draft was already ${draft.status === "superseded" ? "replaced by a newer version" : draft.status}.` });
    }
    if (parsed.button === "save") {
      await boss.send(Jobs.outreachSave, { draftId: draft.id } satisfies OutreachSaveJob);
      return ctx.answerCallbackQuery({ text: "Saving to Gmail Drafts…" });
    }
    const dropped = await drafts.decide(draft.id, "dropped");
    if (dropped) await ctx.editMessageText(draftCardText(dropped, "✗ Dropped")).catch(() => undefined);
    await ctx.answerCallbackQuery({ text: "Dropped" });
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
    // A reply to a draft card is a comment on that draft.
    const replyTo = ctx.message.reply_to_message?.message_id;
    const draft = replyTo ? await drafts.byTelegramMessage(replyTo) : null;
    if (draft) {
      await boss.send(Jobs.outreachRevise, { draftId: draft.id, feedback: ctx.message.text } satisfies OutreachReviseJob);
      await ctx.reply(`Rewriting the draft for ${draft.leadName}…`);
      return;
    }
    await boss.send(Jobs.inboundMessage, { chatId: ctx.chat.id, text: ctx.message.text } satisfies InboundMessageJob);
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const file = ctx.message.voice ?? ctx.message.audio;
    if (!file) return;
    // Telegram's Bot API only serves files up to 20 MB.
    if ((file.file_size ?? 0) > 20 * 1024 * 1024) {
      return ctx.reply("That recording is over Telegram's 20 MB limit for bots. Please send a shorter one.");
    }
    await boss.send(Jobs.inboundVoice, {
      chatId: ctx.chat.id,
      fileId: file.file_id,
      replyToMessageId: ctx.message.reply_to_message?.message_id,
    } satisfies InboundVoiceJob);
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
    async exampleCard(example) {
      const keyboard = new InlineKeyboard()
        .text("Keep", exampleCallback(example.id, "keep"))
        .text("⭐ Gold", exampleCallback(example.id, "gold"))
        .text("Skip", exampleCallback(example.id, "skip"));
      await bot.api.sendMessage(ownerId, exampleCardText(example), { reply_markup: keyboard });
    },
    async draftCard(draft) {
      const keyboard = new InlineKeyboard()
        .text("Save to Gmail", draftCallback(draft.id, "save"))
        .text("Drop", draftCallback(draft.id, "drop"));
      if (draft.feedback) keyboard.row().text("Keep my comment as a rule", draftCallback(draft.id, "rule"));
      const msg = await bot.api.sendMessage(ownerId, draftCardText(draft), { reply_markup: keyboard });
      return msg.message_id;
    },
    async editDraftCard(draft, note) {
      if (draft.telegramMessageId === null) return outbox.toOwner(`${draft.leadName}: ${note}`);
      const keyboard = draft.feedback
        ? new InlineKeyboard().text("Keep my comment as a rule", draftCallback(draft.id, "rule"))
        : undefined;
      await bot.api
        .editMessageText(ownerId, draft.telegramMessageId, draftCardText(draft, note), { reply_markup: keyboard })
        .catch((err) => log.warn({ err }, "could not update draft card"));
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
