import { describe, expect, it } from "vitest";
import type { CompletionRequest, ModelBackend } from "../src/models/types.ts";
import type { Lead } from "../src/notion/client.ts";
import { nextStatus, STATUS } from "../src/outreach/service.ts";
import { writeDraft, writerSystemPrompt, writerUserMessage, type WriterInput } from "../src/outreach/writer.ts";
import { draftCallback, parseDraftCallback } from "../src/telegram/format.ts";

const lead: Lead = {
  pageId: "p1",
  name: "Dana Levi",
  email: "dana@college.ac.il",
  website: "college.ac.il",
  tags: ["education"],
  status: STATUS.potential,
  url: "https://notion.so/p1",
};

const input: WriterInput = {
  styleGuide: "Open with היי [name],",
  signature: "Omry Kaufman\nFounder & RevOps Strategic\n052-4222014",
  rules: ["Never mention AI in the first line"],
  examples: [],
  lead,
  notes: "Met at the conference",
  websiteText: "Admissions open",
};

describe("outreach writer", () => {
  it("puts the guide, rules and signature in the prompt", () => {
    const system = writerSystemPrompt(input);
    expect(system).toContain("Open with היי [name],");
    expect(system).toContain("- Never mention AI in the first line");
    expect(system).toContain("052-4222014");
    const user = writerUserMessage(input);
    expect(user).toContain("Met at the conference");
    expect(user).toContain("Write the first cold email");
  });

  it("asks for a rewrite that addresses the comment", () => {
    const user = writerUserMessage({ ...input, previous: { subject: "S", body: "B", feedback: "shorter please" } });
    expect(user).toContain("shorter please");
    expect(user).not.toContain("Write the first cold email");
  });

  it("returns the structured draft and rejects a malformed one", async () => {
    let request: CompletionRequest | undefined;
    const backend = (structured: unknown): ModelBackend => ({
      name: "fake",
      async complete(r) {
        request = r;
        return { text: "", model: "fake", structured };
      },
    });
    const draft = await writeDraft(backend({ subject: "Hi", body: "Body", angle: "Why" }), input);
    expect(draft).toEqual({ subject: "Hi", body: "Body", angle: "Why" });
    expect(request?.tier).toBe("deep");
    expect(request?.jsonSchema).toBeDefined();
    await expect(writeDraft(backend({ subject: "Hi" }), input)).rejects.toThrow(/expected format/);
  });

  it("moves lead statuses forward only", () => {
    expect(nextStatus(STATUS.potential, { sent: true, replied: false })).toBe(STATUS.firstSent);
    expect(nextStatus(STATUS.potential, { sent: true, replied: true })).toBe(STATUS.firstReplies);
    expect(nextStatus(STATUS.firstSent, { sent: true, replied: true })).toBe(STATUS.firstReplies);
    expect(nextStatus(null, { sent: true, replied: false })).toBe(STATUS.firstSent);
    expect(nextStatus(STATUS.firstSent, { sent: true, replied: false })).toBeNull();
    expect(nextStatus(STATUS.potential, { sent: false, replied: false })).toBeNull();
    // Later or manual statuses are never touched.
    expect(nextStatus(STATUS.advanced, { sent: true, replied: true })).toBeNull();
    expect(nextStatus("לא רלוונטי", { sent: true, replied: true })).toBeNull();
  });

  it("round-trips draft button data", () => {
    expect(parseDraftCallback(draftCallback(42, "save"))).toEqual({ id: 42, button: "save" });
    expect(parseDraftCallback(draftCallback(7, "rule"))).toEqual({ id: 7, button: "rule" });
    expect(parseDraftCallback("ox:1:k")).toBeNull();
  });
});
