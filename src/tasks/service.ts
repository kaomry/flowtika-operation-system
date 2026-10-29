import { audit } from "../db/audit.ts";
import type { Db } from "../db/pool.ts";
import { endOfLocalDay } from "./time.ts";

export const TASK_STATUSES = ["todo", "in_progress", "waiting", "done", "cancelled"] as const;
export const OPEN_STATUSES = ["todo", "in_progress", "waiting"] as const;
export const PRIORITIES = ["low", "normal", "high"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];

export interface Task {
  id: number;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: Priority;
  dueAt: Date | null;
  remindedAt: Date | null;
  source: string;
  createdAt: Date;
}

export interface NewTask {
  title: string;
  notes?: string | null;
  priority?: Priority;
  dueAt?: Date | null;
  source?: string;
}

export interface TaskChanges {
  title?: string;
  notes?: string | null;
  status?: TaskStatus;
  priority?: Priority;
  dueAt?: Date | null;
}

interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: Priority;
  due_at: Date | null;
  reminded_at: Date | null;
  source: string;
  created_at: Date;
}

const toTask = (r: TaskRow): Task => ({
  id: Number(r.id),
  title: r.title,
  notes: r.notes,
  status: r.status,
  priority: r.priority,
  dueAt: r.due_at,
  remindedAt: r.reminded_at,
  source: r.source,
  createdAt: r.created_at,
});

// Open tasks first by due date (undated last), then high priority first, then oldest.
const ORDER = `order by due_at asc nulls last,
  case priority when 'high' then 0 when 'normal' then 1 else 2 end, id asc`;

export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly timezone: string,
  ) {}

  async create(task: NewTask, actor: string): Promise<Task> {
    const { rows } = await this.db.query<TaskRow>(
      `insert into tasks (title, notes, priority, due_at, source)
       values ($1, $2, $3, $4, $5) returning *`,
      [task.title, task.notes ?? null, task.priority ?? "normal", task.dueAt ?? null, task.source ?? actor],
    );
    const created = toTask(rows[0]!);
    await audit(this.db, actor, "task.created", { id: created.id, title: created.title });
    return created;
  }

  async update(id: number, changes: TaskChanges, actor: string): Promise<Task | null> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (changes.title !== undefined) set("title", changes.title);
    if (changes.notes !== undefined) set("notes", changes.notes);
    if (changes.priority !== undefined) set("priority", changes.priority);
    if (changes.status !== undefined) {
      set("status", changes.status);
      sets.push(
        changes.status === "done" ? "completed_at = now()" : "completed_at = null",
      );
    }
    if (changes.dueAt !== undefined) {
      set("due_at", changes.dueAt);
      // A new due date earns a new reminder.
      sets.push("reminded_at = null");
    }
    if (!sets.length) return this.get(id);
    sets.push("updated_at = now()");

    const { rows } = await this.db.query<TaskRow>(
      `update tasks set ${sets.join(", ")} where id = $1 returning *`,
      values,
    );
    if (!rows[0]) return null;
    const updated = toTask(rows[0]);
    await audit(this.db, actor, "task.updated", { id, changes });
    return updated;
  }

  async get(id: number): Promise<Task | null> {
    const { rows } = await this.db.query<TaskRow>("select * from tasks where id = $1", [id]);
    return rows[0] ? toTask(rows[0]) : null;
  }

  async listOpen(): Promise<Task[]> {
    const { rows } = await this.db.query<TaskRow>(
      `select * from tasks where status = any($1) ${ORDER}`,
      [OPEN_STATUSES],
    );
    return rows.map(toTask);
  }

  /** Open tasks due before the end of today (local time), overdue ones included. */
  async dueToday(now = new Date()): Promise<Task[]> {
    const { rows } = await this.db.query<TaskRow>(
      `select * from tasks where status = any($1) and due_at < $2 ${ORDER}`,
      [OPEN_STATUSES, endOfLocalDay(now, this.timezone)],
    );
    return rows.map(toTask);
  }

  /**
   * Claims open tasks that have come due and haven't been reminded about, marking them
   * reminded in the same statement so two workers can't remind twice.
   */
  async claimDueReminders(now = new Date()): Promise<Task[]> {
    const { rows } = await this.db.query<TaskRow>(
      `update tasks set reminded_at = $2
       where status = any($1) and due_at <= $2 and reminded_at is null
       returning *`,
      [OPEN_STATUSES, now],
    );
    return rows.map(toTask).sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0));
  }
}
