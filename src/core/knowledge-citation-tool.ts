import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../tools/infra/tool-render.js";
import { isKnowledgeNavigationPage } from "../knowledge/page-kind.js";
import type { SessionEventEmitter } from "./tool-registry.js";
import {
  MAX_EVIDENCE_SOURCES_PER_MARKER,
  MAX_KNOWLEDGE_CITATIONS,
  type KnowledgeSourceCitation,
} from "../shared/knowledge-citations.js";

export const KNOWLEDGE_CITATION_MANIFEST = ".citation-manifest.json";

interface CitationManifestSource { sourceId?: string; resource: string; title: string; url: string }
interface CitationManifestRepo { id: string; root: string; sources: CitationManifestSource[] }
interface CitationManifest { version: 1; repos: CitationManifestRepo[] }

interface PageSource { sourceId?: string; resource: string }
interface PageEvidence { id: string; sourceIds: string[] }
interface PageProvenance { sources: PageSource[]; evidence: Map<string, PageEvidence> }

const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Canonical grammar: space/tab only. Must stay identical to selfcheck.py and Sicore. */
export const EVIDENCE_MARKER_START = /<!--[ \t]*okf:evidence\b/g;
export const EVIDENCE_MARKER = /<!--[ \t]*okf:evidence[ \t]+(\{[^\r\n]*\})[ \t]*-->/g;

function result(text: string, cited: number, unresolved?: string[]) {
  return {
    content: [{ type: "text" as const, text }],
    details: unresolved ? { cited, unresolved } : { cited },
  };
}

/** Match selfcheck._norm_source_entry: strip raw/ or drop/, keep a leading slash. */
export function normalizedResource(value: string): string {
  let entry = path.posix.normalize(value.trim().replaceAll("\\", "/"));
  for (const prefix of ["raw/", "drop/"] as const) {
    if (entry.startsWith(prefix)) {
      entry = entry.slice(prefix.length);
      break;
    }
  }
  entry = path.posix.normalize(entry);
  return entry === "." ? "" : entry;
}

function maskSpan(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/**
 * Mask fenced blocks and inline code the same way selfcheck._markdown_prose
 * does, so an example marker in a code fence is not evidence.
 */
export function maskMarkdownCode(body: string): string {
  const maskedLines: string[] = [];
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (const line of body.match(/.*(?:\r?\n|$)/g) ?? []) {
    if (!line) continue;
    const raw = line.replace(/\r?\n$/, "");
    if (fenceChar !== null) {
      const close = /^[ ]{0,3}([`~]+)[ \t]*$/.exec(raw);
      maskedLines.push(maskSpan(line));
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    const opened = /^[ ]{0,3}(`{3,}|~{3,})(?:[^\r\n]*)$/.exec(raw);
    if (opened) {
      fenceChar = opened[1][0];
      fenceLen = opened[1].length;
      maskedLines.push(maskSpan(line));
    } else {
      maskedLines.push(line);
    }
  }
  const text = maskedLines.join("");
  const chars = text.split("");
  let pos = 0;
  while (true) {
    const start = text.indexOf("`", pos);
    if (start < 0) break;
    let endRun = start;
    while (endRun < text.length && text[endRun] === "`") endRun += 1;
    const ticks = endRun - start;
    let close = endRun;
    let found = -1;
    while (true) {
      close = text.indexOf("`", close);
      if (close < 0) break;
      let closeEnd = close;
      while (closeEnd < text.length && text[closeEnd] === "`") closeEnd += 1;
      if (closeEnd - close === ticks) {
        found = closeEnd;
        break;
      }
      close = closeEnd;
    }
    if (found < 0) {
      pos = endRun;
      continue;
    }
    for (let i = start; i < found; i += 1) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
    pos = found;
  }
  return chars.join("");
}

function readManifest(knowledgeDir: string): CitationManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(knowledgeDir, KNOWLEDGE_CITATION_MANIFEST), "utf8")) as CitationManifest;
    return parsed?.version === 1 && Array.isArray(parsed.repos) ? parsed : null;
  } catch {
    return null;
  }
}

