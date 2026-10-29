/**
 * Every trigger (a Telegram message, a schedule, later a webhook or an email) becomes a job
 * on one of these queues. Adding a trigger means adding a queue name and a handler.
 */
export const Jobs = {
  inboundMessage: "inbound-message",
  approvalExecute: "approval-execute",
  dailyBrief: "schedule-daily-brief",
  taskReminders: "schedule-task-reminders",
} as const;

export type JobName = (typeof Jobs)[keyof typeof Jobs];

export interface InboundMessageJob {
  chatId: number;
  text: string;
}

export interface ApprovalExecuteJob {
  approvalId: string;
}
