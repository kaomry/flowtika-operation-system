import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.ts";
import { createPool, type Db } from "../src/db/pool.ts";
import type { GmailClient } from "../src/google/gmail.ts";
import { logger } from "../src/logger.ts";
import type { ModelBackend } from "../src/models/types.ts";
import type { Lead, NotionClient } from "../src/notion/client.ts";
import { DraftStore } from "../src/outreach/drafts.ts";
import { ExampleStore } from "../src/outreach/examples.ts";
import { OutreachService, STATUS } from "../src/outreach/service.ts";

// Runs against a real Postgres with pgvector. Set TEST_DATABASE_URL to a throwaway database.
const url = process.env.TEST_DATABASE_URL;

const lead = (pageId: string, name: string, status: string, email: string | null): Lead => ({
  pageId,
  name,
  email,
  website: null,
  tags: [],
  status,
  url: `https://notion.so/${pageId}`,
});

describe.skipIf(!url)("outreach drafts", () => {
  let db: Db;
  let drafts: DraftStore;

  beforeAll(async () => {
    db = createPool(url!);
    await db.query("drop schema public cascade; create schema public;");
    await migrate(db);
    drafts = new DraftStore(db);
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query("truncate outreach_rules, outreach_drafts, audit_log restart identity cascade");
  });

  function setup(
    opts: { leads?: Lead[]; gmailFails?: boolean; sent?: string[]; repliedFrom?: string[]; signature?: string } = {},
  ) {
    const leads = opts.leads ?? [lead("p1", "Dana Levi", STATUS.potential, "dana@college.ac.il")];
    const gmailDrafts: { to: string; subject: string; body: string; html?: string }[] = [];
    const appended: { pageId: string; heading: string; text: string }[] = [];
    const statuses: [string, string][] = [];
    const notion = {
      async queryLeads(_ds: string, only?: string[]) {
        return leads.filter((l) => !only || only.includes(l.status!));
      },
      async getLead(id: string) {
        return leads.find((l) => l.pageId === id)!;
      },
      async pageText() {
        return "notes";
      },
      async appendSection(pageId: string, heading: string, text: string) {
        appended.push({ pageId, heading, text });
      },
      async setStatus(pageId: string, status: string) {
        statuses.push([pageId, status]);
      },
    } as unknown as NotionClient;
    const updated: { id: string; html?: string }[] = [];
    const gmail = {
      async signatureHtml() {
        return opts.signature ?? "";
      },
      async updateDraft(id: string, d: { html?: string }) {
        updated.push({ id, html: d.html });
        return { id };
      },
      async createDraft(d: { to: string; subject: string; body: string; html?: string }) {
        if (opts.gmailFails) throw new Error("HTTP 401");
        gmailDrafts.push(d);
        return { id: `g${gmailDrafts.length}` };
      },
      async search(q: string) {
        const who = q.split(":").pop()!;
        const hit = q.startsWith("in:sent") ? opts.sent?.includes(who) : opts.repliedFrom?.includes(who);
        return hit ? [{ id: "m", threadId: "t" }] : [];
      },
    } as unknown as GmailClient;
    let n = 0;
    const backend: ModelBackend = {
      name: "fake",
      async complete() {
        n++;
        return { text: "", model: "fake", structured: { subject: `Subject ${n}`, body: `Body *${n}*`, angle: "angle" } };
      },
    };
    const service = new OutreachService({
      db,
      drafts,
      examples: new ExampleStore(db),
      notion,
      leadsDataSource: "ds",
      gmail: async () => ({ gmail, account: "me@flowtika.com" }),
      backend,
      styleGuidePath: "/nonexistent",
      signature: "Omry Kaufman\n055-4222014",
      log: logger,
    });
    return { service, gmailDrafts, appended, statuses, updated };
  }

  it("drafts, revises from a comment, and keeps the comment as a rule once", async () => {
    const { service } = setup();
    const first = await service.draftFor((await service.findLeads("dana"))[0]!);
    expect(first).toMatchObject({ revision: 1, status: "pending", toAddress: "dana@college.ac.il", subject: "Subject 1" });

    const second = await service.revise(first.id, "make it shorter");
    expect(second).toMatchObject({ revision: 2, parentId: first.id, feedback: "make it shorter", status: "pending" });
    expect((await drafts.get(first.id))!.status).toBe("superseded");

    await drafts.addRule("make it shorter", second.id);
    await drafts.addRule("make it shorter", second.id);
    expect((await drafts.activeRules()).map((r) => r.rule)).toEqual(["make it shorter"]);
  });

  it("saves once to Gmail and Notion, even if tapped twice", async () => {
    const { service, gmailDrafts, appended } = setup();
    const draft = await service.draftFor(lead("p1", "Dana Levi", STATUS.potential, "dana@college.ac.il"));
    const [a, b] = await Promise.all([service.save(draft.id), service.save(draft.id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(gmailDrafts).toEqual([
      { to: "dana@college.ac.il", subject: "Subject 1", body: "Body 1", html: '<div dir="ltr">Body <b>1</b></div>' },
    ]);
    expect(appended[0]).toMatchObject({ pageId: "p1", text: "נושא: Subject 1\n\nBody *1*" });
    expect(appended[0]!.heading).toMatch(/^מייל\/פנייה \(\d{4}-\d{2}-\d{2}\)$/);
    expect(await drafts.get(draft.id)).toMatchObject({ status: "saved", gmailDraftId: "g1" });
    const { rows } = await db.query("select action from audit_log order by id");
    expect(rows.map((r) => r.action)).toContain("gmail.draft.created");
  });

  it("uses the Gmail signature in place of the text one, and refreshes a saved draft", async () => {
    const { service, updated } = setup({ signature: '<img src="logo.png">' });
    const lead1 = lead("p1", "Dana Levi", STATUS.potential, "dana@college.ac.il");
    const draft = await drafts.create({
      leadPageId: "p1",
      leadName: lead1.name,
      toAddress: lead1.email,
      subject: "נושא",
      body: "היי *דנה*,\nעמרי\nOmry Kaufman\n055-4222014",
      angle: "a",
    });
    await service.save(draft.id);
    const id = await service.refreshGmailDraft(draft.id);
    expect(id).toBe("g1");
    expect(updated[0]!.html).toBe(
      '<div dir="rtl" style="direction:rtl;text-align:right">היי <b>דנה</b>,<br>עמרי<br><div dir="ltr" class="gmail_signature"><img src="logo.png"></div></div>',
    );
  });

  it("leaves the draft pending when Gmail fails", async () => {
    const { service } = setup({ gmailFails: true });
    const draft = await service.draftFor(lead("p1", "Dana Levi", STATUS.potential, "dana@college.ac.il"));
    await expect(service.save(draft.id)).rejects.toThrow("HTTP 401");
    expect((await drafts.get(draft.id))!.status).toBe("pending");
  });

  it("batches only fresh leads with an email", async () => {
    const { service } = setup({
      leads: [
        lead("p1", "Dana", STATUS.potential, "dana@x.com"),
        lead("p2", "Yossi", STATUS.potential, null),
        lead("p3", "Rina", STATUS.potential, "rina@x.com"),
        lead("p4", "Old", STATUS.advanced, "old@x.com"),
      ],
    });
    await service.draftFor(lead("p1", "Dana", STATUS.potential, "dana@x.com"));
    const { leads, noEmail } = await service.batchCandidates(10);
    expect(leads.map((l) => l.name)).toEqual(["Rina"]);
    expect(noEmail.map((l) => l.name)).toEqual(["Yossi"]);
  });

  it("syncs statuses forward from the mailbox", async () => {
    const { service, statuses } = setup({
      leads: [
        lead("p1", "Dana", STATUS.potential, "dana@x.com"),
        lead("p2", "Rina", STATUS.firstSent, "rina@x.com"),
        lead("p3", "Quiet", STATUS.potential, "quiet@x.com"),
      ],
      sent: ["dana@x.com", "rina@x.com"],
      repliedFrom: ["rina@x.com"],
    });
    const result = await service.syncStatuses();
    expect(result.checked).toBe(3);
    expect(statuses).toEqual([
      ["p1", STATUS.firstSent],
      ["p2", STATUS.firstReplies],
    ]);
  });
});
