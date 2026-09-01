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
  minScore?: number;
  listLabels?: boolean;
  facet?: string;
  offset?: number;
  limit?: number;
}

function truncateUtf16Safe(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const code = value.charCodeAt(maxLength - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? maxLength - 1 : maxLength;
  return value.slice(0, end);
}

/** Search one Agent's mounted knowledge pages through its scoped hybrid index. */
export function createKnowledgeSearchTool(indexer: KnowledgeResolver): ToolDefinition {
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
      "Search the knowledge pages bound to this Agent using immediately available typed labels plus any ready content indexes. " +
      "Use it before answering from mounted knowledge, including when the user does not know the document title. " +
      "Set listLabels=true to inspect the package's paginated label catalog without loading it into the system prompt. " +
      "Try alternative product names, aliases, versions, and task terms when the first query is incomplete. " +
      "The results are candidate snippets: Read the complete relevant pages before answering, then use knowledge_cite only for pages actually used.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Natural-language query, label alias, version, or exact term to retrieve." })),
      topK: Type.Optional(Type.Number({ description: "Maximum candidate chunks to return (default 8, maximum 20)." })),
      minScore: Type.Optional(Type.Number({ description: "Optional minimum fused relevance score (default 0 to favor recall)." })),
      listLabels: Type.Optional(Type.Boolean({ description: "List the typed label catalog instead of searching page content." })),
      facet: Type.Optional(Type.String({ description: "When listing labels, restrict to one facet." })),
      offset: Type.Optional(Type.Number({ description: "When listing labels, zero-based pagination offset." })),
      limit: Type.Optional(Type.Number({ description: "When listing labels, page size (default 100, maximum 500)." })),
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
        const catalog = indexer.catalog({
          query: params.query?.trim() || undefined,
          facet: params.facet?.trim() || undefined,
          offset: params.offset,
          limit: params.limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ mode: "label_catalog", ...catalog }, null, 2) }],
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

      const topK = Math.min(20, Math.max(1, Math.floor(params.topK ?? 8)));
      try {
        const result = await indexer.search(query, topK, params.minScore ?? 0);
        const results = result.chunks.map((chunk, index) => ({
          rank: index + 1,
          file: chunk.file,
          heading: chunk.heading,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          score: Math.round((chunk.score ?? 0) * 1000) / 1000,
          labels: chunk.labels ?? [],
          matchedLabels: chunk.matchedLabels ?? [],
          content: truncateUtf16Safe(chunk.content, 700),
        }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              mode: result.retrievalMode ?? "content",
              results,
              ...(results.length === 0 ? {
                message: result.contentIndexReady === false
                  ? "No label-matched page found while the content index is warming. Inspect the label catalog or use exact file search as fallback."
                  : "No matching knowledge pages found.",
              } : {}),
              totalFiles: result.totalFiles,
              totalChunks: result.totalChunks,
              contentIndexReady: result.contentIndexReady ?? true,
              totalLabels: result.totalLabels ?? 0,
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
  readOnlyDelegable: true,
};
