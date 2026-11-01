import { describe, expect, it } from "vitest";
import { buildMime } from "../src/google/gmail.ts";
import type { Fetch } from "../src/google/oauth.ts";
import { NotionClient } from "../src/notion/client.ts";
import { emphasisRuns, emphasisToHtml, stripEmphasis } from "../src/outreach/emphasis.ts";

describe("bold phrases", () => {
  it("splits a line into plain and bold runs", () => {
    expect(emphasisRuns("מי ש*מפחד* להיות *הפראייר* בעסקה")).toEqual([
      { text: "מי ש", bold: false },
      { text: "מפחד", bold: true },
      { text: " להיות ", bold: false },
      { text: "הפראייר", bold: true },
      { text: " בעסקה", bold: false },
    ]);
    expect(emphasisRuns("2 * 3 = 6")).toEqual([{ text: "2 * 3 = 6", bold: false }]);
  });

  it("strips markers for plain text and renders bold for HTML", () => {
    expect(stripEmphasis("היי,\n*כסף על הרצפה*")).toBe("היי,\nכסף על הרצפה");
    expect(emphasisToHtml("היי,\n*כסף* <על> הרצפה")).toBe('<div dir="rtl">היי,<br><b>כסף</b> &lt;על&gt; הרצפה</div>');
    expect(emphasisToHtml("Hi *Dana*")).toBe('<div dir="ltr">Hi <b>Dana</b></div>');
  });

  it("builds a draft with plain and HTML parts", () => {
    const mime = buildMime({ to: "a@b.com", subject: "S", body: "plain", html: "<b>bold</b>" });
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain(Buffer.from("plain").toString("base64"));
    expect(mime).toContain(Buffer.from("<b>bold</b>").toString("base64"));
    expect(buildMime({ to: "a@b.com", subject: "S", body: "plain" })).not.toContain("multipart");
  });

  it("writes bold phrases to Notion as bold text", async () => {
    let body: { children: { paragraph?: { rich_text: unknown[] } }[] } | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as Fetch;
    await new NotionClient("t", fetchFn).appendSection("p1", "מייל/פנייה", "היי *דנה*");
    expect(body!.children[1]!.paragraph!.rich_text).toEqual([
      { type: "text", text: { content: "היי " } },
      { type: "text", text: { content: "דנה" }, annotations: { bold: true } },
    ]);
  });
});
