import type { ModelTier } from "../models/types.ts";
import type { TaskService } from "../tasks/service.ts";

export interface AgentContext {
  now: Date;
  timezone: string;
  tasks: TaskService;
}

/**
 * An agent that returns structured output instead of plain text. `handle` turns the model's
 * object into side effects and the final text the owner sees.
 */
export interface AgentOutput {
  schema: Record<string, unknown>;
  handle(data: unknown, ctx: AgentContext): Promise<string>;
}

/**
 * Every agent follows the same contract: a written role, a model tier and, when it acts,
 * a structured output it is allowed to produce. Later phases add tools with risk levels.
 */
export interface AgentDefinition {
  name: string;
  description: string;
  tier: ModelTier;
  systemPrompt(ctx: AgentContext): string | Promise<string>;
  output?: AgentOutput;
}
