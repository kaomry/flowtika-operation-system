import { z } from "zod";
import { PRIORITIES, TASK_STATUSES, type Task, type TaskChanges, type TaskService } from "../tasks/service.ts";
import { formatLocal, parseDueDate } from "../tasks/time.ts";

/**
 * What the Chief of Staff returns: its reply plus the task changes to make. Every field is
 * required and nullable, which is what strict structured output needs.
 */
export const replyWithTaskActionsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "actions"],
  properties: {
    reply: { type: "string", description: "The message to send Omry." },
    actions: {
      type: "array",
      description: "Task changes to make. Empty when the message needs none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "task_id", "title", "notes", "status", "priority", "due", "clear_due"],
        properties: {
          type: { type: "string", enum: ["create_task", "update_task"] },
          task_id: { type: ["integer", "null"], description: "Required for update_task." },
          title: { type: ["string", "null"], description: "Required for create_task. Short, starts with a verb." },
          notes: { type: ["string", "null"] },
          status: { type: ["string", "null"], enum: [...TASK_STATUSES, null] },
          priority: { type: ["string", "null"], enum: [...PRIORITIES, null] },
          due: {
            type: ["string", "null"],
            description: "Local date-time like 2026-10-30T10:00, or a date like 2026-10-30. Null leaves it unchanged.",
          },
          clear_due: { type: "boolean", description: "True removes the due date." },
        },
      },
    },
  },
} as const;

const actionSchema = z.object({
  type: z.enum(["create_task", "update_task"]),
  task_id: z.number().int().nullable(),
  title: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.enum(TASK_STATUSES).nullable(),
  priority: z.enum(PRIORITIES).nullable(),
  due: z.string().nullable(),
  clear_due: z.boolean(),
});

export const replyWithTaskActions = z.object({
  reply: z.string(),
  actions: z.array(actionSchema),
});

export type TaskAction = z.infer<typeof actionSchema>;

const STATUS_WORDS: Record<string, string> = {
  todo: "to do",
  in_progress: "in progress",
  waiting: "waiting",
  done: "done",
  cancelled: "cancelled",
};

export function describeTask(task: Task, timezone: string): string {
  const bits = [`#${task.id} ${task.title}`];
  if (task.dueAt) bits.push(`due ${formatLocal(task.dueAt, timezone)}`);
  if (task.priority === "high") bits.push("high priority");
  if (task.status !== "todo") bits.push(STATUS_WORDS[task.status] ?? task.status);
  return bits.join(" · ");
}

/** Applies the agent's task actions and returns one confirmation line per action. */
export async function applyTaskActions(
  actions: TaskAction[],
  tasks: TaskService,
  timezone: string,
  actor: string,
): Promise<string[]> {
  const lines: string[] = [];
  for (const action of actions) {
    try {
      const dueAt = action.clear_due ? null : action.due ? parseDueDate(action.due, timezone) : undefined;
      if (action.type === "create_task") {
        if (!action.title?.trim()) throw new Error("a new task needs a title");
        const task = await tasks.create(
          {
            title: action.title.trim(),
            notes: action.notes,
            priority: action.priority ?? "normal",
            dueAt: dueAt ?? null,
          },
          actor,
        );
        lines.push(`✓ Added ${describeTask(task, timezone)}`);
      } else {
        if (action.task_id === null) throw new Error("no task number given");
        const changes: TaskChanges = {};
        if (action.title) changes.title = action.title.trim();
        if (action.notes !== null) changes.notes = action.notes;
        if (action.status) changes.status = action.status;
        if (action.priority) changes.priority = action.priority;
        if (dueAt !== undefined) changes.dueAt = dueAt;
        const task = await tasks.update(action.task_id, changes, actor);
        if (!task) throw new Error(`there is no task #${action.task_id}`);
        lines.push(`✓ Updated ${describeTask(task, timezone)}`);
      }
    } catch (err) {
      lines.push(`✗ Couldn't ${action.type === "create_task" ? "add" : "update"} a task: ${(err as Error).message}`);
    }
  }
  return lines;
}
