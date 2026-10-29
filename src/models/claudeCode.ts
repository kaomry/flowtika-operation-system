import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatTurn, CompletionRequest, CompletionResult, ModelBackend, TierModels } from "./types.ts";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (
  bin: string,
  args: string[],
  stdin: string,
  options: { cwd: string; timeoutMs: number },
) => Promise<ProcessResult>;

const defaultRunner: ProcessRunner = (bin, args, stdin, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude Code timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });

/** Claude Code takes one prompt per call, so the conversation is rendered into it. */
export function renderTranscript(messages: ChatTurn[]): string {
  const history = messages.slice(0, -1);
  const last = messages.at(-1);
  if (!last || last.role !== "user") throw new Error("The last message must come from the user.");
  const parts: string[] = [];
  if (history.length) {
    parts.push("<conversation_so_far>");
    for (const m of history) parts.push(`<${m.role}>\n${m.content}\n</${m.role}>`);
    parts.push("</conversation_so_far>", "");
  }
  parts.push("<new_message>", last.content, "</new_message>", "", "Reply to the new message.");
  return parts.join("\n");
}

interface ClaudeCodeJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
}

export function parseClaudeCodeOutput(stdout: string): { text: string; costUsd?: number } {
  let parsed: ClaudeCodeJson;
  try {
    parsed = JSON.parse(stdout) as ClaudeCodeJson;
  } catch {
    throw new Error(`Claude Code returned output that isn't JSON: ${stdout.slice(0, 300)}`);
  }
  if (parsed.is_error || parsed.subtype !== "success" || typeof parsed.result !== "string") {
    throw new Error(`Claude Code reported an error: ${parsed.result ?? parsed.subtype ?? "unknown"}`);
  }
  return { text: parsed.result.trim(), costUsd: parsed.total_cost_usd };
}

/**
 * Runs the official, unmodified Claude Code CLI in print mode, signed in with the owner's own
 * Claude account. Built-in tools and MCP servers are turned off: agents get capabilities from
 * this platform's own tool layer, never from the CLI.
 */
export class ClaudeCodeBackend implements ModelBackend {
  readonly name = "claude-code";
  private readonly workdir: string;

  constructor(
    private readonly models: TierModels,
    private readonly bin = "claude",
    private readonly run: ProcessRunner = defaultRunner,
    private readonly timeoutMs = 5 * 60 * 1000,
  ) {
    // An empty working directory keeps any project CLAUDE.md out of the agent's context.
    this.workdir = path.join(os.tmpdir(), "flowtika-agent");
    mkdirSync(this.workdir, { recursive: true });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = this.models[request.tier];
    const args = [
      "-p",
      "--output-format", "json",
      "--model", model,
      "--system-prompt", request.system,
      "--tools", "",
      "--strict-mcp-config",
      "--no-session-persistence",
    ];
    const result = await this.run(this.bin, args, renderTranscript(request.messages), {
      cwd: this.workdir,
      timeoutMs: this.timeoutMs,
    });
    if (result.code !== 0 && !result.stdout.trim()) {
      throw new Error(`Claude Code exited with code ${result.code}: ${result.stderr.slice(0, 500)}`);
    }
    const { text, costUsd } = parseClaudeCodeOutput(result.stdout);
    return { text, model, costUsd };
  }
}
