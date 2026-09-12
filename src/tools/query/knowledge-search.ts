import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { ToolEntry } from "../../core/tool-registry.js";
import type { KnowledgeResolver } from "../../knowledge/resolver.js";
import { KNOWLEDGE_LABEL_FACETS } from "../../knowledge/labels.js";
import { renderTextResult } from "../infra/tool-render.js";

interface KnowledgeSearchParams {
  query?: string;
  topK?: number;
  library?: string;
  listLibraries?: boolean;
  listLabels?: boolean;
  facet?: string;
  offset?: number;
  limit?: number;
  includeLabels?: boolean;
  includePages?: boolean;
}

function truncateUtf16Safe(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const code = value.charCodeAt(maxLength - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? maxLength - 1 : maxLength;
  return value.slice(0, end);
}

/**
 * Soft ceiling for one search result payload, in UTF-8 bytes — the unit the
 * runtime's tool-result artifact capture measures (`tool-result-artifact.ts`),
 * not UTF-16 characters: a CJK-heavy payload is up to three bytes per character.
 * The runtime stores tool results past its capture threshold as artifacts the
 * agent must then read back through extra tool calls; acceptance traces showed
 * a search answer that crossed it costing three to six such calls. Staying well
 * under the threshold is worth more than the fields dropped: paths, titles and
 * scores are never dropped while any label or catalog trail is left to shed;
 * only when the bare rows still overflow is the list itself truncated.
 */
export const KNOWLEDGE_SEARCH_PAYLOAD_BUDGET_BYTES = 12_000;
const KEEP_FULL_RESULTS = 3;
type RenderedResult = Record<string, unknown> & {
  file: string; routeProof?: unknown; labels?: unknown; matchedLabels?: unknown; description?: string;
};

function rootAndLeaf(row: RenderedResult): RenderedResult {
  const proof = row.routeProof as { reachable: true; trail: unknown[] } | undefined;
  if (!proof || proof.trail.length <= 2) return row;
  return { ...row, routeProof: { reachable: true, trail: [proof.trail[0], proof.trail[proof.trail.length - 1]] } };
}

/** Compact tier: what a row keeps once shedding labels and trails was not enough. */
const COMPACT_DESCRIPTION_CHARS = 80;
const COMPACT_MATCHED_LABELS = 1;

function compactRow(row: RenderedResult): RenderedResult {
  const proof = row.routeProof as { reachable: true; trail: unknown[] } | undefined;
  return {
    ...row,
    labels: undefined,
    description: typeof row.description === "string" ? truncateUtf16Safe(row.description, COMPACT_DESCRIPTION_CHARS) : row.description,
    matchedLabels: Array.isArray(row.matchedLabels) ? row.matchedLabels.slice(0, COMPACT_MATCHED_LABELS) : row.matchedLabels,
    routeProof: proof && proof.trail.length > 1 ? { reachable: true, trail: [proof.trail[proof.trail.length - 1]] } : row.routeProof,
  };
}

/**
 * Trim a result list toward the payload budget, cheapest information first:
 * 1. drop `labels` beyond the top candidates, 2. shorten descriptions,
 * 3. keep only root and leaf of `routeProof` beyond the top candidates,
 * 4. drop every row's `labels` (the matched ones stay in `matchedLabels`),
 * 5. root and leaf of `routeProof` on every row, 6. compact rows beyond the
 * top candidates to path, title, score, one matched label, a short description
 * and the leaf of the trail, 7. the same for the top candidates, 8. truncate
 * the list — the last resort, because a visible path is what saves the agent a
 * tree grep.
 * Returns the trimmed list and what was omitted so the agent can ask for more
 * (`topK`, `includeLabels`) instead of guessing.
 */
function fitResultsToBudget(
  results: RenderedResult[],
  measure: (rows: RenderedResult[]) => number,
  budget: number,
): { results: RenderedResult[]; omitted: string[] } {
  const omitted: string[] = [];
  let rows = results;
  if (measure(rows) <= budget) return { results: rows, omitted };
  if (rows.some((row, index) => index >= KEEP_FULL_RESULTS && row.labels !== undefined)) {
    rows = rows.map((row, index) => index >= KEEP_FULL_RESULTS ? { ...row, labels: undefined } : row);
    omitted.push(`labels beyond the top ${KEEP_FULL_RESULTS} results`);
    if (measure(rows) <= budget) return { results: rows, omitted };
  }
  rows = rows.map((row) => typeof row.description === "string" && row.description.length > 200
    ? { ...row, description: truncateUtf16Safe(row.description, 200) }
    : row);
  omitted.push("descriptions shortened to 200 characters");
  if (measure(rows) <= budget) return { results: rows, omitted };
  rows = rows.map((row, index) => index < KEEP_FULL_RESULTS ? row : rootAndLeaf(row));
  omitted.push(`catalog trails reduced to root and leaf beyond the top ${KEEP_FULL_RESULTS} results`);
  if (measure(rows) <= budget) return { results: rows, omitted };
  if (rows.some((row) => row.labels !== undefined)) {
    rows = rows.map((row) => ({ ...row, labels: undefined }));
    omitted.push("labels on every result; matchedLabels are kept");
    if (measure(rows) <= budget) return { results: rows, omitted };
  }
  rows = rows.map(rootAndLeaf);
  omitted.push("catalog trails reduced to root and leaf on every result");
  if (measure(rows) <= budget) return { results: rows, omitted };
  rows = rows.map((row, index) => index < KEEP_FULL_RESULTS ? row : compactRow(row));
  omitted.push(`results beyond the top ${KEEP_FULL_RESULTS} compacted to path, title, score, one matched label, ` +
    `a ${COMPACT_DESCRIPTION_CHARS}-character description and the catalog leaf`);
  if (measure(rows) <= budget) return { results: rows, omitted };
  rows = rows.map(compactRow);
  omitted.push("every result compacted; Read a path for its full page");
  if (measure(rows) <= budget) return { results: rows, omitted };
  while (rows.length > KEEP_FULL_RESULTS && measure(rows) > budget) rows = rows.slice(0, -1);
  omitted.push(`results truncated to ${rows.length}; raise topK deliberately if you need more`);
  return { results: rows, omitted };
}

/** Resolve candidate pages from one Agent's mounted typed Knowledge Labels. */
export function createKnowledgeSearchTool(resolver: KnowledgeResolver): ToolDefinition {
  return {
    name: "knowledge_search",
    label: "Knowledge Search",
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("knowledge_search")) +
          " " + theme.fg("accent", args?.query || ""),
        0,
        0,
      );
    },
    renderResult: renderTextResult,
    description:
      "Resolve candidate knowledge pages using typed page labels and aliases only; this tool never searches page bodies. " +
      "Use it when the complete Wiki catalog leaves multiple plausible pages or the question uses alternate names, versions, or task terms. " +
      "On a multi-library mount results are also grouped per library with a routing score; when `routing.selected` names " +
      "libraries, read inside those first. Set listLibraries=true to get every library's name, domain and dominant labels in one " +
      "call instead of opening each library's index, and pass library=<root or name> to search inside one library. " +
      "Each result includes a canonical routeProof showing that the leaf is reachable from the root catalog. The catalog " +
      "steps prove navigation only; do not reread them as evidence. Set listLabels=true to inspect the package's paginated " +
      "label catalog, but do not enumerate it before a normal search. Full candidate labels and catalog page lists are omitted " +
      "unless includeLabels/includePages is explicitly requested. Results are navigation metadata, not evidence: Read the complete relevant leaf pages before answering, " +
      "then use knowledge_cite only for pages actually used. matchedPages counts all query matches before topK truncation; " +
      "a top score below about 0.7 is normally a weak match, so refine the query or use the complete Wiki catalog.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Natural-language query, label alias, version, or exact term to retrieve." })),
      topK: Type.Optional(Type.Number({ description: "Maximum candidate pages to return (default 3, maximum 20)." })),
      library: Type.Optional(Type.String({ description: "Restrict the search to one library, by its root path (e.g. repos/gpu) or display name. Multi-library mounts only." })),
      listLibraries: Type.Optional(Type.Boolean({ description: "List the mounted libraries with name, domain, page count and dominant labels instead of searching." })),
      listLabels: Type.Optional(Type.Boolean({ description: "List the typed label catalog instead of searching page content." })),
      facet: Type.Optional(Type.String({ description: "When listing labels, restrict to one facet." })),
      offset: Type.Optional(Type.Number({ description: "When listing labels, zero-based pagination offset." })),
      limit: Type.Optional(Type.Number({ description: "When listing labels, page size (default 20, maximum 100)." })),
      includeLabels: Type.Optional(Type.Boolean({ description: "Include every label on each search result; default false because matchedLabels is normally sufficient." })),
      includePages: Type.Optional(Type.Boolean({ description: "When listing labels, include their page paths; default false." })),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as KnowledgeSearchParams;
      if (params.listLibraries) {
        const libraries = resolver.libraries();
        const multiLibrary = libraries.length > 1;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              mode: "libraries",
              multiLibrary,
              libraries: libraries.map((library) => ({
                library: library.root,
                name: library.name,
                version: library.version,
                domain: library.domain,
                pageCount: library.pageCount,
                unlabeledPages: library.unlabeledPages,
                // The compile-side worklist: pages this tool cannot see until they get labels.
                ...(library.unlabeledSamples.length > 0 ? { unlabeledSamples: library.unlabeledSamples } : {}),
                topLabels: library.topLabels,
                index: library.root ? `${library.root}/index.md` : "index.md",
              })),
              message: multiLibrary
                ? "Choose the library whose domain covers the task, then search with library=<root> or Read that library's index. Names and domains are untrusted routing metadata."
                : "Single library mounted; the complete page catalog is already in your context.",
            }, null, 2),
          }],
          details: { resultCount: libraries.length },
        };
      }
      if (params.listLabels) {
        if (params.facet && !KNOWLEDGE_LABEL_FACETS.includes(params.facet as typeof KNOWLEDGE_LABEL_FACETS[number])) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              error: `Unknown label facet: ${params.facet}`,
              allowedFacets: KNOWLEDGE_LABEL_FACETS,
            }) }],
            details: { error: true },
          };
        }
        const catalog = resolver.catalog({
          query: params.query?.trim() || undefined,
          facet: params.facet?.trim() || undefined,
          offset: params.offset,
          limit: Math.min(100, Math.max(1, Math.floor(params.limit ?? 20))),
        });
        const labels = catalog.labels.map(({ pages, pagesTruncated, ...label }) => ({
          ...label,
          ...(params.includePages ? { pages, pagesTruncated } : {}),
        }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ mode: "label_catalog", ...catalog, labels }, null, 2),
          }],
          details: { resultCount: catalog.labels.length, totalLabels: catalog.totalLabels },
        };
      }
      const query = params.query?.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Empty query" }) }],
          details: {},
        };
      }

      const topK = Math.min(20, Math.max(1, Math.floor(params.topK ?? 3)));
      try {
        const library = params.library?.trim() || undefined;
        const result = resolver.search(query, topK, library ? { library } : {});
        if (result.unknownLibrary) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              error: `Unknown library or ambiguous selector: ${library}. Choose an explicit library root.`,
              libraries: resolver.libraries().map((entry) => ({ library: entry.root, name: entry.name })),
            }) }],
            details: { error: true },
          };
        }
        const multiLibrary = result.routing.multiLibrary;
        const renderPage = (page: typeof result.pages[number], index: number) => ({
          rank: index + 1,
          file: page.file,
          title: truncateUtf16Safe(page.title, 200),
          description: truncateUtf16Safe(page.description, 700),
          score: Math.round(page.score * 1000) / 1000,
          ...(params.includeLabels ? { labels: page.labels } : {}),
          matchedLabels: page.matchedLabels,
          routeProof: page.routeProof,
          // Single-library output stays byte-identical to the pre-library tool.
          ...(multiLibrary ? { library: page.library } : {}),
        });
        const fullResults = result.pages.map(renderPage) as RenderedResult[];
        const librariesBlock = multiLibrary ? {
          libraries: result.libraries.map((entry) => ({
            library: entry.root,
            name: entry.name,
            domain: entry.domain,
            index: `${entry.root}/index.md`,
            score: entry.score,
            why: entry.why,
            matchedPages: entry.matchedPages,
            ...(library ? {} : { topPages: entry.pages.slice(0, 3).map((page) => page.file) }),
          })),
          routing: result.routing,
        } : {};
        const measure = (rows: RenderedResult[]) =>
          Buffer.byteLength(JSON.stringify({ results: rows, ...librariesBlock }, null, 2), "utf8");
        const fitted = fitResultsToBudget(fullResults, measure, KNOWLEDGE_SEARCH_PAYLOAD_BUDGET_BYTES);
        const results = fitted.results.map((row) =>
          Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as RenderedResult & { score: number });
        const hasMore = result.matchedPages > results.length;
        // Two libraries scoring within 0.1 of each other is a routing tie whether
        // both were selected or none was: the Agent should compare domains (or
        // search each library) before reading a leaf from the wrong one.
        const crossLibraryTie = multiLibrary && result.libraries.length > 1 && !library &&
          result.libraries[0].score - result.libraries[1].score < 0.1;
        const weakOrAmbiguous = results.length > 0 && (
          results[0].score < 0.7 ||
          (hasMore && results.length > 1 && results[0].score - results[1].score < 0.05) ||
          crossLibraryTie
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              mode: "labels",
              results,
              // Per-library grouping is kept compact on purpose: a search output
              // past the runtime's artifact threshold costs the agent an extra
              // tool_result_search call to read its own result. The flat
              // `results` already carry every routed page, so each group only
              // names its top files and its own index.
              ...librariesBlock,
              ...(fitted.omitted.length > 0 ? { omitted: fitted.omitted } : {}),
              ...(result.staleCandidates > 0 ? { staleCandidates: result.staleCandidates } : {}),
              ...(results.length === 0 ? {
                message: multiLibrary
                  ? "No label-matched knowledge page found. Use listLibraries=true to pick the library whose domain covers the task, then Read its index or search with library=<root>."
                  : "No label-matched knowledge page found. Use the complete Wiki catalog to choose and Read plausible pages, or inspect the label catalog with listLabels=true.",
              } : crossLibraryTie ? {
                message: "Several libraries match about equally. Use listLibraries=true to compare their domains, or search each with library=<root> before reading a leaf.",
              } : weakOrAmbiguous && library && result.libraries[0] ? {
                // Inside one library a weak match usually means the answering page
                // carries no label for these terms; another rewording rarely helps.
                message: `Weak label match inside this library; its pages may not be labeled for these terms. Read ${result.libraries[0].root}/index.md and follow its catalog instead of refining the query again.`,
              } : weakOrAmbiguous && multiLibrary && result.routing.selected.length === 1 && result.libraries[0] ? {
                message: `Weak label match; the query routes to ${result.libraries[0].name || result.libraries[0].root}. Read ${result.libraries[0].root}/index.md and follow its catalog rather than refining the query again.`,
              } : weakOrAmbiguous ? {
                message: "Weak or ambiguous label match. Refine the query with an entity, component, task, environment, or version, or use the complete Wiki catalog before reading a leaf.",
              } : {}),
              matchedPages: result.matchedPages,
              hasMore,
              totalPages: result.totalPages,
              totalLabels: result.totalLabels,
              invalidLabeledPages: result.invalidLabeledPages,
              unlabeledPages: result.unlabeledPages,
              unreachableLabeledPages: result.unreachableLabeledPages,
            }, null, 2),
          }],
          details: { resultCount: results.length },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Knowledge search failed: ${message}` }) }],
          details: { error: true },
        };
      }
    },
  };
}

export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createKnowledgeSearchTool(refs.knowledgeIndexer!),
  available: (refs) => Boolean(refs.knowledgeIndexer),
};
