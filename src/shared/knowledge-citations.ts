export interface KnowledgeSourceCitation {
  title: string;
  url: string;
  resource?: string;
  sourceId?: string;
  page?: string;
  evidence?: string;
  /** Knowledge repo UUID the cited page belongs to (attribution, not rendering). */
  repoId?: string;
  /** The answer statement the model bound to this page (pages path only). */
  claim?: string;
}

/**
 * Per-message attribution record persisted in chat-message metadata under
 * `knowledge_citations`. It exists so a reader's feedback on an answer can be
 * traced back to the knowledge repo(s) and pages that answer cited — the
 * runtime's self-report, a prefill a human confirms, never authority.
 */
export interface KnowledgeCitationsMetadata {
  repo_ids: string[];
  pages: Array<{ repo_id?: string; page?: string; url: string; source_id?: string; evidence?: string; claim?: string }>;
}

export function knowledgeCitationsMetadata(citations: KnowledgeSourceCitation[]): KnowledgeCitationsMetadata {
  const repoIds: string[] = [];
  const pages: KnowledgeCitationsMetadata["pages"] = [];
  for (const c of citations.slice(0, MAX_KNOWLEDGE_CITATIONS)) {
    if (c.repoId && !repoIds.includes(c.repoId)) repoIds.push(c.repoId);
    pages.push({
      ...(c.repoId ? { repo_id: c.repoId } : {}),
      ...(c.page ? { page: c.page } : {}),
      url: c.url,
      ...(c.sourceId ? { source_id: c.sourceId } : {}),
      ...(c.evidence ? { evidence: c.evidence } : {}),
      ...(c.claim ? { claim: c.claim } : {}),
    });
  }
  return { repo_ids: repoIds, pages };
}

// Shared ceiling for one knowledge_cite result, the tool's evidence_refs /
// pages maxItems, and the rendered references list (including Feishu cards).
// The raise from 3 to 8 is intentional for both evidence and legacy paths:
// a multi-source answer must not lose the fourth original after the runtime
// already validated it. This is not the per-marker source cap — that is
// MAX_EVIDENCE_SOURCES_PER_MARKER, mirrored by Python `_MAX_EVIDENCE_SOURCES`.
export const MAX_KNOWLEDGE_CITATIONS = 8;

/** Max `sources` inside one `okf:evidence` marker. Keep equal to selfcheck.py. */
export const MAX_EVIDENCE_SOURCES_PER_MARKER = 8;

// knowledge_cite `pages[].claim` length bounds, in Unicode CODE POINTS. pi does
// not validate the TypeBox schema, so the runtime is the real enforcer
// (`codePointLength`); the schema advertises the same two numbers. One source
// for both so the advertised and enforced limits cannot drift.
export const CLAIM_MIN_LENGTH = 4;
export const CLAIM_MAX_LENGTH = 300;

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
      sourceId: typeof row.sourceId === "string" ? row.sourceId : undefined,
      page: typeof row.page === "string" ? row.page : undefined,
      evidence: typeof row.evidence === "string" ? row.evidence : undefined,
      repoId: typeof row.repoId === "string" && row.repoId.trim() ? row.repoId.trim().slice(0, 64) : undefined,
      claim: typeof row.claim === "string" && row.claim.trim()
        ? Array.from(row.claim.trim()).slice(0, CLAIM_MAX_LENGTH).join("")
        : undefined,
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
