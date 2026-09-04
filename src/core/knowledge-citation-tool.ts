import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../tools/infra/tool-render.js";
import { isKnowledgeNavigationPage } from "../knowledge/page-kind.js";
import type { SessionEventEmitter } from "./tool-registry.js";
import { codePointLength } from "./subagent-models.js";
import {
  CLAIM_MAX_LENGTH,
  CLAIM_MIN_LENGTH,
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
/**
 * Resolve a page path the model passed to knowledge_cite against the pages it
 * actually read this turn. Models copy paths from their own read calls, which
 * may carry the mount prefix (".siclaw/knowledge/repos/…", "./repos/…") or be
 * absolute; a literal join against knowledgeDir then misses and the cite fails
 * for a page that was demonstrably read. Strip leading segments until the path
 * lands on a read page; never resolve to anything that was not read.
 */
export function resolveCitedPagePath(value: string, knowledgeDir: string, wasRead: (absolute: string) => boolean): string {
  const trimmed = value.trim().replaceAll("\\", "/");
  const literal = path.resolve(path.isAbsolute(trimmed) ? trimmed : path.join(knowledgeDir, trimmed));
  if (wasRead(literal) || path.isAbsolute(trimmed)) return literal;
  const segments = path.posix.normalize(trimmed).split("/").filter((segment) => segment !== "" && segment !== ".");
  for (let i = 1; i < segments.length; i++) {
    const candidate = path.resolve(path.join(knowledgeDir, segments.slice(i).join("/")));
    if (wasRead(candidate)) return candidate;
  }
  return literal;
}

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

When your final answer materially relies on mounted knowledge, call \`knowledge_cite\` once after research and immediately before the final answer. Prefer \`evidence_refs\` for sections that contain an \`okf:evidence\` marker: pass only refs you successfully Read and actually used, in \`page.md#evidence-id\` form. If the answer also uses unmarked pages, pass each as \`{path, claim}\` in \`pages\` in the same call, where claim is the one statement in your answer that page supports. Cite the minimal set — a page you read but did not use is a citation error, and a page you cannot bind to a concrete claim is a read, not a citation. Never cite an index, catalog, or other navigation page. The runtime resolves each evidence ref to its exact frozen original and fails closed if any evidence ref is unresolved — retry once with only the remaining valid refs; do not ship the answer after a failed cite. Never invent or manually copy source URLs.`;
  }
  return `
## Knowledge source citations

When your final answer materially relies on mounted knowledge, call \`knowledge_cite\` once after research and immediately before the final answer. Pass only the 1-${MAX_KNOWLEDGE_CITATIONS} knowledge pages you successfully Read this turn and actually used, each as \`{path, claim}\` where claim is the one statement in your answer that page supports. Cite the minimal set: do not register an index, catalog, or a page you merely inspected — a page you cannot bind to a concrete claim is a read, not a citation. The runtime appends validated original links automatically; never invent or manually copy source URLs. If no trusted clickable source exists, answer normally without a references section.`;
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
  // Union of every SUCCESSFUL call's citations this turn. Both gateway
  // consumers ASSIGN the knowledge_sources event (`pendingKnowledgeSources =
  // ev.sources`), so a second call would otherwise overwrite the first call's
  // references; emitting the deduped, capped union keeps assignment semantics
  // correct without touching the gateway image.
  let registeredThisTurn: KnowledgeSourceCitation[] = [];
  const resetForTurn = () => {
    if (turn !== opts.turnRef.current) {
      turn = opts.turnRef.current;
      readPages.clear();
      pinnedManifest = undefined;
      registeredThisTurn = [];
    }
  };
  // A mid-turn remount invalidates the union — the old mount's manifest no
  // longer vouches for those originals. Both gateway consumers ASSIGN the
  // knowledge_sources event, so dropping our copy is not enough: without a
  // fresh emit they keep rendering the stale mount's links even after the next
  // cite fails or registers nothing. Emit an empty set so they clear too; a
  // later successful cite re-emits the new mount's union. A no-op when the
  // union was already empty, so it never emits on the turn-boundary reset.
  const clearRegisteredUnion = () => {
    if (registeredThisTurn.length === 0) return;
    registeredThisTurn = [];
    opts.sessionEventEmitter({ type: "knowledge_sources", sources: [] });
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
      // The registered union goes with them: the old mount's manifest no
      // longer vouches for those originals, and a stale union would also
      // hold the cap hostage against everything the new mount cites.
      readPages.clear();
      pinnedManifest = undefined;
      clearRegisteredUnion();
      return;
    }
    if (pinnedManifest !== undefined && !sameManifest(pinnedManifest, current)) {
      // A later consistent Read saw the new mount. Drop earlier snapshots so
      // the model can re-read and cite in this same turn — the union too,
      // same reasoning as above.
      readPages.clear();
      pinnedManifest = current;
      clearRegisteredUnion();
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
      "Register the exact evidence refs that materially support your final answer, and unmarked pages if needed — " +
      "each page bound to the specific claim it supports. Cite the minimal set: a page you read but did not use " +
      "is a citation error, not thoroughness. " +
      "Call once, immediately before the final answer. If the tool reports unresolved refs, retry once with only the remaining valid refs. " +
      "The runtime validates frozen original-source metadata and appends trusted links; never invent or copy source URLs yourself. " +
      `At most ${MAX_KNOWLEDGE_CITATIONS} unique original sources are registered per answer — evidence refs first, then pages, each in its given order; any overflow is named in the result, never silently dropped, and further calls cannot raise the ceiling.`,
    parameters: Type.Object({
      evidence_refs: Type.Optional(Type.Array(Type.String({ minLength: 3 }), {
        minItems: 1,
        maxItems: MAX_KNOWLEDGE_CITATIONS,
        description: `Evidence refs from read knowledge sections, in page.md#evidence-id form (1-${MAX_KNOWLEDGE_CITATIONS}).`,
      })),
      pages: Type.Optional(Type.Array(Type.Object({
        path: Type.String({ minLength: 1, description: "Knowledge page path actually used." }),
        claim: Type.String({
          minLength: CLAIM_MIN_LENGTH,
          maxLength: CLAIM_MAX_LENGTH,
          description: "The specific statement in your final answer that this page supports.",
        }),
      }), {
        minItems: 1,
        maxItems: MAX_KNOWLEDGE_CITATIONS,
        description: `Unmarked knowledge pages actually used (1-${MAX_KNOWLEDGE_CITATIONS}), each bound to the claim it supports. May be combined with evidence_refs.`,
      })),
    }),
    async execute(_toolCallId, rawParams) {
      resetForTurn();
      pinManifest();
      const manifest = pinnedManifest ?? null;
      if (!manifest) return result("No trusted original-source metadata is available for this knowledge mount.", 0);
      const params = rawParams as { evidence_refs?: unknown; pages?: unknown };
      // pi does not validate tool params against the TypeBox schema, so shape
      // errors land here. Silently coercing a non-array to [] is the worst
      // answer: the call reports success while the misshapen half is dropped,
      // and the model ships the answer believing those pages are cited. `null`
      // is the exception — for an optional field it means ABSENT, not
      // malformed, so `{evidence_refs:[...], pages:null}` must keep the refs
      // rather than fail the whole call (a failed cite blocks the answer).
      if (params.evidence_refs != null && !Array.isArray(params.evidence_refs)) {
        return result(
          "evidence_refs must be an ARRAY of page.md#evidence-id strings. No citations were registered. Retry knowledge_cite once with the corrected shape.",
          0,
        );
      }
      const rawRefs = Array.isArray(params.evidence_refs) ? params.evidence_refs : [];
      // Diagnose non-string ref elements instead of String()-ifying them: an
      // object slips through as "[object Object]" and is reported as an
      // unresolved ref, sending the retry at the wrong problem (the same
      // misdiagnosis the per-field pages branch below exists to avoid).
      const malformedRefs = rawRefs.filter((ref) => typeof ref !== "string");
      if (malformedRefs.length > 0) {
        return result(
          `evidence_refs must be page.md#evidence-id STRINGS. Non-string entries: ${malformedRefs.map((ref) => JSON.stringify(ref).slice(0, 80)).join(", ")}. No citations were registered. Retry knowledge_cite once with string refs (keeping any pages).`,
          0,
        );
      }
      const refs = rawRefs as string[];
      // A whole-page citation is the coarse instrument (evidence refs are
      // already claim-scoped by their marker), and provenance validation alone
      // makes padding free — every read-but-unused page validates identically
      // to a load-bearing one. The one cited-vs-read distinction the runtime
      // can demand is that the caller states WHAT the page contributed: a page
      // the model cannot bind to a concrete claim is a read, not a citation.
      // The schema's 4-300 char claim bounds are enforced HERE for the same
      // no-schema-validation reason: a 1-character claim would let padding
      // back in, and an unbounded one lands unvalidated in durable storage.
      if (params.pages != null && !Array.isArray(params.pages)) {
        return result(
          "pages must be an ARRAY of { path, claim } objects. No citations were registered. Retry knowledge_cite once with the corrected shape.",
          0,
        );
      }
      const rawPages = Array.isArray(params.pages) ? params.pages : [];
      const pageArgs: Array<{ path: string; claim: string }> = [];
      const invalidPages: string[] = [];
      for (const item of rawPages) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const row = item as Record<string, unknown>;
          const pagePath = typeof row.path === "string" ? row.path.trim() : "";
          const claim = typeof row.claim === "string" ? row.claim.trim() : "";
          // Diagnose the actual broken field: reporting a wrong-key/blank/
          // non-string path as "missing claim" sends the retry at the wrong
          // field, which loops — and each iteration discards the call's
          // valid evidence_refs.
          if (!pagePath) {
            invalidPages.push(`${JSON.stringify(row).slice(0, 120)} (missing path — each item needs a string "path" key)`);
          } else if (!claim) {
            invalidPages.push(`${pagePath} (missing claim)`);
          } else if (codePointLength(claim) < CLAIM_MIN_LENGTH) {
            invalidPages.push(`${pagePath} (claim too short — a one-word claim is not a binding)`);
          } else if (codePointLength(claim) > CLAIM_MAX_LENGTH) {
            invalidPages.push(`${pagePath} (claim too long — max ${CLAIM_MAX_LENGTH} characters)`);
          } else {
            pageArgs.push({ path: pagePath, claim });
          }
        } else {
          invalidPages.push(String(item));
        }
      }
      if (invalidPages.length > 0) {
        return result(
          `Each pages item requires { path, claim } — claim is the specific statement (${CLAIM_MIN_LENGTH}-${CLAIM_MAX_LENGTH} characters) in your final answer that the page supports. Invalid: ${invalidPages.join("; ")}. No citations were registered, including any evidence_refs in this call. Retry knowledge_cite once with a concrete claim bound to each page (or drop the unbound pages), keeping your evidence_refs.`,
          0,
        );
      }
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
          ? resolveCitedPagePath(pageValue, opts.knowledgeDir, (absolute) => readPages.has(absolute))
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
      if (unresolved.length > 0) {
        return result(
          `Unresolved evidence refs: ${unresolved.join(", ")}. No citations were registered. Retry knowledge_cite once with only the remaining valid refs (and any unmarked pages).`,
          0,
          unresolved,
        );
      }

      if (pageArgs.length > 0) {
        const selected = pageArgs.map(({ path: value }) =>
          resolveCitedPagePath(value, opts.knowledgeDir, (absolute) => readPages.has(absolute)));
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

      // Rejecting an over-cap call registered ZERO citations on exactly the
      // answers with the most validated support — and reported the resolved
      // refs as "unresolved", whose retry guidance loops (retrying identical
      // valid refs fails identically). Cap and NAME the overflow instead:
      // nothing is dropped silently, and a broad answer keeps its strongest
      // references. Evidence refs are accumulated before pages, so the cap
      // sacrifices pages first — the wording below and both design docs say
      // exactly that rather than promising a global input order that does not
      // exist across the two lists. Unresolved refs above still fail the
      // whole call — that is a correctness problem, not a breadth problem.
      // The cap applies to the TURN's union: repeated calls cannot raise it.
      const already = new Set(registeredThisTurn.map((citation) => citation.url));
      const fresh = citations.filter((citation) => !already.has(citation.url));
      const duplicates = citations.length - fresh.length;
      const capacity = Math.max(0, MAX_KNOWLEDGE_CITATIONS - registeredThisTurn.length);
      const overflow = fresh.length > capacity ? fresh.splice(capacity) : [];
      if (fresh.length > 0) {
        registeredThisTurn.push(...fresh);
        opts.sessionEventEmitter({ type: "knowledge_sources", sources: [...registeredThisTurn] });
      }
      const overflowNote = overflow.length === 0
        ? ""
        : ` ${overflow.length} more source${overflow.length === 1 ? " was" : "s were"} NOT registered ` +
          `(beyond the ${MAX_KNOWLEDGE_CITATIONS}-source per-answer cap): ` +
          overflow.slice(0, MAX_KNOWLEDGE_CITATIONS).map((citation) => citation.title).join(", ") +
          `${overflow.length > MAX_KNOWLEDGE_CITATIONS ? ` (+${overflow.length - MAX_KNOWLEDGE_CITATIONS} more)` : ""}.` +
          " Further calls cannot raise the ceiling; keep the strongest sources or narrow the answer.";
      // The zero-new message must state why THIS call added nothing — "already
      // registered" was previously chosen whenever any earlier call succeeded,
      // which contradicted a cap-exhausted overflow note in the same string
      // and falsely claimed unresolvable pages were cited.
      const zeroFreshMessage = overflow.length > 0
        ? `No new sources were registered — the ${MAX_KNOWLEDGE_CITATIONS}-source per-answer cap is already filled by this turn's earlier citations.${overflowNote}`
        : duplicates > 0
          ? "All resolved sources were already registered this turn; the references list is unchanged."
          : refs.length > 0
            ? "The evidence refs resolved but have no unique original-source links."
            : "The selected pages have no trusted clickable original sources; answer normally without a references section.";
      return result(
        fresh.length > 0
          ? `Registered ${fresh.length} ${refs.length > 0 ? "exact " : ""}trusted original source${fresh.length === 1 ? "" : "s"}; links will be appended automatically.${overflowNote}`
          : zeroFreshMessage,
        fresh.length,
        refs.length > 0 ? [] : undefined,
      );
    },
  };
  return { captureMount, noteRead, tool };
}
