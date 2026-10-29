import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agents/runtime.ts";
import type { AgentDefinition } from "../src/agents/types.ts";
import { ApprovalService, type Approval, type ApprovalPresenter } from "../src/approvals/service.ts";
import { migrate } from "../src/db/migrate.ts";
import { createPool, type Db } from "../src/db/pool.ts";
import type { CompletionRequest, ModelBackend } from "../src/models/types.ts";

// Runs against a real Postgres with pgvector. Set TEST_DATABASE_URL to a throwaway database.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("with a database", () => {
  let db: Db;

  beforeAll(async () => {
    db = createPool(url!);
    await db.query("drop schema public cascade; create schema public;");
    await migrate(db);
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query("truncate messages, approvals, audit_log restart identity");
  });

  it("migrations are idempotent", async () => {
    expect(await migrate(db)).toEqual([]);
  });

  describe("AgentRuntime", () => {
    const agent: AgentDefinition = {
      name: "test-agent",
      description: "",
      tier: "standard",
      systemPrompt: () => "system",
    };

    class FakeBackend implements ModelBackend {
      readonly name = "fake";
      requests: CompletionRequest[] = [];
      async complete(req: CompletionRequest) {
        this.requests.push(req);
        return { text: `reply ${this.requests.length}`, model: "fake-model" };
      }
    }

    it("remembers the conversation across messages", async () => {
      const backend = new FakeBackend();
      const runtime = new AgentRuntime(db, backend, { memoryMessages: 10, timezone: "UTC" });

      expect(await runtime.reply(agent, 1, "first")).toBe("reply 1");
      await runtime.reply(agent, 1, "second");

      expect(backend.requests[1]!.messages).toEqual([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "second" },
      ]);
      const { rows } = await db.query("select action from audit_log order by id");
      expect(rows.map((r) => r.action)).toEqual(["agent.reply", "agent.reply"]);
    });

    it("keeps chats apart and honours the memory limit", async () => {
      const backend = new FakeBackend();
      const runtime = new AgentRuntime(db, backend, { memoryMessages: 2, timezone: "UTC" });
      await runtime.reply(agent, 1, "a");
      await runtime.reply(agent, 2, "other chat");
      await runtime.reply(agent, 1, "b");

      // The last 2 messages of chat 1 are "reply 1" and "b"; the leading assistant turn is
      // dropped so the model always sees a user turn first, and chat 2 never leaks in.
      expect(backend.requests[2]!.messages).toEqual([{ role: "user", content: "b" }]);
    });

    it("stores the output of a scheduled run but not its instruction", async () => {
      const backend = new FakeBackend();
      const runtime = new AgentRuntime(db, backend, { memoryMessages: 10, timezone: "UTC" });
      await runtime.runInstruction(agent, 1, "[Scheduled] brief");
      const { rows } = await db.query("select role, content from messages");
      expect(rows).toEqual([{ role: "assistant", content: "reply 1" }]);
    });
  });

  describe("ApprovalService", () => {
    class FakePresenter implements ApprovalPresenter {
      shown: Approval[] = [];
      updates: Approval[] = [];
      async present(a: Approval) {
        this.shown.push(a);
        return { chatId: 42, messageId: this.shown.length };
      }
      async update(a: Approval) {
        this.updates.push(a);
      }
    }

    function setup() {
      const service = new ApprovalService(db);
      const presenter = new FakePresenter();
      service.setPresenter(presenter);
      const runs: unknown[] = [];
      service.register("test.send", async (payload) => {
        runs.push(payload);
        return { ok: true };
      });
      return { service, presenter, runs };
    }

    const req = { kind: "test.send", summary: "Send hi to Dana", payload: { to: "dana" }, requestedBy: "follow-up" };

    it("shows a card and runs nothing until approved", async () => {
      const { service, presenter, runs } = setup();
      const a = await service.request(req);
      expect(a.status).toBe("pending");
      expect(a.telegramMessageId).toBe(1);
      expect(presenter.shown).toHaveLength(1);
      expect(runs).toHaveLength(0);
      expect(await service.listPending()).toHaveLength(1);
    });

    it("runs the action exactly once after approval", async () => {
      const { service, runs } = setup();
      const a = await service.request(req);
      expect((await service.decide(a.id, "approved"))?.status).toBe("approved");
      expect(await service.decide(a.id, "rejected")).toBeNull();

      const [first, second] = await Promise.all([service.execute(a.id), service.execute(a.id)]);
      expect(runs).toEqual([{ to: "dana" }]);
      expect([first.status, second.status]).toContain("executed");
      expect((await service.get(a.id))?.result).toEqual({ ok: true });
    });

    it("never runs a rejected action", async () => {
      const { service, runs } = setup();
      const a = await service.request(req);
      await service.decide(a.id, "rejected");
      const after = await service.execute(a.id);
      expect(after.status).toBe("rejected");
      expect(runs).toHaveLength(0);
    });

    it("records a failing action as failed", async () => {
      const { service } = setup();
      service.register("test.broken", async () => {
        throw new Error("smtp down");
      });
      const a = await service.request({ ...req, kind: "test.broken" });
      await service.decide(a.id, "approved");
      const after = await service.execute(a.id);
      expect(after.status).toBe("failed");
      expect(after.result).toEqual({ error: "smtp down" });
    });

    it("refuses kinds with no executor", async () => {
      const { service } = setup();
      await expect(service.request({ ...req, kind: "unknown" })).rejects.toThrow(/No executor/);
    });

    it("audits every step", async () => {
      const { service } = setup();
      const a = await service.request(req);
      await service.decide(a.id, "approved");
      await service.execute(a.id);
      const { rows } = await db.query("select action from audit_log order by id");
      expect(rows.map((r) => r.action)).toEqual(["approval.requested", "approval.approved", "approval.executed"]);
    });
  });
});
