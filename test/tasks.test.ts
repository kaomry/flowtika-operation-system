import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chiefOfStaff } from "../src/agents/chiefOfStaff.ts";
import { AgentRuntime } from "../src/agents/runtime.ts";
import { applyTaskActions, type TaskAction } from "../src/agents/taskActions.ts";
import { migrate } from "../src/db/migrate.ts";
import { createPool, type Db } from "../src/db/pool.ts";
import type { CompletionRequest, ModelBackend } from "../src/models/types.ts";
import { TaskService } from "../src/tasks/service.ts";

// Runs against a real Postgres with pgvector. Set TEST_DATABASE_URL to a throwaway database.
const url = process.env.TEST_DATABASE_URL;
const TZ = "Asia/Jerusalem";

const action = (a: Partial<TaskAction> & Pick<TaskAction, "type">): TaskAction => ({
  task_id: null,
  title: null,
  notes: null,
  status: null,
  priority: null,
  due: null,
  clear_due: false,
  ...a,
});

describe.skipIf(!url)("tasks", () => {
  let db: Db;
  let tasks: TaskService;

  beforeAll(async () => {
    db = createPool(url!);
    await db.query("drop schema public cascade; create schema public;");
    await migrate(db);
    tasks = new TaskService(db, TZ);
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query("truncate messages, approvals, audit_log, tasks restart identity");
  });

  describe("TaskService", () => {
    it("orders open tasks by due date, then priority", async () => {
      await tasks.create({ title: "undated" }, "test");
      await tasks.create({ title: "later", dueAt: new Date("2026-12-03T08:00:00Z") }, "test");
      await tasks.create({ title: "sooner", dueAt: new Date("2026-12-02T08:00:00Z") }, "test");
      await tasks.create({ title: "urgent undated", priority: "high" }, "test");
      const done = await tasks.create({ title: "finished" }, "test");
      await tasks.update(done.id, { status: "done" }, "test");

      expect((await tasks.listOpen()).map((t) => t.title)).toEqual(["sooner", "later", "urgent undated", "undated"]);
    });

    it("lists what's due today, overdue included", async () => {
      const now = new Date("2026-12-01T10:00:00Z"); // 12:00 in Israel
      await tasks.create({ title: "overdue", dueAt: new Date("2026-11-30T08:00:00Z") }, "test");
      await tasks.create({ title: "tonight", dueAt: new Date("2026-12-01T20:00:00Z") }, "test");
      await tasks.create({ title: "tomorrow", dueAt: new Date("2026-12-02T08:00:00Z") }, "test");
      expect((await tasks.dueToday(now)).map((t) => t.title)).toEqual(["overdue", "tonight"]);
    });

    it("reminds once per due date, and again after a snooze", async () => {
      const due = new Date("2026-12-01T08:00:00Z");
      const t = await tasks.create({ title: "call Dana", dueAt: due }, "test");
      await tasks.create({ title: "not yet", dueAt: new Date("2026-12-05T08:00:00Z") }, "test");

      const now = new Date("2026-12-01T08:01:00Z");
      const [a, b] = await Promise.all([tasks.claimDueReminders(now), tasks.claimDueReminders(now)]);
      expect([...a, ...b].map((x) => x.title)).toEqual(["call Dana"]);
      expect(await tasks.claimDueReminders(now)).toEqual([]);

      await tasks.update(t.id, { dueAt: new Date("2026-12-01T09:00:00Z") }, "test");
      expect(await tasks.claimDueReminders(now)).toEqual([]);
      expect((await tasks.claimDueReminders(new Date("2026-12-01T09:00:00Z"))).map((x) => x.id)).toEqual([t.id]);
    });

    it("doesn't remind about finished tasks", async () => {
      const t = await tasks.create({ title: "x", dueAt: new Date("2026-12-01T08:00:00Z") }, "test");
      await tasks.update(t.id, { status: "done" }, "test");
      expect(await tasks.claimDueReminders(new Date("2026-12-02T00:00:00Z"))).toEqual([]);
    });
  });

  describe("applyTaskActions", () => {
    it("creates and updates tasks and confirms each change", async () => {
      const lines = await applyTaskActions(
        [action({ type: "create_task", title: "Send proposal to the college", due: "2026-12-01T10:00", priority: "high" })],
        tasks,
        TZ,
        "chief-of-staff",
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^✓ Added #1 Send proposal to the college · due .*10:00 · high priority$/);
      const created = await tasks.get(1);
      expect(created?.dueAt?.toISOString()).toBe("2026-12-01T08:00:00.000Z");

      const updated = await applyTaskActions(
        [action({ type: "update_task", task_id: 1, status: "waiting", clear_due: true })],
        tasks,
        TZ,
        "chief-of-staff",
      );
      expect(updated).toEqual(["✓ Updated #1 Send proposal to the college · high priority · waiting"]);
    });

    it("reports bad actions without stopping the rest", async () => {
      const lines = await applyTaskActions(
        [
          action({ type: "update_task", task_id: 99, status: "done" }),
          action({ type: "create_task", title: "  " }),
          action({ type: "create_task", title: "Bad date", due: "someday" }),
          action({ type: "create_task", title: "Fine" }),
        ],
        tasks,
        TZ,
        "chief-of-staff",
      );
      expect(lines[0]).toMatch(/no task #99/);
      expect(lines[1]).toMatch(/needs a title/);
      expect(lines[2]).toMatch(/Not a date/);
      expect(lines[3]).toBe("✓ Added #1 Fine");
    });
  });

  describe("Chief of Staff with tasks", () => {
    class ScriptedBackend implements ModelBackend {
      readonly name = "scripted";
      requests: CompletionRequest[] = [];
      constructor(private readonly outputs: unknown[]) {}
      async complete(req: CompletionRequest) {
        this.requests.push(req);
        return { text: "", model: "scripted", structured: this.outputs[this.requests.length - 1] };
      }
    }

    it("turns the agent's actions into tasks and shows them in its next prompt", async () => {
      const backend = new ScriptedBackend([
        { reply: "Got it.", actions: [action({ type: "create_task", title: "Call Dana", due: "2026-12-01T10:00" })] },
        { reply: "You have one task.", actions: [] },
      ]);
      const runtime = new AgentRuntime(db, backend, tasks, { memoryMessages: 10, timezone: TZ });

      const first = await runtime.reply(chiefOfStaff, 1, "remind me to call Dana on Dec 1 at 10");
      expect(first).toMatch(/^Got it\.\n\n✓ Added #1 Call Dana · due /);
      expect(backend.requests[0]!.jsonSchema).toBeDefined();

      await runtime.reply(chiefOfStaff, 1, "what's on my list?");
      expect(backend.requests[1]!.system).toContain("#1 Call Dana");
      // The confirmation is remembered, so follow-ups can refer to it.
      expect(backend.requests[1]!.messages[1]!.content).toContain("✓ Added #1 Call Dana");
    });

    it("fails clearly when the model returns the wrong shape", async () => {
      const runtime = new AgentRuntime(db, new ScriptedBackend([{ nope: true }]), tasks, {
        memoryMessages: 10,
        timezone: TZ,
      });
      await expect(runtime.reply(chiefOfStaff, 1, "hi")).rejects.toThrow(/expected format/);
    });
  });
});
