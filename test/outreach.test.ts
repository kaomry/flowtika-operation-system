import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.ts";
import { createPool, type Db } from "../src/db/pool.ts";
import type { GmailClient, Message, MessageMeta } from "../src/google/gmail.ts";
import { collectColdEmails } from "../src/outreach/collect.ts";
import { ExampleStore } from "../src/outreach/examples.ts";

// Runs against a real Postgres with pgvector. Set TEST_DATABASE_URL to a throwaway database.
const url = process.env.TEST_DATABASE_URL;
const ME = "omry@flowtika.com";
const LONG = "I help colleges answer every inquiry within five minutes and follow up until the student decides. ".repeat(3);

const msg = (id: string, threadId: string, from: string, to: string[], day: number, subject = "Quick idea", body = LONG): Message => ({
  id,
  threadId,
  sentAt: new Date(Date.UTC(2026, 5, day, 9)),
  from: { name: null, email: from },
  to: to.map((email) => ({ name: email === "dana@college.ac.il" ? "Dana Levi" : null, email })),
  cc: [],
  subject,
  labelIds: from === ME ? ["SENT"] : ["INBOX"],
  body,
});

/** A fake mailbox: threads of messages, answering the searches the collector makes. */
function fakeGmail(threads: Message[][]) {
  const all = threads.flat();
  const day = (q: string) => {
    const [y, m, d] = /before:(\d+)\/(\d+)\/(\d+)/.exec(q)!.slice(1).map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return {
    async search(q: string) {
      if (q.startsWith("in:sent")) return all.filter((m) => m.from?.email === ME).map(({ id, threadId }) => ({ id, threadId }));
      const who = /from:(\S+) OR/.exec(q)![1]!;
      return all
        .filter((m) => m.sentAt.getTime() < day(q))
        .filter((m) => m.from?.email === who || m.to.some((a) => a.email === who))
        .map(({ id, threadId }) => ({ id, threadId }));
    },
    async getThreadMeta(threadId: string): Promise<MessageMeta[]> {
      return threads.find((t) => t[0]!.threadId === threadId)!;
    },
    async getMessage(id: string) {
      return all.find((m) => m.id === id)!;
    },
  } as unknown as GmailClient;
}

describe.skipIf(!url)("cold email collection", () => {
  let db: Db;
  let store: ExampleStore;

  beforeAll(async () => {
    db = createPool(url!);
    await db.query("drop schema public cascade; create schema public;");
    await migrate(db);
    store = new ExampleStore(db);
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query("truncate outreach_examples, audit_log restart identity");
  });

  const mailbox = () =>
    fakeGmail([
      // Cold, and Dana replied.
      [msg("a1", "ta", ME, ["dana@college.ac.il"], 10), msg("a2", "ta", "dana@college.ac.il", [ME], 11, "Re: Quick idea", "Sounds good")],
      // Cold, no reply.
      [msg("b1", "tb", ME, ["yossi@realestate.co.il"], 12, "Leads after hours")],
      // A reply to someone who wrote first: not outreach.
      [msg("c1", "tc", "client@x.com", [ME], 1), msg("c2", "tc", ME, ["client@x.com"], 2, "Re: Quick idea")],
      // A second thread to someone already emailed: a follow-up, not a cold email.
      [msg("d1", "td", ME, ["dana@college.ac.il"], 20, "Following up")],
      // Too short to be outreach.
      [msg("e1", "te", ME, ["dad@family.net"], 13, "Zoom", "here's the link")],
      // An unsubscribe.
      [msg("f1", "tf", ME, ["unsubscribe@news.example.com"], 14, "unsubscribe")],
    ]);

  it("keeps only first emails to new people, with whether they replied", async () => {
    const result = await collectColdEmails(mailbox(), store, ME, { ownAddresses: [], since: new Date("2026-01-01") });
    expect(result).toEqual({ scannedThreads: 6, added: 2 });

    const found = await store.nextForReview(10);
    expect(found.map((e) => [e.toAddress, e.replied])).toEqual([
      ["dana@college.ac.il", true],
      ["yossi@realestate.co.il", false],
    ]);
    expect(found[0]).toMatchObject({ toName: "Dana Levi", language: "en", status: "candidate" });
  });

  it("doesn't collect the same thread twice", async () => {
    const gmail = mailbox();
    await collectColdEmails(gmail, store, ME, { ownAddresses: [], since: new Date("2026-01-01") });
    const again = await collectColdEmails(gmail, store, ME, { ownAddresses: [], since: new Date("2026-01-01") });
    expect(again.added).toBe(0);
  });

  it("records the owner's review", async () => {
    await collectColdEmails(mailbox(), store, ME, { ownAddresses: [], since: new Date("2026-01-01") });
    const [first, second] = await store.nextForReview(10);
    await store.review(first!.id, "gold");
    await store.review(second!.id, "skip");
    expect(await store.counts()).toEqual({ candidate: 0, kept: 1, skipped: 1, gold: 1 });
    expect(await store.nextForReview(10)).toEqual([]);
    const { rows } = await db.query("select action from audit_log");
    expect(rows.map((r) => r.action)).toEqual(["outreach.example.reviewed", "outreach.example.reviewed"]);
  });
});
