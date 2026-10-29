import { Bot, InlineKeyboard } from "grammy";
import type { PgBoss } from "pg-boss";
import type { ApprovalPresenter, ApprovalService } from "../approvals/service.ts";
import { audit } from "../db/audit.ts";
import { clearMessages } from "../db/messages.ts";
import type { Db } from "../db/pool.ts";
import type { Logger } from "../logger.ts";
import { Jobs, type ApprovalExecuteJob, type InboundMessageJob } from "../queue/jobs.ts";
import type { Outbox } from "../worker.ts";
import { approvalCallback, approvalCardText, parseApprovalCallback, splitForTelegram } from "./format.ts";

const HELP = `Flowtika OS, Phase 0.

Write to me in Hebrew or English and I'll answer with memory of our conversation.

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
  log: Logger;
}) {
  const { token, ownerId, db, boss, approvals, log } = deps;
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

  bot.command("demo_approval", async (ctx) => {
    await approvals.request({
      kind: "demo.note",
      summary: 'Send you the note "The approval gate works." Nothing leaves Telegram.',
      payload: { text: "The approval gate works." },
      requestedBy: "chief-of-staff",
    });
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

  bot.on("message:voice", (ctx) => ctx.reply("Voice notes arrive in Phase 1. For now, please type."));

  bot.catch((err) => log.error({ err: err.error }, "telegram handler failed"));

  const outbox: Outbox = {
    async toOwner(text) {
      for (const chunk of splitForTelegram(text)) await bot.api.sendMessage(ownerId, chunk);
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
