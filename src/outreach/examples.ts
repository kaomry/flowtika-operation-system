import { audit } from "../db/audit.ts";
import type { Db } from "../db/pool.ts";

export type ExampleStatus = "candidate" | "kept" | "skipped";
export type Language = "he" | "en" | "mixed";

export interface OutreachExample {
  id: number;
  gmailMessageId: string;
  gmailThreadId: string;
  account: string;
  sentAt: Date;
  toAddress: string;
  toName: string | null;
  subject: string;
  body: string;
  language: Language;
  wordCount: number;
  replied: boolean;
  status: ExampleStatus;
  gold: boolean;
}

export type NewExample = Omit<OutreachExample, "id" | "status" | "gold" | "wordCount" | "language"> & {
  repliedAt: Date | null;
};

interface Row {
  id: string;
  gmail_message_id: string;
  gmail_thread_id: string;
  account: string;
  sent_at: Date;
  to_address: string;
  to_name: string | null;
  subject: string;
  body: string;
  language: Language;
  word_count: number;
  replied: boolean;
  status: ExampleStatus;
  gold: boolean;
}

const toExample = (r: Row): OutreachExample => ({
  id: Number(r.id),
  gmailMessageId: r.gmail_message_id,
  gmailThreadId: r.gmail_thread_id,
  account: r.account,
  sentAt: r.sent_at,
  toAddress: r.to_address,
  toName: r.to_name,
  subject: r.subject,
  body: r.body,
  language: r.language,
  wordCount: r.word_count,
  replied: r.replied,
  status: r.status,
  gold: r.gold,
});

export const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Hebrew, English, or a real mix of both, by the share of Hebrew letters. */
export function detectLanguage(text: string): Language {
  const hebrew = (text.match(/[֐-׿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = hebrew + latin;
  if (total === 0) return "en";
  const share = hebrew / total;
  return share >= 0.7 ? "he" : share <= 0.3 ? "en" : "mixed";
}

export interface ReviewCounts {
  candidate: number;
  kept: number;
  skipped: number;
  gold: number;
}

/** The bank of past cold emails: candidates found in Gmail, then kept or skipped by the owner. */
export class ExampleStore {
  constructor(private readonly db: Db) {}

  async knownThreadIds(): Promise<Set<string>> {
    const { rows } = await this.db.query<{ gmail_thread_id: string }>("select gmail_thread_id from outreach_examples");
    return new Set(rows.map((r) => r.gmail_thread_id));
  }

  /** Adds a candidate; returns false if that message was already collected. */
  async add(e: NewExample): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `insert into outreach_examples
         (gmail_message_id, gmail_thread_id, account, sent_at, to_address, to_name, subject, body,
          language, word_count, replied, replied_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (gmail_message_id) do nothing`,
      [
        e.gmailMessageId,
        e.gmailThreadId,
        e.account,
        e.sentAt,
        e.toAddress,
        e.toName,
        e.subject,
        e.body,
        detectLanguage(`${e.subject} ${e.body}`),
        countWords(e.body),
        e.replied,
        e.repliedAt,
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  async get(id: number): Promise<OutreachExample | null> {
    const { rows } = await this.db.query<Row>("select * from outreach_examples where id = $1", [id]);
    return rows[0] ? toExample(rows[0]) : null;
  }

  /** Candidates waiting for review, ones that got a reply first, then newest. */
  async nextForReview(limit: number): Promise<OutreachExample[]> {
    const { rows } = await this.db.query<Row>(
      `select * from outreach_examples where status = 'candidate'
       order by replied desc, sent_at desc limit $1`,
      [limit],
    );
    return rows.map(toExample);
  }

  /** Keeps, skips, or keeps as a gold example. */
  async review(id: number, decision: "keep" | "gold" | "skip"): Promise<OutreachExample | null> {
    const { rows } = await this.db.query<Row>(
      `update outreach_examples set status = $2, gold = $3, reviewed_at = now() where id = $1 returning *`,
      [id, decision === "skip" ? "skipped" : "kept", decision === "gold"],
    );
    if (!rows[0]) return null;
    await audit(this.db, "owner", "outreach.example.reviewed", { id, decision });
    return toExample(rows[0]);
  }

  /** Kept examples to show the writer: gold first, then ones that got a reply, newest first. */
  async bestExamples(limit: number, language?: Language): Promise<OutreachExample[]> {
    const { rows } = await this.db.query<Row>(
      `select * from outreach_examples where status = 'kept' and ($2::text is null or language = $2)
       order by gold desc, replied desc, sent_at desc limit $1`,
      [limit, language ?? null],
    );
    return rows.map(toExample);
  }

  async counts(): Promise<ReviewCounts> {
    const { rows } = await this.db.query<{ status: ExampleStatus; gold: boolean; n: string }>(
      "select status, gold, count(*) as n from outreach_examples group by status, gold",
    );
    const counts: ReviewCounts = { candidate: 0, kept: 0, skipped: 0, gold: 0 };
    for (const r of rows) {
      counts[r.status] += Number(r.n);
      if (r.gold) counts.gold += Number(r.n);
    }
    return counts;
  }
}
