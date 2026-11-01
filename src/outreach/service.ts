import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { audit } from "../db/audit.ts";
import type { Db } from "../db/pool.ts";
import { htmlToText } from "../google/gmail.ts";
import type { Fetch } from "../google/oauth.ts";
import type { Logger } from "../logger.ts";
import type { ModelBackend } from "../models/types.ts";
import type { Lead, NotionClient } from "../notion/client.ts";
import type { GmailSource } from "../worker.ts";
import type { Draft, DraftStore } from "./drafts.ts";
import type { ExampleStore } from "./examples.ts";
import { writeDraft } from "./writer.ts";

/** The lead statuses in Notion, in the order a deal moves through them. */
export const STATUS = {
  potential: "פוטנציאל",
  firstSent: "נשלחה פנייה ראשונה",
  firstReplies: "התכתבות ראשונית",
  advanced: "התכתבות מתקדמת",
  proposal: "הצעה",
  deal: "עסקה",
} as const;

const LADDER: string[] = Object.values(STATUS);

/** Statuses the sync may move a lead out of. Anything later, or off the ladder (לא רלוונטי…), is the owner's call. */
const SYNCABLE: string[] = [STATUS.potential, STATUS.firstSent];

/** The heading used on lead pages for the email that went out. */
export const NOTION_EMAIL_HEADING = "מייל/פנייה";

/**
 * Where a lead's status should move given what the mailbox shows, or null to leave it.
 * Only moves forward, and only from the first two steps, so manual statuses are never overwritten.
 */
export function nextStatus(current: string | null, mail: { sent: boolean; replied: boolean }): string | null {
  if (current !== null && !SYNCABLE.includes(current)) return null;
  const target = mail.replied ? STATUS.firstReplies : mail.sent ? STATUS.firstSent : null;
  if (!target) return null;
  const from = current === null ? -1 : LADDER.indexOf(current);
  return LADDER.indexOf(target) > from ? target : null;
}

export const expandHome = (path: string) => (path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path);

export class OutreachError extends Error {}

export const NOTION_NOT_CONNECTED =
  "Notion isn't connected on this machine. Add NOTION_TOKEN to the .env file and restart the bot.";

export interface OutreachDeps {
  db: Db;
  drafts: DraftStore;
  examples: ExampleStore;
  notion: NotionClient | null;
  leadsDataSource: string;
  gmail: GmailSource;
  backend: ModelBackend;
  styleGuidePath: string;
  signature: string;
  log: Logger;
  fetchFn?: Fetch;
}

export interface SaveResult {
  draft: Draft;
  gmailDraftId: string;
  /** Null when Notion was updated, otherwise why it wasn't. */
  notionProblem: string | null;
}

/** Drafts cold emails for Notion leads, revises them from the owner's comments, and files them. */
export class OutreachService {
  private readonly fetchFn: Fetch;

