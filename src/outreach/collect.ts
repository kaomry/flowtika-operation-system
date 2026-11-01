import type { GmailClient } from "../google/gmail.ts";
import { countWords, type ExampleStore } from "./examples.ts";

export interface CollectOptions {
  /** The owner's own addresses; mail between them is never outreach. */
  ownAddresses: string[];
  since: Date;
  /** Upper bound on sent messages scanned, to keep a run within Gmail's quota. */
  maxMessages?: number;
  /** Shorter first emails ("here's the Zoom link") are rarely cold outreach. */
  minWords?: number;
}

export interface CollectResult {
  scannedThreads: number;
  added: number;
}

const AUTOMATED = /(^|[._+-])(no-?reply|do-?not-?reply|unsubscribe|unsub|bounce|mailer-daemon|notifications?)([._+-]|@)/i;
const REPLY_OR_FORWARD = /^\s*(re|fw|fwd|הועבר|תשובה)\s*:/i;

const gmailDate = (d: Date) => `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;

/**
 * Finds likely cold emails in the owner's sent mail: the first message of a thread, written by
 * the owner to someone they had no earlier email with. It records whether that person replied.
 * The owner then keeps or skips each one, so this can afford to be generous.
 */
export async function collectColdEmails(
  gmail: GmailClient,
  store: ExampleStore,
  account: string,
  options: CollectOptions,
): Promise<CollectResult> {
  const own = new Set([account, ...options.ownAddresses].map((a) => a.toLowerCase()));
  const minWords = options.minWords ?? 25;
  const known = await store.knownThreadIds();

  const sent = await gmail.search(`in:sent after:${gmailDate(options.since)}`, options.maxMessages ?? 1000);
  const threadIds = [...new Set(sent.map((m) => m.threadId))].filter((t) => !known.has(t));
  let added = 0;

  for (const threadId of threadIds) {
    const thread = await gmail.getThreadMeta(threadId);
    const opener = thread[0];
    if (!opener) continue;

    if (!opener.from || !own.has(opener.from.email)) continue;
    if (REPLY_OR_FORWARD.test(opener.subject)) continue;
    const recipient = opener.to.find((a) => !own.has(a.email));
    if (!recipient || AUTOMATED.test(recipient.email)) continue;
    // Outreach goes to one person or a small group, not a mailing list.
    if (opener.to.length + opener.cc.length > 3) continue;

    const before = gmailDate(opener.sentAt);
    const earlier = await gmail.search(`(from:${recipient.email} OR to:${recipient.email}) before:${before}`, 1);
    if (earlier.length) continue;

    const message = await gmail.getMessage(opener.id);
    if (countWords(message.body) < minWords) continue;

    const reply = thread.find((m) => m.sentAt > opener.sentAt && m.from && !own.has(m.from.email));
    const isNew = await store.add({
      gmailMessageId: opener.id,
      gmailThreadId: opener.threadId,
      account,
      sentAt: opener.sentAt,
      toAddress: recipient.email,
      toName: recipient.name,
      subject: message.subject,
      body: message.body.slice(0, 8000),
      replied: Boolean(reply),
      repliedAt: reply?.sentAt ?? null,
    });
    if (isNew) added++;
  }
  return { scannedThreads: threadIds.length, added };
}
