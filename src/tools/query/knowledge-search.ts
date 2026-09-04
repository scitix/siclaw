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
      "Each result includes a canonical routeProof showing that the leaf is reachable from the root catalog. The catalog " +
      "steps prove navigation only; do not reread them as evidence. Set listLabels=true to inspect the package's paginated " +
      "label catalog, but do not enumerate it before a normal search. Full candidate labels and catalog page lists are omitted " +
      "unless includeLabels/includePages is explicitly requested. Results are navigation metadata, not evidence: Read the complete relevant leaf pages before answering, " +
      "then use knowledge_cite only for pages actually used. matchedPages counts all query matches before topK truncation; " +
      "a top score below about 0.7 is normally a weak match, so refine the query or use the complete Wiki catalog.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Natural-language query, label alias, version, or exact term to retrieve." })),
      topK: Type.Optional(Type.Number({ description: "Maximum candidate pages to return (default 3, maximum 20)." })),
      listLabels: Type.Optional(Type.Boolean({ description: "List the typed label catalog instead of searching page content." })),
      facet: Type.Optional(Type.String({ description: "When listing labels, restrict to one facet." })),
      offset: Type.Optional(Type.Number({ description: "When listing labels, zero-based pagination offset." })),
      limit: Type.Optional(Type.Number({ description: "When listing labels, page size (default 20, maximum 100)." })),
      includeLabels: Type.Optional(Type.Boolean({ description: "Include every label on each search result; default false because matchedLabels is normally sufficient." })),
      includePages: Type.Optional(Type.Boolean({ description: "When listing labels, include their page paths; default false." })),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as KnowledgeSearchParams;
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
        const result = resolver.search(query, topK);
        const results = result.pages.map((page, index) => ({
          rank: index + 1,
          file: page.file,
          title: truncateUtf16Safe(page.title, 200),
          description: truncateUtf16Safe(page.description, 700),
          score: Math.round(page.score * 1000) / 1000,
          ...(params.includeLabels ? { labels: page.labels } : {}),
          matchedLabels: page.matchedLabels,
          routeProof: page.routeProof,
        }));
        const hasMore = result.matchedPages > results.length;
        const weakOrAmbiguous = results.length > 0 && (
          results[0].score < 0.7 ||
          (hasMore && results.length > 1 && results[0].score - results[1].score < 0.05)
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              mode: "labels",
              results,
              ...(results.length === 0 ? {
                message: "No label-matched knowledge page found. Use the complete Wiki catalog to choose and Read plausible pages, or inspect the label catalog with listLabels=true.",
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
