import { describe, expect, it } from "vitest";
import {
  ClaudeCodeBackend,
  parseClaudeCodeOutput,
  renderTranscript,
  type ProcessRunner,
} from "../src/models/claudeCode.ts";

const models = { fast: "haiku", standard: "sonnet", deep: "opus" };

describe("renderTranscript", () => {
  it("puts history before the new message", () => {
    const prompt = renderTranscript([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "what did I say?" },
    ]);
    expect(prompt).toContain("<conversation_so_far>\n<user>\nhi\n</user>\n<assistant>\nhello\n</assistant>");
    expect(prompt).toContain("<new_message>\nwhat did I say?\n</new_message>");
  });

  it("omits the history block for a first message", () => {
    expect(renderTranscript([{ role: "user", content: "hi" }])).not.toContain("conversation_so_far");
  });

  it("refuses a transcript that doesn't end with the user", () => {
    expect(() => renderTranscript([{ role: "assistant", content: "x" }])).toThrow();
  });
});

describe("parseClaudeCodeOutput", () => {
  it("reads the result and cost", () => {
    const out = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: " Hi! ", total_cost_usd: 0.01 });
    expect(parseClaudeCodeOutput(out)).toEqual({ text: "Hi!", costUsd: 0.01 });
  });

  it("throws on an error result", () => {
    const out = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" });
    expect(() => parseClaudeCodeOutput(out)).toThrow(/boom/);
  });

  it("throws on non-JSON output", () => {
    expect(() => parseClaudeCodeOutput("Not logged in")).toThrow(/isn't JSON/);
  });
});

describe("ClaudeCodeBackend", () => {
  it("runs the CLI with tools off and the tier's model", async () => {
    let seen: { bin: string; args: string[]; stdin: string } | undefined;
    const runner: ProcessRunner = async (bin, args, stdin) => {
      seen = { bin, args, stdin };
      return { code: 0, stderr: "", stdout: JSON.stringify({ subtype: "success", is_error: false, result: "ok" }) };
    };
    const backend = new ClaudeCodeBackend(models, "claude", runner);
    const result = await backend.complete({
      system: "be brief",
      tier: "fast",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result).toMatchObject({ text: "ok", model: "haiku" });
    expect(seen?.bin).toBe("claude");
    const args = seen!.args;
    expect(args).toContain("-p");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("be brief");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(seen?.stdin).toContain("hello");
  });

  it("surfaces stderr when the CLI fails without output", async () => {
    const runner: ProcessRunner = async () => ({ code: 1, stdout: "", stderr: "command not found" });
    const backend = new ClaudeCodeBackend(models, "claude", runner);
    await expect(
      backend.complete({ system: "", tier: "fast", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/command not found/);
  });
});
