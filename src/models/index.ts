import type { Config } from "../config.ts";
import { AnthropicApiBackend } from "./anthropicApi.ts";
import { ClaudeCodeBackend } from "./claudeCode.ts";
import type { ModelBackend, TierModels } from "./types.ts";

export function createModelBackend(config: Config): ModelBackend {
  const models: TierModels = {
    fast: config.MODEL_FAST,
    standard: config.MODEL_STANDARD,
    deep: config.MODEL_DEEP,
  };
  return config.MODEL_BACKEND === "api"
    ? new AnthropicApiBackend(models)
    : new ClaudeCodeBackend(models, config.CLAUDE_BIN);
}

export type { ModelBackend, ModelTier, ChatTurn } from "./types.ts";