function sameManifest(left: CitationManifest | null, right: CitationManifest | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Opaque before/after receipt for one Read. Compare by JSON, not identity. */
export type KnowledgeMountReceipt = { readonly json: string };

function mountReceipt(manifest: CitationManifest | null): KnowledgeMountReceipt {
  return { json: JSON.stringify(manifest) };
}

export function pageProvenanceFromBody(body: string): PageProvenance | null {
  try {
    if (!body.startsWith("---\n")) return null;
    const end = body.indexOf("\n---", 4);
    if (end < 0 || end > 64 * 1024) return null;
    const frontmatter = yaml.load(body.slice(4, end)) as Record<string, unknown> | null;
    if (!frontmatter || !Array.isArray(frontmatter.sources)) return null;
    const sources = frontmatter.sources.flatMap((source): PageSource[] => {
      if (!source || typeof source !== "object") return [];
      const row = source as Record<string, unknown>;
      const resource = row.resource;
      if (typeof resource !== "string" || !resource.trim()) return [];
      const sourceId = typeof row.id === "string" && EVIDENCE_ID.test(row.id.trim())
        ? row.id.trim()
        : undefined;
      return [{ sourceId, resource: normalizedResource(resource) }];
    });

    const evidence = new Map<string, PageEvidence>();
    const pageBody = maskMarkdownCode(body.slice(end + 4));
    EVIDENCE_MARKER.lastIndex = 0;
    for (const match of pageBody.matchAll(EVIDENCE_MARKER)) {
      try {
        const parsed = JSON.parse(match[1]) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
          Object.keys(parsed).sort().join(",") !== "id,sources") {
          continue;
        }
        const row = parsed as Record<string, unknown>;
        const id = typeof row.id === "string" ? row.id.trim() : "";
        const sourceIds = Array.isArray(row.sources)
          ? row.sources.map((value) => typeof value === "string" ? value.trim() : "")
          : [];
        if (!EVIDENCE_ID.test(id) || sourceIds.length === 0 || sourceIds.length > MAX_EVIDENCE_SOURCES_PER_MARKER ||
          sourceIds.some((sourceId) => !EVIDENCE_ID.test(sourceId)) ||
          new Set(sourceIds).size !== sourceIds.length || evidence.has(id)) {
          continue;
        }
        evidence.set(id, { id, sourceIds });
      } catch {
        continue;
      }
    }
    return { sources, evidence };
  } catch {
    return null;
  }
}

export function hasKnowledgeCitationManifest(knowledgeDir: string): boolean {
  return readManifest(knowledgeDir)?.repos.some((repo) => repo.sources.length > 0) ?? false;
}

function hasEvidenceCitationManifest(knowledgeDir: string): boolean {
  return readManifest(knowledgeDir)?.repos.some((repo) =>
    repo.sources.some((source) => typeof source.sourceId === "string" && EVIDENCE_ID.test(source.sourceId))) ?? false;
}

/**
 * This text is rebuilt by session.reload(), while custom tools remain attached
 * to the session. Keeping both states explicit lets a newly published manifest
 * enable citations on a warm session without inviting calls before it exists.
 */
