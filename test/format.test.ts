import { describe, expect, it } from "vitest";
import { mergeConsecutive } from "../src/agents/runtime.ts";
import { approvalCallback, parseApprovalCallback, splitForTelegram } from "../src/telegram/format.ts";

describe("splitForTelegram", () => {
  it("keeps short text whole", () => {
    expect(splitForTelegram("hello")).toEqual(["hello"]);
  });

  it("splits long text under the limit, preferring paragraph breaks", () => {
    const para = "a".repeat(30);
    const chunks = splitForTelegram(`${para}\n\n${para}\n\n${para}`, 70);
    expect(chunks).toEqual([`${para}\n\n${para}`, para]);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(70);
  });

  it("hard-cuts text with no breaks", () => {
    expect(splitForTelegram("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});

describe("approval callbacks", () => {
  const id = "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90";

  it("round-trips and fits Telegram's 64-byte limit", () => {
    const data = approvalCallback(id, "a");
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseApprovalCallback(data)).toEqual({ id, decision: "approved" });
    expect(parseApprovalCallback(approvalCallback(id, "r"))).toEqual({ id, decision: "rejected" });
  });

  it("ignores anything else", () => {
    expect(parseApprovalCallback("ap:not-a-uuid:a")).toBeNull();
    expect(parseApprovalCallback("other")).toBeNull();
  });
});

describe("mergeConsecutive", () => {
  it("joins same-role turns and drops a leading assistant turn", () => {
    expect(
      mergeConsecutive([
        { role: "assistant", content: "brief" },
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "c" },
      ]),
    ).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "c" },
    ]);
  });
});
