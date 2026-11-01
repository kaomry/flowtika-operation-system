import type { Fetch } from "../google/oauth.ts";
import { emphasisRuns } from "../outreach/emphasis.ts";

const API = "https://api.notion.com/v1";
// 2025-09-03 queries data sources; the Leads database has more than one, so the old
// database query endpoint is ambiguous for it.
const VERSION = "2025-09-03";

export interface Lead {
  pageId: string;
  name: string;
  email: string | null;
  website: string | null;
  tags: string[];
  status: string | null;
  url: string;
}

interface RichText {
  plain_text: string;
}

type Property =
  | { type: "title"; title: RichText[] }
  | { type: "rich_text"; rich_text: RichText[] }
  | { type: "email"; email: string | null }
  | { type: "url"; url: string | null }
  | { type: "select"; select: { name: string } | null }
  | { type: "multi_select"; multi_select: { name: string }[] }
  | { type: string };

interface Page {
  id: string;
  url: string;
  properties: Record<string, Property>;
}

interface Block {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: unknown;
}

/** Property names in the Leads database, kept in one place in case they're renamed. */
export const LEAD_PROPS = {
  name: "Name",
  email: "Email",
  website: "Website",
  tags: "Tags",
  status: "lead status",
} as const;

/** A thin client over the Notion REST API: reading leads and their notes, and writing back. */
export class NotionClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchFn(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "notion-version": VERSION,
        "content-type": "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Notion ${init.method ?? "GET"} ${path.split("?")[0]} failed with HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** Leads in a data source, optionally only those with one of the given statuses. */
  async queryLeads(dataSourceId: string, statuses?: string[]): Promise<Lead[]> {
    const filter = statuses?.length
      ? { or: statuses.map((s) => ({ property: LEAD_PROPS.status, select: { equals: s } })) }
      : undefined;
    const leads: Lead[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call<{ results: Page[]; has_more: boolean; next_cursor: string | null }>(
        `/data_sources/${dataSourceId}/query`,
        { method: "POST", body: JSON.stringify({ filter, page_size: 100, start_cursor: cursor }) },
      );
      leads.push(...page.results.map(toLead));
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return leads;
  }

  async getLead(pageId: string): Promise<Lead> {
    return toLead(await this.call<Page>(`/pages/${pageId}`));
  }

  /** The page's notes as plain text, toggles and nested lists included, up to `maxChars`. */
  async pageText(pageId: string, maxChars = 12000): Promise<string> {
    const lines: string[] = [];
    let size = 0;
    const walk = async (blockId: string, depth: number): Promise<void> => {
      let cursor: string | undefined;
      do {
        const params = new URLSearchParams({ page_size: "100" });
        if (cursor) params.set("start_cursor", cursor);
        const page = await this.call<{ results: Block[]; has_more: boolean; next_cursor: string | null }>(
          `/blocks/${blockId}/children?${params}`,
        );
        for (const block of page.results) {
          if (size > maxChars) return;
          const text = blockText(block);
          if (text) {
            lines.push(`${"  ".repeat(depth)}${text}`);
            size += text.length;
          }
          if (block.has_children && depth < 3 && block.type !== "child_page") await walk(block.id, depth + 1);
        }
        cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
      } while (cursor);
    };
    await walk(pageId, 0);
    return lines.join("\n").slice(0, maxChars);
  }

  async setStatus(pageId: string, status: string): Promise<void> {
    await this.call(`/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: { [LEAD_PROPS.status]: { select: { name: status } } } }),
    });
  }

  /** Appends a heading and the text below it to the end of a page. *Asterisked* phrases become bold. */
  async appendSection(pageId: string, heading: string, text: string): Promise<void> {
    const paragraphs = text.split("\n").map((line) => ({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: emphasisRuns(line).flatMap((run) =>
          chunks(run.text).map((content) => ({
            type: "text",
            text: { content },
            ...(run.bold ? { annotations: { bold: true } } : {}),
          })),
        ),
      },
    }));
    const children = [
      { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: heading } }] } },
      ...paragraphs,
    ];
    // Notion takes at most 100 blocks per request.
    for (let i = 0; i < children.length; i += 100) {
      await this.call(`/blocks/${pageId}/children`, {
        method: "PATCH",
        body: JSON.stringify({ children: children.slice(i, i + 100) }),
      });
    }
  }
}

/** Notion rejects rich-text pieces over 2000 characters. */
function chunks(text: string, size = 2000): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const plain = (rich: RichText[] | undefined) => (rich ?? []).map((r) => r.plain_text).join("");

export function propertyText(prop: Property | undefined): string | null {
  if (!prop) return null;
  switch (prop.type) {
    case "title":
      return plain((prop as { title: RichText[] }).title) || null;
    case "rich_text":
      return plain((prop as { rich_text: RichText[] }).rich_text) || null;
    case "email":
      return (prop as { email: string | null }).email || null;
    case "url":
      return (prop as { url: string | null }).url || null;
    case "select":
      return (prop as { select: { name: string } | null }).select?.name ?? null;
    default:
      return null;
  }
}

export function toLead(page: Page): Lead {
  const tags = page.properties[LEAD_PROPS.tags];
  return {
    pageId: page.id,
    name: propertyText(page.properties[LEAD_PROPS.name]) ?? "(untitled)",
    email: propertyText(page.properties[LEAD_PROPS.email])?.trim().toLowerCase() ?? null,
    website: propertyText(page.properties[LEAD_PROPS.website]),
    tags: tags?.type === "multi_select" ? (tags as { multi_select: { name: string }[] }).multi_select.map((t) => t.name) : [],
    status: propertyText(page.properties[LEAD_PROPS.status]),
    url: page.url,
  };
}

export function blockText(block: Block): string {
  const body = block[block.type] as { rich_text?: RichText[]; cells?: RichText[][]; title?: string } | undefined;
  if (!body) return "";
  if (block.type === "table_row") return (body.cells ?? []).map(plain).join(" | ");
  if (block.type === "child_page") return `[page] ${body.title ?? ""}`;
  const text = plain(body.rich_text);
  if (!text) return "";
  if (block.type.startsWith("heading_")) return `# ${text}`;
  if (block.type === "bulleted_list_item" || block.type === "to_do") return `- ${text}`;
  if (block.type === "numbered_list_item") return `1. ${text}`;
  return text;
}
