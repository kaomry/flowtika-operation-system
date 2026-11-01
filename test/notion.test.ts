import { describe, expect, it } from "vitest";
import type { Fetch } from "../src/google/oauth.ts";
import { blockText, NotionClient } from "../src/notion/client.ts";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeNotion(responses: unknown[]) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(responses.shift() ?? {}), { status: 200 });
  }) as Fetch;
  return { client: new NotionClient("secret", fetchFn), calls };
}

const leadPage = (id: string, name: string, status: string, email: string | null) => ({
  id,
  url: `https://notion.so/${id}`,
  properties: {
    Name: { type: "title", title: [{ plain_text: name }] },
    Email: { type: "email", email },
    Website: { type: "url", url: "college.ac.il" },
    Tags: { type: "multi_select", multi_select: [{ name: "education" }] },
    "lead status": { type: "select", select: { name: status } },
  },
});

describe("Notion client", () => {
  it("queries leads by status and follows pagination", async () => {
    const { client, calls } = fakeNotion([
      { results: [leadPage("p1", "Dana", "פוטנציאל", " Dana@College.ac.il ")], has_more: true, next_cursor: "c2" },
      { results: [leadPage("p2", "Yossi", "פוטנציאל", null)], has_more: false, next_cursor: null },
    ]);
    const leads = await client.queryLeads("ds1", ["פוטנציאל"]);
    expect(leads.map((l) => [l.name, l.email, l.status, l.tags])).toEqual([
      ["Dana", "dana@college.ac.il", "פוטנציאל", ["education"]],
      ["Yossi", null, "פוטנציאל", ["education"]],
    ]);
    expect(calls[0]).toMatchObject({
      url: "https://api.notion.com/v1/data_sources/ds1/query",
      method: "POST",
      body: { filter: { or: [{ property: "lead status", select: { equals: "פוטנציאל" } }] } },
    });
    expect((calls[1]!.body as { start_cursor: string }).start_cursor).toBe("c2");
  });

  it("reads page notes, nested blocks included", async () => {
    const { client } = fakeNotion([
      {
        results: [
          { id: "b1", type: "heading_2", has_children: false, heading_2: { rich_text: [{ plain_text: "ממצאים" }] } },
          { id: "b2", type: "toggle", has_children: true, toggle: { rich_text: [{ plain_text: "Call notes" }] } },
        ],
        has_more: false,
      },
      {
        results: [{ id: "b3", type: "bulleted_list_item", has_children: false, bulleted_list_item: { rich_text: [{ plain_text: "No CRM" }] } }],
        has_more: false,
      },
    ]);
    expect(await client.pageText("p1")).toBe("# ממצאים\nCall notes\n  - No CRM");
  });

  it("appends a section, splitting long lines and batches", async () => {
    const { client, calls } = fakeNotion([{}, {}]);
    const text = ["x".repeat(4500), ...Array.from({ length: 120 }, (_, i) => `line ${i}`)].join("\n");
    await client.appendSection("p1", "מייל/פנייה", text);
    expect(calls).toHaveLength(2);
    const first = (calls[0]!.body as { children: { type: string; paragraph?: { rich_text: unknown[] } }[] }).children;
    expect(first).toHaveLength(100);
    expect(first[0]!.type).toBe("heading_2");
    expect(first[1]!.paragraph!.rich_text).toHaveLength(3);
    expect(calls[0]!.method).toBe("PATCH");
  });

  it("sets the lead status", async () => {
    const { client, calls } = fakeNotion([{}]);
    await client.setStatus("p1", "נשלחה פנייה ראשונה");
    expect(calls[0]).toMatchObject({
      url: "https://api.notion.com/v1/pages/p1",
      method: "PATCH",
      body: { properties: { "lead status": { select: { name: "נשלחה פנייה ראשונה" } } } },
    });
  });

  it("turns table rows and pages into text", () => {
    expect(blockText({ id: "t", type: "table_row", has_children: false, table_row: { cells: [[{ plain_text: "a" }], [{ plain_text: "b" }]] } })).toBe("a | b");
    expect(blockText({ id: "c", type: "child_page", has_children: true, child_page: { title: "Meeting" } })).toBe("[page] Meeting");
  });
});