export function buildKnowledgeCitationSystemPrompt(knowledgeDir: string): string {
  if (!hasKnowledgeCitationManifest(knowledgeDir)) {
    return `
## Knowledge source citations

Trusted original-source metadata is not available for this knowledge mount. Do not call \`knowledge_cite\`; answer normally without a references section. This instruction may change after a knowledge reload.`;
  }
  if (hasEvidenceCitationManifest(knowledgeDir)) {
    return `
## Knowledge source citations

When your final answer materially relies on mounted knowledge, call \`knowledge_cite\` once after research and immediately before the final answer. Prefer \`evidence_refs\` for sections that contain an \`okf:evidence\` marker: pass only refs you successfully Read and actually used, in \`page.md#evidence-id\` form. If the answer also uses unmarked pages, pass those as \`pages\` in the same call. Never cite an index, catalog, or other navigation page. The runtime resolves each evidence ref to its exact frozen original and fails closed if any evidence ref is unresolved — retry once with only the remaining valid refs; do not ship the answer after a failed cite. Never invent or manually copy source URLs.`;
  }
  return `
## Knowledge source citations

When your final answer materially relies on mounted knowledge, call \`knowledge_cite\` once after research and immediately before the final answer. Pass only the 1-${MAX_KNOWLEDGE_CITATIONS} knowledge pages you successfully Read this turn and actually used. Do not register an index, catalog, or a page you merely inspected. The runtime appends validated original links automatically; never invent or manually copy source URLs. If no trusted clickable source exists, answer normally without a references section.`;
}

function findCitationRepo(manifest: CitationManifest, rel: string): CitationManifestRepo | undefined {
  let best: CitationManifestRepo | undefined;
  let bestRootLength = -1;
  for (const candidate of manifest.repos) {
    const root = candidate.root.replace(/\/$/, "");
    if ((root === "" || rel === root || rel.startsWith(root + "/")) && root.length > bestRootLength) {
      best = candidate;
      bestRootLength = root.length;
    }
  }
  return best;
}