  constructor(private readonly deps: OutreachDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  private notion(): NotionClient {
    if (!this.deps.notion) throw new OutreachError(NOTION_NOT_CONNECTED);
    return this.deps.notion;
  }

  get drafts(): DraftStore {
    return this.deps.drafts;
  }

  /** Leads whose name or email contains the text. An exact name match wins on its own. */
  async findLeads(query: string): Promise<Lead[]> {
    const q = query.trim().toLowerCase();
    const all = await this.notion().queryLeads(this.deps.leadsDataSource);
    const exact = all.filter((l) => l.name.trim().toLowerCase() === q);
    if (exact.length) return exact;
    return all.filter((l) => l.name.toLowerCase().includes(q) || (l.email ?? "").includes(q));
  }

  async getLead(pageId: string): Promise<Lead> {
    return this.notion().getLead(pageId);
  }

  /** Leads at "פוטנציאל" with an email and no draft yet, plus the ones skipped for having no email. */
  async batchCandidates(limit: number): Promise<{ leads: Lead[]; noEmail: Lead[] }> {
    const leads = await this.notion().queryLeads(this.deps.leadsDataSource, [STATUS.potential]);
    const drafted = await this.deps.drafts.draftedLeadIds();
    const fresh = leads.filter((l) => !drafted.has(l.pageId));
    return { leads: fresh.filter((l) => l.email).slice(0, limit), noEmail: fresh.filter((l) => !l.email) };
  }

  async draftFor(lead: Lead): Promise<Draft> {
    const notion = this.notion();
    const [notes, websiteText] = await Promise.all([
      notion.pageText(lead.pageId).catch((err) => {
        this.deps.log.warn({ err, lead: lead.name }, "could not read lead notes");
        return "";
      }),
      this.websiteText(lead.website),
    ]);
    const content = await writeDraft(this.deps.backend, { ...(await this.writerContext()), lead, notes, websiteText });
    return this.deps.drafts.create({ leadPageId: lead.pageId, leadName: lead.name, toAddress: lead.email, ...content });
  }

  /** A new revision of a draft, written to address the owner's comment. */
  async revise(draftId: number, feedback: string): Promise<Draft> {
    const previous = await this.deps.drafts.get(draftId);
    if (!previous) throw new OutreachError("I can't find that draft anymore.");
    const notion = this.notion();
    const lead = await notion.getLead(previous.leadPageId);
    const [notes, websiteText] = await Promise.all([
      notion.pageText(lead.pageId).catch(() => ""),
      this.websiteText(lead.website),
    ]);
    const content = await writeDraft(this.deps.backend, {
      ...(await this.writerContext()),
      lead,
      notes,
      websiteText,
      previous: { subject: previous.subject, body: previous.body, feedback },
    });
    return this.deps.drafts.create({
      leadPageId: previous.leadPageId,
      leadName: previous.leadName,
      toAddress: lead.email ?? previous.toAddress,
      ...content,
      parentId: previous.id,
      feedback,
    });
  }

  /**
   * Saves a draft into Gmail's Drafts folder and adds it to the lead's Notion page. A Gmail draft
   * reaches nobody until the owner presses Send, so this is internal and only audited.
   * Returns null if the draft was already saved or dropped.
   */
  async save(draftId: number): Promise<SaveResult | null> {
    const connected = await this.deps.gmail();
    if (!connected) throw new OutreachError("Gmail isn't connected, so I can't save the draft there yet.");
    const claimed = await this.deps.drafts.decide(draftId, "saved");
    if (!claimed) return null;
    let gmailDraftId: string;
    try {
      gmailDraftId = (
        await connected.gmail.createDraft({ to: claimed.toAddress ?? "", subject: claimed.subject, body: claimed.body })
      ).id;
    } catch (err) {
      await this.deps.drafts.reopen(draftId);
      throw err;
    }
    await this.deps.drafts.setGmailDraft(draftId, gmailDraftId);
    await audit(this.deps.db, "outreach-writer", "gmail.draft.created", { draftId, gmailDraftId, lead: claimed.leadName });

    let notionProblem: string | null = null;
    try {
      const date = new Date().toISOString().slice(0, 10);
      await this.notion().appendSection(
        claimed.leadPageId,
        `${NOTION_EMAIL_HEADING} (${date})`,
        `נושא: ${claimed.subject}\n\n${claimed.body}`,
      );
      await audit(this.deps.db, "outreach-writer", "notion.lead.email_added", { draftId, leadPageId: claimed.leadPageId });
    } catch (err) {
      this.deps.log.warn({ err }, "could not add the draft to Notion");
      notionProblem = (err as Error).message;
    }
    return { draft: { ...claimed, gmailDraftId }, gmailDraftId, notionProblem };
  }

  /**
   * Moves lead statuses forward from what the mailbox shows: an email sent to them means
   * "נשלחה פנייה ראשונה", a reply from them means "התכתבות ראשונית".
   */
  async syncStatuses(): Promise<{ checked: number; changed: { lead: string; from: string | null; to: string }[] }> {
    const connected = await this.deps.gmail();
    if (!connected || !this.deps.notion) return { checked: 0, changed: [] };
    const notion = this.deps.notion;
    const leads = (await notion.queryLeads(this.deps.leadsDataSource, SYNCABLE)).filter((l) => l.email);
    const changed: { lead: string; from: string | null; to: string }[] = [];
    for (const lead of leads) {
      const email = lead.email!;
      const [sent, replied] = await Promise.all([
        connected.gmail.search(`in:sent to:${email}`, 1),
        connected.gmail.search(`from:${email}`, 1),
      ]);
      const to = nextStatus(lead.status, { sent: sent.length > 0, replied: replied.length > 0 });
      if (!to) continue;
      await notion.setStatus(lead.pageId, to);
      await audit(this.deps.db, "outreach-writer", "notion.lead.status", { leadPageId: lead.pageId, from: lead.status, to });
      changed.push({ lead: lead.name, from: lead.status, to });
    }
    return { checked: leads.length, changed };
  }

  private async writerContext() {
    const [styleGuide, rules, examples] = await Promise.all([
      readFile(expandHome(this.deps.styleGuidePath), "utf8").catch(() => ""),
      this.deps.drafts.activeRules(),
      this.deps.examples.bestExamples(6),
    ]);
    if (!styleGuide) this.deps.log.warn({ path: this.deps.styleGuidePath }, "no style guide found");
    return { styleGuide, signature: this.deps.signature, rules: rules.map((r) => r.rule), examples };
  }

  /** The start of the lead's homepage as text, or "" if it can't be read quickly. */
  async websiteText(website: string | null, maxChars = 3000): Promise<string> {
    if (!website) return "";
    const url = /^https?:\/\//i.test(website) ? website : `https://${website}`;
    try {
      const res = await this.fetchFn(url, {
        signal: AbortSignal.timeout(10_000),
        headers: { "user-agent": "Mozilla/5.0 (Macintosh) FlowtikaOS" },
      });
      if (!res.ok) return "";
      const text = htmlToText(await res.text())
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n")
        .trim();
      return text.slice(0, maxChars);
    } catch {
      return "";
    }
  }
}
