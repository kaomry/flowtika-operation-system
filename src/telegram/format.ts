import type { Approval } from "../approvals/service.ts";
import type { Draft } from "../outreach/drafts.ts";
import type { OutreachExample } from "../outreach/examples.ts";

/** Telegram rejects messages over 4096 characters; split on paragraph or line breaks when possible. */
export function splitForTelegram(text: string, limit = 4000): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const statusLine: Record<Approval["status"], string> = {
  pending: "Waiting for your approval",
  approved: "Approved, running now",
  rejected: "Rejected, nothing was done",
  executed: "Done",
  failed: "Approved, but it failed",
};

export function approvalCardText(a: Approval): string {
  const lines = [`Approval needed: ${a.kind}`, `Requested by: ${a.requestedBy}`, "", a.summary, "", statusLine[a.status]];
  if (a.status === "failed" && a.result?.error) lines.push(`Error: ${String(a.result.error)}`);
  return lines.join("\n");
}

/** Callback data stays under Telegram's 64-byte limit: "ap:" + uuid (36) + ":" + one letter. */
export const approvalCallback = (id: string, decision: "a" | "r") => `ap:${id}:${decision}`;

export type TaskButton = "done" | "hour" | "tomorrow";
const TASK_BUTTON_CODES: Record<TaskButton, string> = { done: "d", hour: "h", tomorrow: "t" };

export const taskCallback = (id: number, button: TaskButton) => `tk:${id}:${TASK_BUTTON_CODES[button]}`;

export function parseTaskCallback(data: string): { id: number; button: TaskButton } | null {
  const match = /^tk:(\d+):([dht])$/.exec(data);
  if (!match) return null;
  const button = (Object.keys(TASK_BUTTON_CODES) as TaskButton[]).find((b) => TASK_BUTTON_CODES[b] === match[2])!;
  return { id: Number(match[1]), button };
}

export function parseApprovalCallback(data: string): { id: string; decision: "approved" | "rejected" } | null {
  const match = /^ap:([0-9a-f-]{36}):([ar])$/.exec(data);
  if (!match) return null;
  return { id: match[1]!, decision: match[2] === "a" ? "approved" : "rejected" };
}

export type ExampleButton = "keep" | "gold" | "skip";
const EXAMPLE_BUTTON_CODES: Record<ExampleButton, string> = { keep: "k", gold: "g", skip: "s" };

export const exampleCallback = (id: number, button: ExampleButton) => `ox:${id}:${EXAMPLE_BUTTON_CODES[button]}`;

export function parseExampleCallback(data: string): { id: number; button: ExampleButton } | null {
  const match = /^ox:(\d+):([kgs])$/.exec(data);
  if (!match) return null;
  const button = (Object.keys(EXAMPLE_BUTTON_CODES) as ExampleButton[]).find((b) => EXAMPLE_BUTTON_CODES[b] === match[2])!;
  return { id: Number(match[1]), button };
}

const exampleDecision: Record<ExampleButton, string> = {
  keep: "✓ Kept as an example",
  gold: "⭐ Kept as a gold example",
  skip: "✗ Skipped, not cold outreach",
};

/** A past email shown for review: who it went to, whether they replied, and the start of the text. */
export function exampleCardText(e: OutreachExample, decided?: ExampleButton, previewChars = 700): string {
  const to = e.toName ? `${e.toName} <${e.toAddress}>` : e.toAddress;
  const body = e.body.length > previewChars ? `${e.body.slice(0, previewChars).trimEnd()}…` : e.body;
  const lines = [
    `📧 Cold email? #${e.id}`,
    `To: ${to}`,
    `Sent: ${e.sentAt.toISOString().slice(0, 10)} · ${e.wordCount} words · ${e.replied ? "they replied" : "no reply"}`,
    `Subject: ${e.subject || "(none)"}`,
    "",
    body,
  ];
  if (decided) lines.push("", exampleDecision[decided]);
  return lines.join("\n");
}

export type DraftButton = "save" | "drop" | "rule";
const DRAFT_BUTTON_CODES: Record<DraftButton, string> = { save: "s", drop: "d", rule: "k" };

export const draftCallback = (id: number, button: DraftButton) => `od:${id}:${DRAFT_BUTTON_CODES[button]}`;

export function parseDraftCallback(data: string): { id: number; button: DraftButton } | null {
  const match = /^od:(\d+):([sdk])$/.exec(data);
  if (!match) return null;
  const button = (Object.keys(DRAFT_BUTTON_CODES) as DraftButton[]).find((b) => DRAFT_BUTTON_CODES[b] === match[2])!;
  return { id: Number(match[1]), button };
}

/** A drafted cold email: who it's for, the subject and body as they'd be sent, and why this angle. */
export function draftCardText(d: Draft, note?: string): string {
  const lines = [
    `✍️ Draft for ${d.leadName}${d.revision > 1 ? ` · version ${d.revision}` : ""} · #${d.id}`,
    `To: ${d.toAddress ?? "(no email in Notion)"}`,
    `Subject: ${d.subject}`,
    "",
    d.body.length > 3300 ? `${d.body.slice(0, 3300)}…` : d.body,
    "",
    `💡 ${d.angle}`,
  ];
  if (note) lines.push("", note);
  else lines.push("", "Reply to this message with a comment (text or voice) and I'll rewrite it.");
  return lines.join("\n");
}