export function createKnowledgeCitationSupport(opts: {
  knowledgeDir: string;
  turnRef: { current: number };
  sessionEventEmitter: SessionEventEmitter;
}): {
  captureMount: () => KnowledgeMountReceipt;
  noteRead: (pagePath: string, content: string, start: KnowledgeMountReceipt) => void;
  tool: ToolDefinition;
} {
  let turn = -1;
  const readPages = new Map<string, string>();
  let pinnedManifest: CitationManifest | null | undefined;
  const resetForTurn = () => {
    if (turn !== opts.turnRef.current) {
      turn = opts.turnRef.current;
      readPages.clear();
      pinnedManifest = undefined;
    }
  };
  const pinManifest = () => {
    if (pinnedManifest !== undefined) return;
    pinnedManifest = readManifest(opts.knowledgeDir);
  };
  const captureMount = (): KnowledgeMountReceipt => mountReceipt(readManifest(opts.knowledgeDir));
  const noteRead = (pagePath: string, content: string, start: KnowledgeMountReceipt) => {
    resetForTurn();
    const absolute = path.resolve(pagePath);
    const root = path.resolve(opts.knowledgeDir);
    if (!absolute.endsWith(".md") || !(absolute === root || absolute.startsWith(root + path.sep))) {
      return;
    }
    const current = readManifest(opts.knowledgeDir);
    if (start.json !== mountReceipt(current).json) {
      // Remount landed between the pre-Read receipt and this check.
      // The model already saw the new page bytes; drop earlier snapshots so
      // cite cannot emit the old mount for a path the model just re-read.
      readPages.clear();
      pinnedManifest = undefined;
      return;
    }
    if (pinnedManifest !== undefined && !sameManifest(pinnedManifest, current)) {
      // A later consistent Read saw the new mount. Drop earlier snapshots so
      // the model can re-read and cite in this same turn.
      readPages.clear();
      pinnedManifest = current;
    } else if (pinnedManifest === undefined) {
      pinnedManifest = current;
    }
    readPages.set(absolute, content);
  };

  const tool: ToolDefinition = {
    name: "knowledge_cite",
    label: "Cite Knowledge Sources",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("knowledge_cite")), 0, 0),
    renderResult: renderTextResult,
    description:
      "Use only when the current system prompt says knowledge source citations are available. " +
      "Register the exact evidence refs that materially support your final answer, and unmarked pages if needed. " +
      "Call once, immediately before the final answer. If the tool reports unresolved refs, retry once with only the remaining valid refs. " +
      "The runtime validates frozen original-source metadata and appends trusted links; never invent or copy source URLs yourself.",
    parameters: Type.Object({
      evidence_refs: Type.Optional(Type.Array(Type.String({ minLength: 3 }), {
        minItems: 1,
        maxItems: MAX_KNOWLEDGE_CITATIONS,
        description: `Evidence refs from read knowledge sections, in page.md#evidence-id form (1-${MAX_KNOWLEDGE_CITATIONS}).`,
      })),
      pages: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: MAX_KNOWLEDGE_CITATIONS,
        description: `Unmarked knowledge pages actually used (1-${MAX_KNOWLEDGE_CITATIONS}). May be combined with evidence_refs.`,
      })),
    }),
    async execute(_toolCallId, rawParams) {
      resetForTurn();
      pinManifest();
      const manifest = pinnedManifest ?? null;
      if (!manifest) return result("No trusted original-source metadata is available for this knowledge mount.", 0);
      const params = rawParams as { evidence_refs?: unknown; pages?: unknown };
      const refs = Array.isArray(params.evidence_refs) ? params.evidence_refs.map(String) : [];
      const pageArgs = Array.isArray(params.pages) ? params.pages.map(String) : [];
      if (refs.length === 0 && pageArgs.length === 0) {
        return result("knowledge_cite requires evidence_refs and/or pages.", 0);
      }

      const citations: KnowledgeSourceCitation[] = [];
      const seenURLs = new Set<string>();
      const unresolved: string[] = [];
      const navigationRefs: string[] = [];

      for (const ref of refs) {
        const hash = ref.lastIndexOf("#");
        const pageValue = hash > 0 ? ref.slice(0, hash) : "";
        const evidenceId = hash > 0 ? ref.slice(hash + 1) : "";
        const page = pageValue
          ? path.resolve(path.isAbsolute(pageValue) ? pageValue : path.join(opts.knowledgeDir, pageValue))
          : "";
        const root = path.resolve(opts.knowledgeDir);
        const snapshot = page ? readPages.get(page) : undefined;
        if (!page || !snapshot || !EVIDENCE_ID.test(evidenceId) || !page.endsWith(".md") ||
          !(page === root || page.startsWith(root + path.sep))) {
          unresolved.push(ref);
          continue;
        }
        const rel = path.relative(opts.knowledgeDir, page).replaceAll(path.sep, "/");
        if (isKnowledgeNavigationPage(rel, snapshot)) {
          navigationRefs.push(ref);
          continue;
        }
        const repo = findCitationRepo(manifest, rel);
        const provenance = pageProvenanceFromBody(snapshot);
        const evidence = provenance?.evidence.get(evidenceId);
        if (!repo || !provenance || !evidence) {
          unresolved.push(ref);
          continue;
        }
        const pageSourceById = new Map(
          provenance.sources.filter((source) => source.sourceId).map((source) => [source.sourceId!, source]),
        );
        const manifestSourceById = new Map(
          repo.sources.filter((source) => source.sourceId).map((source) => [source.sourceId!, source]),
        );
        let refResolved = true;
        const refCitations: KnowledgeSourceCitation[] = [];
        const refSeen = new Set<string>();
        for (const sourceId of evidence.sourceIds) {
          const pageSource = pageSourceById.get(sourceId);
          const source = manifestSourceById.get(sourceId);
          if (!pageSource || !source || normalizedResource(source.resource) !== pageSource.resource) {
            refResolved = false;
            break;
          }
          if (seenURLs.has(source.url) || refSeen.has(source.url)) continue;
          refSeen.add(source.url);
          refCitations.push({
            title: source.title,
            url: source.url,
            resource: source.resource,
            sourceId,
            page: rel,
            evidence: evidenceId,
          });
        }
        if (!refResolved) {
          unresolved.push(ref);
          continue;
        }
        for (const citation of refCitations) {
          seenURLs.add(citation.url);
          citations.push(citation);
        }
      }
      if (navigationRefs.length > 0) {
        return result(
          `Cannot cite navigation pages: ${navigationRefs.join(", ")}. Read and cite the leaf content page that materially supports the answer.`,
          0,
          navigationRefs,
        );
      }
      if (unresolved.length > 0 || citations.length > MAX_KNOWLEDGE_CITATIONS) {
        const failed = unresolved.length > 0 ? unresolved : refs;
        return result(
          unresolved.length > 0
            ? `Unresolved evidence refs: ${unresolved.join(", ")}. No citations were registered. Retry knowledge_cite once with only the remaining valid refs (and any unmarked pages).`
            : `Evidence resolves to more than ${MAX_KNOWLEDGE_CITATIONS} original sources; split the answer instead of truncating citations.`,
          0,
          failed,
        );
      }

      if (pageArgs.length > 0) {
        const selected = pageArgs.map((raw) => {
          const value = String(raw);
          return path.resolve(path.isAbsolute(value) ? value : path.join(opts.knowledgeDir, value));
        });
        const unread = selected.find((page) => !readPages.has(page));
        if (unread) return result(`Cannot cite unread knowledge page: ${unread}`, 0);
        const navigationPage = selected.find((page) => {
          const snapshot = readPages.get(page);
          const rel = path.relative(opts.knowledgeDir, page).replaceAll(path.sep, "/");
          return snapshot !== undefined && isKnowledgeNavigationPage(rel, snapshot);
        });
        if (navigationPage) {
          const rel = path.relative(opts.knowledgeDir, navigationPage).replaceAll(path.sep, "/");
          return result(
            `Cannot cite navigation page: ${rel}. Read and cite the leaf content page that materially supports the answer.`,
            0,
            [rel],
          );
        }
        for (const page of selected) {
          const snapshot = readPages.get(page);
          if (!snapshot) return result(`Cannot cite unread knowledge page: ${page}`, 0);
          const rel = path.relative(opts.knowledgeDir, page).replaceAll(path.sep, "/");
          const provenance = pageProvenanceFromBody(snapshot);
          if ((provenance?.evidence.size ?? 0) > 0) {
            return result(
              `Cannot cite ${rel} via pages; it has evidence markers. Use evidence_refs.`,
              0,
            );
          }
          const repo = findCitationRepo(manifest, rel);
          if (!repo) continue;
          const sourceByResource = new Map(repo.sources.map((source) => [normalizedResource(source.resource), source]));
          for (const resource of provenance?.sources.map((source) => source.resource) ?? []) {
            const source = sourceByResource.get(resource);
            if (!source || seenURLs.has(source.url)) continue;
            seenURLs.add(source.url);
            citations.push({ title: source.title, url: source.url, resource: source.resource, page: rel });
          }
        }
      }

      if (citations.length > MAX_KNOWLEDGE_CITATIONS) {
        return result(
          `Evidence resolves to more than ${MAX_KNOWLEDGE_CITATIONS} original sources; split the answer instead of truncating citations.`,
          0,
          refs.length > 0 ? refs : undefined,
        );
      }
      if (citations.length > 0) {
        opts.sessionEventEmitter({ type: "knowledge_sources", sources: citations });
      }
      return result(
        citations.length > 0
          ? `Registered ${citations.length} ${refs.length > 0 ? "exact " : ""}trusted original source${citations.length === 1 ? "" : "s"}; links will be appended automatically.`
          : refs.length > 0
            ? "The evidence refs resolved but have no unique original-source links."
            : "The selected pages have no trusted clickable original sources; answer normally without a references section.",
        citations.length,
        refs.length > 0 ? [] : undefined,
      );
    },
  };
  return { captureMount, noteRead, tool };
}
