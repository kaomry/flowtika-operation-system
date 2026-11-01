import { audit } from "../db/audit.ts";
import type { Db } from "../db/pool.ts";

export type DraftStatus = "pending" | "saved" | "dropped" | "superseded";

export interface Draft {
  id: number;
  leadPageId: string;
  leadName: string;
  toAddress: string | null;
  subject: string;
  body: string;
  angle: string;
  status: DraftStatus;
  revision: number;
  parentId: number | null;
  feedback: string | null;
  telegramMessageId: number | null;
  gmailDraftId: string | null;
}

export interface NewDraft {
  leadPageId: string;
  leadName: string;
  toAddress: string | null;
  subject: string;
  body: string;
  angle: string;
  parentId?: number | null;
  feedback?: string | null;
}

interface Row {
  id: string;
  lead_page_id: string;
  lead_name: string;
  to_address: string | null;
  subject: string;
  body: string;
  angle: string;
  status: DraftStatus;
  revision: number;
  parent_id: string | null;
  feedback: string | null;
  telegram_message_id: string | null;
  gmail_draft_id: string | null;
}

const toDraft = (r: Row): Draft => ({
  id: Number(r.id),
  leadPageId: r.lead_page_id,
  leadName: r.lead_name,
  toAddress: r.to_address,
  subject: r.subject,
  body: r.body,
  angle: r.angle,
  status: r.status,
  revision: r.revision,
  parentId: r.parent_id === null ? null : Number(r.parent_id),
  feedback: r.feedback,
  telegramMessageId: r.telegram_message_id === null ? null : Number(r.telegram_message_id),
  gmailDraftId: r.gmail_draft_id,
});

export interface Rule {
  id: number;
  rule: string;
}

/** Drafts and their revisions, plus the rules the owner chose to keep from their comments. */
export class DraftStore {
  constructor(private readonly db: Db) {}

  async create(d: NewDraft): Promise<Draft> {
    const parent = d.parentId ? await this.get(d.parentId) : null;
    const { rows } = await this.db.query<Row>(
      `insert into outreach_drafts (lead_page_id, lead_name, to_address, subject, body, angle, revision, parent_id, feedback)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [d.leadPageId, d.leadName, d.toAddress, d.subject, d.body, d.angle, (parent?.revision ?? 0) + 1, d.parentId ?? null, d.feedback ?? null],
    );
    const draft = toDraft(rows[0]!);
    if (parent) await this.db.query("update outreach_drafts set status = 'superseded' where id = $1 and status = 'pending'", [parent.id]);
    await audit(this.db, "outreach-writer", "outreach.draft.created", { id: draft.id, lead: d.leadName, revision: draft.revision });
    return draft;
  }

  async get(id: number): Promise<Draft | null> {
    const { rows } = await this.db.query<Row>("select * from outreach_drafts where id = $1", [id]);
    return rows[0] ? toDraft(rows[0]) : null;
  }

  async byTelegramMessage(messageId: number): Promise<Draft | null> {
    const { rows } = await this.db.query<Row>(
      "select * from outreach_drafts where telegram_message_id = $1 order by id desc limit 1",
      [messageId],
    );
    return rows[0] ? toDraft(rows[0]) : null;
  }

  async setTelegramMessage(id: number, messageId: number): Promise<void> {
    await this.db.query("update outreach_drafts set telegram_message_id = $2 where id = $1", [id, messageId]);
  }

  /**
   * Moves a pending draft to saved or dropped. Returns null if it was already decided, so a
   * double tap or a retried job can't save the same draft twice.
   */
  async decide(id: number, status: "saved" | "dropped", gmailDraftId: string | null = null): Promise<Draft | null> {
    const { rows } = await this.db.query<Row>(
      `update outreach_drafts set status = $2, gmail_draft_id = $3, decided_at = now()
       where id = $1 and status = 'pending' returning *`,
      [id, status, gmailDraftId],
    );
    if (!rows[0]) return null;
    await audit(this.db, "owner", `outreach.draft.${status}`, { id });
    return toDraft(rows[0]);
  }

  async setGmailDraft(id: number, gmailDraftId: string): Promise<void> {
    await this.db.query("update outreach_drafts set gmail_draft_id = $2 where id = $1", [id, gmailDraftId]);
  }

  /** Puts a saved draft back to pending when filing it failed, so the owner can try again. */
  async reopen(id: number): Promise<void> {
    await this.db.query(
      "update outreach_drafts set status = 'pending', decided_at = null where id = $1 and status = 'saved' and gmail_draft_id is null",
      [id],
    );
  }

  /** Adds a rule. Keeping the same draft's comment twice returns the rule already kept. */
  async addRule(rule: string, sourceDraftId: number | null): Promise<Rule> {
    if (sourceDraftId !== null) {
      const existing = await this.db.query<{ id: string; rule: string }>(
        "select id, rule from outreach_rules where source_draft_id = $1",
        [sourceDraftId],
      );
      if (existing.rows[0]) return { id: Number(existing.rows[0].id), rule: existing.rows[0].rule };
    }
    const { rows } = await this.db.query<{ id: string; rule: string }>(
      "insert into outreach_rules (rule, source_draft_id) values ($1, $2) returning id, rule",
      [rule.trim(), sourceDraftId],
    );
    await audit(this.db, "owner", "outreach.rule.added", { id: rows[0]!.id, sourceDraftId });
    return { id: Number(rows[0]!.id), rule: rows[0]!.rule };
  }

  async activeRules(): Promise<Rule[]> {
    const { rows } = await this.db.query<{ id: string; rule: string }>(
      "select id, rule from outreach_rules where active order by id",
    );
    return rows.map((r) => ({ id: Number(r.id), rule: r.rule }));
  }

  /** Lead page ids that already have a draft that wasn't dropped, so a batch skips them. */
  async draftedLeadIds(): Promise<Set<string>> {
    const { rows } = await this.db.query<{ lead_page_id: string }>(
      "select distinct lead_page_id from outreach_drafts where status <> 'dropped'",
    );
    return new Set(rows.map((r) => r.lead_page_id));
  }
}
