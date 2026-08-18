export interface KnowledgeSourceCitation {
  title: string;
  url: string;
  resource?: string;
  page?: string;
}

export const MAX_KNOWLEDGE_CITATIONS = 3;

export function normalizeKnowledgeSourceCitations(value: unknown): KnowledgeSourceCitation[] {
  if (!Array.isArray(value)) return [];
  const out: KnowledgeSourceCitation[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    if (parsed.protocol !== "https:" || seen.has(parsed.href)) continue;
    const titleRaw = typeof row.title === "string" ? row.title : "";
    const title = titleRaw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || "原文";
    seen.add(parsed.href);
    out.push({
      title,
      url: parsed.href,
      resource: typeof row.resource === "string" ? row.resource : undefined,
      page: typeof row.page === "string" ? row.page : undefined,
    });
    if (out.length >= MAX_KNOWLEDGE_CITATIONS) break;
  }
  return out;
}

export function appendKnowledgeSourceCitations(text: string, value: unknown): string {
  if (!text.trim()) return text;
  const citations = normalizeKnowledgeSourceCitations(value);
  if (citations.length === 0) return text;
  const heading = /[\u3400-\u9fff]/u.test(text) ? "参考原文" : "Original sources";
  // WHATWG URL accepts literal parentheses in an https path. Left raw, `)`
  // closes a Markdown destination early and the remaining path can be parsed as
  // attacker-controlled document text. Percent-encoding preserves the URL while
  // keeping the destination inside the one link we render.
  const lines = citations.map((source) => {
    const destination = source.url.replaceAll("(", "%28").replaceAll(")", "%29");
    return `- [${source.title.replace(/[\[\]]/g, "")}](${destination})`;
  });
  return `${text.trimEnd()}\n\n### ${heading}\n\n${lines.join("\n")}`;
}
