/** How hard a job is. Each agent picks a tier; config maps tiers to concrete models. */
export type ModelTier = "fast" | "standard" | "deep";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: ChatTurn[];
  tier: ModelTier;
}

export interface CompletionResult {
  text: string;
  model: string;
  costUsd?: number;
}

/**
 * The one seam between agents and whatever runs the model. Swapping the subscription-backed
 * Claude Code CLI for the Claude API is a config change because agents only see this interface.
 */
export interface ModelBackend {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export type TierModels = Record<ModelTier, string>;
