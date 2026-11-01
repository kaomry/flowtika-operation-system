import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildMime, extractBody, GmailClient, parseAddresses } from "../src/google/gmail.ts";
import { AccessTokenSource, buildAuthRequest, type Fetch } from "../src/google/oauth.ts";
import { detectLanguage } from "../src/outreach/examples.ts";
import { exampleCallback, parseExampleCallback } from "../src/telegram/format.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("Google sign-in", () => {
  it("builds a consent URL with PKCE and offline access", () => {
    const auth = buildAuthRequest({ clientId: "cid", clientSecret: "secret" }, "http://127.0.0.1:5000");
    const url = new URL(auth.url);
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("gmail.readonly");
    expect(url.searchParams.get("scope")).not.toContain("gmail.send");
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(auth.verifier).digest("base64url"));
    expect(url.searchParams.get("state")).toBe(auth.state);
    expect(auth.url).not.toContain("secret");
  });

  it("refreshes the access token only when it is about to expire", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ access_token: `t${calls}`, expires_in: 3600 }), { status: 200 });
    }) as Fetch;
    let now = 0;
    const source = new AccessTokenSource({ clientId: "c", clientSecret: "s" }, "refresh", fakeFetch, () => now);
    expect(await source.get()).toBe("t1");
    now = 3_000_000;
    expect(await source.get()).toBe("t1");
    now = 3_550_000;
    expect(await source.get()).toBe("t2");
  });

  it("explains a failed refresh", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), {
        status: 400,
      })) as Fetch;
    const source = new AccessTokenSource({ clientId: "c", clientSecret: "s" }, "refresh", fakeFetch);
    await expect(source.get()).rejects.toThrow(/expired or revoked/);
  });
});

describe("Gmail parsing", () => {
  it("reads names and addresses", () => {
    expect(parseAddresses('"Levi, Dana" <Dana@Example.com>, bob@y.co.il')).toEqual([
      { name: "Levi, Dana", email: "dana@example.com" },
      { name: null, email: "bob@y.co.il" },
    ]);
    expect(parseAddresses("")).toEqual([]);
  });

  it("prefers the plain-text part and falls back to HTML", () => {
    const plain = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64("שלום דנה,\r\nמה שלומך?") } },
        { mimeType: "text/html", body: { data: b64("<p>ignored</p>") } },
      ],
    };
    expect(extractBody(plain)).toBe("שלום דנה,\nמה שלומך?");
    const html = { mimeType: "text/html", body: { data: b64("<div>Hi Dana,</div><div>Quick question&nbsp;&amp; idea</div>") } };
    expect(extractBody(html)).toBe("Hi Dana,\nQuick question & idea");
  });

  it("encodes Hebrew subjects and bodies in a draft", () => {
    const mime = buildMime({ to: "dana@example.com", subject: "שאלה קצרה", body: "היי דנה" });
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("שאלה קצרה").toString("base64")}?=`);
    const body = mime.split("\r\n\r\n")[1]!;
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("היי דנה");
  });

  it("sends the bearer token and pages through search results", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push(url);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
      const page = url.includes("pageToken=p2")
        ? { messages: [{ id: "m3", threadId: "t2" }] }
        : { messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t1" }], nextPageToken: "p2" };
      return new Response(JSON.stringify(page), { status: 200 });
    }) as Fetch;
    const gmail = new GmailClient(async () => "tok", fakeFetch);
    expect((await gmail.search("in:sent")).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(seen).toHaveLength(2);
  });
});

describe("outreach helpers", () => {
  it("tells Hebrew from English", () => {
    expect(detectLanguage("היי דנה, ראיתי שפתחתם סניף חדש")).toBe("he");
    expect(detectLanguage("Hi Dana, I saw you opened a new branch")).toBe("en");
    expect(detectLanguage("היי Dana, saw the news about הסניף החדש")).toBe("mixed");
  });

  it("round-trips review buttons", () => {
    expect(parseExampleCallback(exampleCallback(42, "gold"))).toEqual({ id: 42, button: "gold" });
    expect(parseExampleCallback("ox:1:x")).toBeNull();
  });
});
