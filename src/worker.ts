import type { PgBoss } from "pg-boss";
import { chiefOfStaff } from "./agents/chiefOfStaff.ts";
import type { AgentRuntime } from "./agents/runtime.ts";
import type { ApprovalService } from "./approvals/service.ts";
import type { Logger } from "./logger.ts";
import type { GmailClient } from "./google/gmail.ts";
import { collectColdEmails } from "./outreach/collect.ts";
import type { ExampleStore, OutreachExample } from "./outreach/examples.ts";
import {
  Jobs,
  type ApprovalExecuteJob,
  type InboundMessageJob,
  type InboundVoiceJob,
  type OutreachCollectJob,
} from "./queue/jobs.ts";
import type { Task, TaskService } from "./tasks/service.ts";
import type { Transcriber } from "./voice/transcriber.ts";

export interface Outbox {
  /** Sends a message to the owner. Messages to the owner never need approval. */
  toOwner(text: string): Promise<void>;
  /** Sends a reminder for a task that has come due, with buttons to act on it. */
  taskReminder(task: Task): Promise<void>;
  typing(chatId: number): Promise<void>;
  /** Downloads a file the owner sent, such as a voice note. */
  downloadFile(fileId: string): Promise<Buffer>;
  /** Shows a past email with Keep / Gold / Skip buttons. */
  exampleCard(example: OutreachExample): Promise<void>;
}

/** The connected Gmail account, looked up per job so connecting doesn't need a restart. */
export type GmailSource = () => Promise<{ gmail: GmailClient; account: string } | null>;

export const REVIEW_BATCH = 5;

export const GMAIL_NOT_CONNECTED =
  "Gmail isn't connected yet. On the Mac, run `npm run google:connect` in the project folder and sign in, then try again.";

/** Sends the next few candidates for review and says how many are left. */
export async function sendReviewBatch(store: ExampleStore, outbox: Outbox): Promise<void> {
  const batch = await store.nextForReview(REVIEW_BATCH);
  if (!batch.length) {
    const c = await store.counts();
    await outbox.toOwner(
      c.kept
        ? `Nothing left to review. ${c.kept} kept (${c.gold} gold), ${c.skipped} skipped.`
        : "Nothing to review yet. Send /collect_emails to look through your sent mail.",
    );
    return;
  }
  for (const example of batch) await outbox.exampleCard(example);
  const left = (await store.counts()).candidate - batch.length;
  await outbox.toOwner(
    `Tap Keep, Gold (your best ones) or Skip on each.${left > 0 ? ` ${left} more after these: /review_emails` : ""}`,
  );
}

/** Starts the message the owner gets when an agent fails, so callers can tell failure from a reply. */
export const AGENT_FAILURE_PREFIX = "Something went wrong while answering:";

export const DAILY_BRIEF_INSTRUCTION =
  "[Scheduled morning check-in] Write Omry a short good-morning message. List the tasks that " +
  "are overdue or due today, then anything else open that may need attention, and ask what the " +
  "top priority is. If nothing is due, keep it to two lines.";

export async function registerWorkers(deps: {
  boss: PgBoss;
  runtime: AgentRuntime;
  approvals: ApprovalService;
  tasks: TaskService;
  transcriber?: Transcriber;
  examples: ExampleStore;
  gmail: GmailSource;
  ownerEmails: string[];
  outbox: Outbox;
  ownerChatId: number;
  log: Logger;
}): Promise<void> {
  const { boss, runtime, approvals, tasks, transcriber, examples, gmail, ownerEmails, outbox, ownerChatId, log } = deps;

  const answer = async (chatId: number, text: string) => {
    await outbox.typing(chatId);
    try {
      const reply = await runtime.reply(chiefOfStaff, chatId, text);
      await outbox.toOwner(reply);
    } catch (err) {
      log.error({ err }, "chief of staff failed");
      await outbox.toOwner(`${AGENT_FAILURE_PREFIX} ${(err as Error).message}`);
    }
  };

  await boss.work<InboundMessageJob>(Jobs.inboundMessage, async ([job]) => {
    if (!job) return;
    await answer(job.data.chatId, job.data.text);
  });

  await boss.work<InboundVoiceJob>(Jobs.inboundVoice, async ([job]) => {
    if (!job) return;
    const { chatId, fileId } = job.data;
    if (!transcriber) {
      await outbox.toOwner("Voice notes aren't set up on this machine yet, so please type for now.");
      return;
    }
    await outbox.typing(chatId);
    let transcript: string;
    try {
      transcript = await transcriber.transcribe(await outbox.downloadFile(fileId));
    } catch (err) {
      log.error({ err }, "transcription failed");
      await outbox.toOwner(`I couldn't transcribe that voice note: ${(err as Error).message}`);
      return;
    }
    if (!transcript) {
      await outbox.toOwner("I couldn't hear anything in that voice note.");
      return;
    }
    // Show what was heard, so a mistranscription is caught before anything acts on it.
    await outbox.toOwner(`🎙 ${transcript}`);
    await answer(chatId, `[Voice note] ${transcript}`);
  });

  await boss.work<ApprovalExecuteJob>(Jobs.approvalExecute, async ([job]) => {
    if (!job) return;
    const result = await approvals.execute(job.data.approvalId);
    log.info({ id: result.id, status: result.status }, "approval executed");
  });

  await boss.work(Jobs.dailyBrief, async () => {
    const brief = await runtime.runInstruction(chiefOfStaff, ownerChatId, DAILY_BRIEF_INSTRUCTION);
    await outbox.toOwner(brief);
  });

  await boss.work<OutreachCollectJob>(Jobs.outreachCollect, async ([job]) => {
    if (!job) return;
    const connected = await gmail();
    if (!connected) {
      await outbox.toOwner(GMAIL_NOT_CONNECTED);
      return;
    }
    const since = new Date();
    since.setMonth(since.getMonth() - job.data.months);
    await outbox.toOwner(`Looking through ${connected.account} sent mail from the last ${job.data.months} months…`);
    try {
      const result = await collectColdEmails(connected.gmail, examples, connected.account, {
        ownAddresses: ownerEmails,
        since,
      });
      log.info(result, "cold email collection finished");
      await outbox.toOwner(
        `Checked ${result.scannedThreads} conversations and found ${result.added} new emails that look like cold outreach.`,
      );
      await sendReviewBatch(examples, outbox);
    } catch (err) {
      log.error({ err }, "cold email collection failed");
      await outbox.toOwner(`I couldn't finish reading your sent mail: ${(err as Error).message}`);
    }
  });

  await boss.work(Jobs.taskReminders, async () => {
    for (const task of await tasks.claimDueReminders()) {
      await outbox.taskReminder(task);
    }
  });
}
