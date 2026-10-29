import type { PgBoss } from "pg-boss";
import { chiefOfStaff } from "./agents/chiefOfStaff.ts";
import type { AgentRuntime } from "./agents/runtime.ts";
import type { ApprovalService } from "./approvals/service.ts";
import type { Logger } from "./logger.ts";
import { Jobs, type ApprovalExecuteJob, type InboundMessageJob } from "./queue/jobs.ts";

export interface Outbox {
  /** Sends a message to the owner. Messages to the owner never need approval. */
  toOwner(text: string): Promise<void>;
  typing(chatId: number): Promise<void>;
}

export const DAILY_BRIEF_INSTRUCTION =
  "[Scheduled morning check-in] Write Omry a short good-morning message. Recap anything open " +
  "from our recent conversation that may need attention today, then ask what the top priority " +
  "is. If there is nothing open, keep it to two lines.";

export async function registerWorkers(deps: {
  boss: PgBoss;
  runtime: AgentRuntime;
  approvals: ApprovalService;
  outbox: Outbox;
  ownerChatId: number;
  log: Logger;
}): Promise<void> {
  const { boss, runtime, approvals, outbox, ownerChatId, log } = deps;

  await boss.work<InboundMessageJob>(Jobs.inboundMessage, async ([job]) => {
    if (!job) return;
    const { chatId, text } = job.data;
    await outbox.typing(chatId);
    try {
      const reply = await runtime.reply(chiefOfStaff, chatId, text);
      await outbox.toOwner(reply);
    } catch (err) {
      log.error({ err }, "chief of staff failed");
      await outbox.toOwner(`Something went wrong while answering: ${(err as Error).message}`);
    }
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
}
