/**
 * Every trigger (a Telegram message, a schedule, later a webhook or an email) becomes a job
 * on one of these queues. Adding a trigger means adding a queue name and a handler.
 */
export const Jobs = {
  inboundMessage: "inbound-message",
  inboundVoice: "inbound-voice",
  approvalExecute: "approval-execute",
  dailyBrief: "schedule-daily-brief",
  taskReminders: "schedule-task-reminders",
  outreachCollect: "outreach-collect",
  outreachDraft: "outreach-draft",
  outreachBatch: "outreach-batch",
  outreachRevise: "outreach-revise",
  outreachSave: "outreach-save",
  outreachStatusSync: "schedule-outreach-status-sync",
} as const;

export type JobName = (typeof Jobs)[keyof typeof Jobs];

export interface InboundMessageJob {
  chatId: number;
  text: string;
}

export interface InboundVoiceJob {
  chatId: number;
  fileId: string;
  /** Set when the voice note replies to one of the bot's messages, such as a draft card. */
  replyToMessageId?: number;
}

export interface ApprovalExecuteJob {
  approvalId: string;
}

export interface OutreachCollectJob {
  /** How far back to look in sent mail, in months. */
  months: number;
}

/** Draft a cold email for one lead: by Notion page id, or by a name to look up. */
export interface OutreachDraftJob {
  leadPageId?: string;
  query?: string;
}

export interface OutreachBatchJob {
  limit: number;
}

export interface OutreachReviseJob {
  draftId: number;
  feedback: string;
}

export interface OutreachSaveJob {
  draftId: number;
}
