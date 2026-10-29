import type { ModelTier } from "../models/types.ts";

export interface AgentContext {
  now: Date;
  timezone: string;
}

/**
 * Every agent follows the same contract: a written role and a model tier. Later phases add
 * the list of tools each agent may call and a risk level per tool.
 */
export interface AgentDefinition {
  name: string;
  description: string;
  tier: ModelTier;
  systemPrompt(ctx: AgentContext): string;
}
