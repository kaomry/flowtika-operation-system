import { audit } from "../db/audit.ts";
import { recentMessages, saveMessage } from "../db/messages.ts";
import type { Db } from "../db/pool.ts";
import type { ChatTurn, ModelBackend } from "../models/types.ts";
import type { AgentDefinition } from "./types.ts";

export class AgentRuntime {
  constructor(
    private readonly db: Db,
    private readonly backend: ModelBackend,
    private readonly options: { memoryMessages: number; timezone: string },
  ) {}

  /** Handles one message from the owner: remembers it, asks the agent, remembers the reply. */
  async reply(agent: AgentDefinition, chatId: number, text: string): Promise<string> {
    await saveMessage(this.db, chatId, "user", text);
    const history = await recentMessages(this.db, chatId, this.options.memoryMessages);
    const messages = toTurns(history);
    return this.run(agent, chatId, messages, "agent.reply");
  }

  /**
   * Runs an agent on an instruction that didn't come from the owner, such as a schedule.
   * The instruction isn't stored, but the output is, so the owner can follow up on it.
   */
  async runInstruction(agent: AgentDefinition, chatId: number, instruction: string): Promise<string> {
    const history = await recentMessages(this.db, chatId, this.options.memoryMessages);
    const messages = toTurns(history);
    messages.push({ role: "user", content: instruction });
    return this.run(agent, chatId, mergeConsecutive(messages), "agent.scheduled");
  }

  private async run(
    agent: AgentDefinition,
    chatId: number,
    messages: ChatTurn[],
    action: string,
  ): Promise<string> {
    const started = Date.now();
    const result = await this.backend.complete({
      system: agent.systemPrompt({ now: new Date(), timezone: this.options.timezone }),
      messages,
      tier: agent.tier,
    });
    const text = result.text || "(no reply)";
    await saveMessage(this.db, chatId, "assistant", text, agent.name);
    await audit(this.db, agent.name, action, {
      chatId,
      backend: this.backend.name,
      model: result.model,
      costUsd: result.costUsd,
      ms: Date.now() - started,
    });
    return text;
  }
}

function toTurns(history: { role: "user" | "assistant"; content: string }[]): ChatTurn[] {
  return mergeConsecutive(history.map((m) => ({ role: m.role, content: m.content })));
}

/** The Claude API needs alternating roles and a user turn first; stored history may not be. */
export function mergeConsecutive(turns: ChatTurn[]): ChatTurn[] {
  const merged: ChatTurn[] = [];
  for (const turn of turns) {
    const prev = merged.at(-1);
    if (prev && prev.role === turn.role) prev.content = `${prev.content}\n\n${turn.content}`;
    else merged.push({ ...turn });
  }
  while (merged[0]?.role === "assistant") merged.shift();
  return merged;
}
