import type { Fetch } from "./oauth.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface Part {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: Part[];
}

interface RawMessage {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds?: string[];
  payload?: Part;
}

export interface Address {
  name: string | null;
  email: string;
}

export interface MessageMeta {
  id: string;
  threadId: string;
  sentAt: Date;
  from: Address | null;
  to: Address[];
  cc: Address[];
  subject: string;
  labelIds: string[];
}

export interface Message extends MessageMeta {
  body: string;
}

export interface DraftInput {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
}

/** A thin client over the Gmail REST API: just the calls the platform uses. */
export class GmailClient {
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchFn(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gmail ${init.method ?? "GET"} ${path.split("?")[0]} failed with HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async profileEmail(): Promise<string> {
    return (await this.call<{ emailAddress: string }>("/profile")).emailAddress;
  }

  /** Messages matching a Gmail search, newest first, up to `limit`. */
  async search(query: string, limit = 500): Promise<{ id: string; threadId: string }[]> {
    const found: { id: string; threadId: string }[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q: query, maxResults: String(Math.min(100, limit - found.length)) });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await this.call<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(
        `/messages?${params}`,
      );
      found.push(...(page.messages ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken && found.length < limit);
    return found;
  }

  async getMessage(id: string): Promise<Message> {
    const raw = await this.call<RawMessage>(`/messages/${id}?format=full`);
    return { ...toMeta(raw), body: extractBody(raw.payload) };
  }

  /** Every message in a thread, oldest first, headers only. */
  async getThreadMeta(threadId: string): Promise<MessageMeta[]> {
    const headers = ["From", "To", "Cc", "Subject", "Date"].map((h) => `metadataHeaders=${h}`).join("&");
    const raw = await this.call<{ messages?: RawMessage[] }>(`/threads/${threadId}?format=metadata&${headers}`);
    return (raw.messages ?? []).map(toMeta).sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  }

  /** Saves a draft in the owner's own mailbox. It reaches nobody until the owner sends it. */
  async createDraft(draft: DraftInput): Promise<{ id: string }> {
    const message: { raw: string; threadId?: string } = { raw: Buffer.from(buildMime(draft)).toString("base64url") };
    if (draft.threadId) message.threadId = draft.threadId;
    return this.call<{ id: string }>("/drafts", { method: "POST", body: JSON.stringify({ message }) });
  }
}

function header(part: Part | undefined, name: string): string {
  return part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function toMeta(raw: RawMessage): MessageMeta {
  return {
    id: raw.id,
    threadId: raw.threadId,
    sentAt: new Date(Number(raw.internalDate)),
    from: parseAddresses(header(raw.payload, "From"))[0] ?? null,
    to: parseAddresses(header(raw.payload, "To")),
    cc: parseAddresses(header(raw.payload, "Cc")),
    subject: header(raw.payload, "Subject"),
    labelIds: raw.labelIds ?? [],
  };
}

/** Parses `"Dana Levi" <dana@x.com>, bob@y.com` into names and lowercase addresses. */
export function parseAddresses(value: string): Address[] {
  const out: Address[] = [];
  // Split on commas that aren't inside quotes.
  for (const piece of value.match(/(?:"[^"]*"|[^,])+/g) ?? []) {
    const angle = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(piece);
    const email = (angle ? angle[2]! : piece).trim().toLowerCase();
    if (!email.includes("@")) continue;
    const name = angle ? angle[1]!.replace(/^"|"$/g, "").trim() : "";
    out.push({ name: name || null, email });
  }
  return out;
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

/** The readable text of a message: the text/plain part if there is one, else the HTML with tags removed. */
export function extractBody(payload: Part | undefined): string {
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (part: Part | undefined) => {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data) plain.push(decode(part.body.data));
    else if (part.mimeType === "text/html" && part.body?.data) html.push(decode(part.body.data));
    part.parts?.forEach(walk);
  };
  walk(payload);
  const text = plain.length ? plain.join("\n") : htmlToText(html.join("\n"));
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n");
}

/** RFC 2822 message with UTF-8 headers (for Hebrew subjects) and a plain-text body. */
export function buildMime(draft: DraftInput): string {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(draft.subject, "utf8").toString("base64")}?=`;
  return [
    `To: ${draft.to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(draft.body, "utf8").toString("base64"),
  ].join("\r\n");
}
