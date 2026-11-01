import type { PgBoss } from "pg-boss";
import { chiefOfStaff } from "./agents/chiefOfStaff.ts";
import type { AgentRuntime } from "./agents/runtime.ts";
import type { ApprovalService } from "./approvals/service.ts";
import type { Logger } from "./logger.ts";
import { Jobs, type ApprovalExecuteJob, type InboundMessageJob, type InboundVoiceJob } from "./queue/jobs.ts";
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
  outbox: Outbox;
  ownerChatId: number;
  log: Logger;
}): Promise<void> {
  const { boss, runtime, approvals, tasks, transcriber, outbox, ownerChatId, log } = deps;

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

  await boss.work(Jobs.taskReminders, async () => {
    for (const task of await tasks.claimDueReminders()) {
      await outbox.taskReminder(task);
    }
  });
}
