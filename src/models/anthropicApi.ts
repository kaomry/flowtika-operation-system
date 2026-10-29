import Anthropic from "@anthropic-ai/sdk";
import type { CompletionRequest, CompletionResult, ModelBackend, TierModels } from "./types.ts";

/** Pay-per-use Claude API backend, for when the platform runs around the clock or on a server. */
export class AnthropicApiBackend implements ModelBackend {
  readonly name = "api";

  constructor(
    private readonly models: TierModels,
    private readonly client: Anthropic = new Anthropic(),
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = this.models[request.tier];
    const response = await this.client.messages.create({
      model,
      max_tokens: 16000,
      system: request.system,
      messages: request.messages,
    });
    if (response.stop_reason === "refusal") {
      throw new Error("The model declined this request.");
    }
    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
    return { text, model };
  }
}
