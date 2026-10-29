import type { Approval } from "../approvals/service.ts";

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
