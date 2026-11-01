import { z } from "zod";
import type { ModelBackend, ModelTier } from "../models/types.ts";
import type { Lead } from "../notion/client.ts";
import type { OutreachExample } from "./examples.ts";

/** What the writer returns for one email. */
export const draftSchema = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body", "angle"],
  properties: {
    subject: { type: "string", description: "The subject line." },
    body: {
      type: "string",
      description: "The full email body, greeting to signature, as plain text with line breaks. Ready to send.",
    },
    angle: {
      type: "string",
      description: "One sentence for Omry, in English: which detail about the lead you built the email on, and why.",
    },
  },
} as const;

const draftOutput = z.object({ subject: z.string().min(1), body: z.string().min(1), angle: z.string() });
export type DraftContent = z.infer<typeof draftOutput>;

export interface WriterInput {
  styleGuide: string;
  signature: string;
  rules: string[];
  examples: OutreachExample[];
  lead: Lead;
  notes: string;
  websiteText: string;
  /** For a revision: the draft being reworked and Omry's comment on it. */
  previous?: { subject: string; body: string; feedback: string };
}

export const WRITER_TIER: ModelTier = "deep";

export function writerSystemPrompt(input: WriterInput): string {
  const parts = [
    "You are the Outreach Writer for Flowtika. You write first-touch cold emails exactly the way Omry writes " +
      "them, so he can send them under his name. Flowtika helps businesses turn more inquiries into revenue by " +
      "fixing what happens after a lead comes in: slow responses, missed follow-ups, no CRM, unclear sales data.",
    "Write in the language Omry would use for this lead (Hebrew unless the lead is clearly English-speaking). " +
      "The goal is a meeting, not just a reply. Use only facts from the lead's notes and website; never invent " +
      "numbers, clients or results. Get the recipient's first name and company name exactly right. If you don't " +
      "know the first name, use a greeting that doesn't need one.",
    `End the body with Omry's sign-off and this signature, unchanged:\n${input.signature}`,
    `# Omry's cold email style guide\n\n${input.styleGuide || "(No style guide yet. Follow the examples closely.)"}`,
  ];
  if (input.rules.length) {
    parts.push(`# Rules Omry set from earlier feedback. These override the style guide.\n\n${input.rules.map((r) => `- ${r}`).join("\n")}`);
  }
  if (input.examples.length) {
    const shown = input.examples.map(
      (e, i) =>
        `## Example ${i + 1}${e.gold ? " (one of his best)" : ""}${e.replied ? " (got a reply)" : ""}\n` +
        `Subject: ${e.subject}\n\n${e.body.slice(0, 3000)}`,
    );
    parts.push(`# Real emails Omry sent\n\n${shown.join("\n\n")}`);
  }
  return parts.join("\n\n");
}

export function writerUserMessage(input: WriterInput): string {
  const { lead } = input;
  const facts = [
    `Lead: ${lead.name}`,
    `Email: ${lead.email ?? "(none on file)"}`,
    `Website: ${lead.website ?? "(none)"}`,
    `Tags: ${lead.tags.join(", ") || "(none)"}`,
    `Status in Notion: ${lead.status ?? "(none)"}`,
  ].join("\n");
  const parts = [
    facts,
    `# Omry's notes on this lead (from Notion)\n\n${input.notes || "(no notes)"}`,
    `# Text from the lead's website\n\n${input.websiteText || "(not available)"}`,
  ];
  if (input.previous) {
    parts.push(
      `# Your previous draft\n\nSubject: ${input.previous.subject}\n\n${input.previous.body}`,
      `# Omry's comment on it\n\n${input.previous.feedback}\n\nRewrite the email to address the comment. Keep what he didn't ask to change.`,
    );
  } else {
    parts.push("Write the first cold email to this lead.");
  }
  return parts.join("\n\n");
}

export async function writeDraft(backend: ModelBackend, input: WriterInput): Promise<DraftContent> {
  const result = await backend.complete({
    system: writerSystemPrompt(input),
    messages: [{ role: "user", content: writerUserMessage(input) }],
    tier: WRITER_TIER,
    jsonSchema: draftSchema,
  });
  const parsed = draftOutput.safeParse(result.structured);
  if (!parsed.success) throw new Error("The writer didn't return a draft in the expected format.");
  return parsed.data;
}
