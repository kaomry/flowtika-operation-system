/**
 * The writer marks bold phrases with *asterisks*, the way Omry bolds 1–3 phrases per email.
 * These helpers turn that into plain text, HTML, or Notion rich-text runs.
 */

export interface Run {
  text: string;
  bold: boolean;
}

/** Splits a line into plain and bold runs. A lone asterisk with no closing pair stays as text. */
export function emphasisRuns(line: string): Run[] {
  const runs: Run[] = [];
  const re = /\*([^*\n]+)\*/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) runs.push({ text: line.slice(last, m.index), bold: false });
    runs.push({ text: m[1]!, bold: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) runs.push({ text: line.slice(last), bold: false });
  return runs;
}

export const stripEmphasis = (text: string) =>
  text.split("\n").map((line) => emphasisRuns(line).map((r) => r.text).join("")).join("\n");

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The email as simple HTML: bold phrases in <b>, line breaks kept, right-to-left for Hebrew.
 * `signatureHtml` (the owner's Gmail signature, with its logo) is appended below the text.
 */
export function emphasisToHtml(text: string, signatureHtml = ""): string {
  const rtl = /[\u0590-\u05FF]/.test(text);
  const lines = text
    .split("\n")
    .map((line) => emphasisRuns(line).map((r) => (r.bold ? `<b>${escapeHtml(r.text)}</b>` : escapeHtml(r.text))).join(""));
  const style = rtl ? ' style="direction:rtl;text-align:right"' : "";
  const signature = signatureHtml ? `<br><div class="gmail_signature">${signatureHtml}</div>` : "";
  return `<div dir="${rtl ? "rtl" : "ltr"}"${style}>${lines.join("<br>")}${signature}</div>`;
}

/** The body without a trailing signature block, when it ends with that signature. */
export function withoutSignature(body: string, signature: string): string {
  const sig = signature.trim();
  if (!sig) return body;
  const trimmed = body.trimEnd();
  return trimmed.endsWith(sig) ? trimmed.slice(0, -sig.length).trimEnd() : body;
}
