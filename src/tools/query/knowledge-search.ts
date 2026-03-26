import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { MemoryIndexer, MemorySearchResult } from "../../memory/index.js";

interface KnowledgeSearchParams {
  query: string;
  topK?: number;
  minScore?: number;
}

/** Truncate string without splitting UTF-16 surrogate pairs */
function truncateUtf16Safe(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const code = str.charCodeAt(maxLen - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? maxLen - 1 : maxLen;
  return str.slice(0, end);
}

export function createKnowledgeSearchTool(indexer?: MemoryIndexer): ToolDefinition {
  // Cache GatewayClient in K8s mode to avoid re-reading TLS certs on every call
  let cachedClient: import("../../agentbox/gateway-client.js").GatewayClient | undefined;

  return {
    name: "knowledge_search",
    label: "Knowledge Search",
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("knowledge_search")) +
          " " + theme.fg("accent", args?.query || ""),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Search the team knowledge base for internal documentation, runbooks, architecture guides, and infrastructure reference.
Use this tool when the user asks about internal procedures, known configurations, or team-specific documentation.

Parameters:
- query: Natural language search query
- topK: Max results to return (default: 5)
- minScore: Minimum relevance score threshold (default: 0.35)

Returns matching document chunks with file path, heading context, content snippet, and relevance score.`,
    parameters: Type.Object({
      query: Type.String({ description: "Natural language search query" }),
      topK: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
      minScore: Type.Optional(Type.Number({ description: "Minimum score threshold (default: 0.35)" })),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as KnowledgeSearchParams;
      const query = params.query?.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Empty query" }) }],
          details: {},
        };
      }

      // Clamp topK to prevent context window abuse
      const topK = Math.min(params.topK ?? 5, 20);
      const minScore = params.minScore ?? 0.35;

      try {
        let result: MemorySearchResult;

        if (indexer) {
          // Local mode: use indexer directly
          result = await indexer.search(query, topK, minScore);
        } else if (process.env.SICLAW_GATEWAY_URL) {
          // K8s mode: call Gateway internal API (client cached across calls)
          if (!cachedClient) {
            const { GatewayClient } = await import("../../agentbox/gateway-client.js");
            cachedClient = new GatewayClient({ gatewayUrl: process.env.SICLAW_GATEWAY_URL });
          }
          result = await cachedClient.searchKnowledge(query, topK, minScore);
        } else {
          return {
            content: [{ type: "text", text: JSON.stringify({
              error: "Knowledge base is not available. Embedding config may not be set up.",
            }) }],
            details: {},
          };
        }

        if (result.chunks.length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                results: [],
                message: "No matching knowledge base documents found.",
                totalFiles: result.totalFiles,
                totalChunks: result.totalChunks,
              }, null, 2),
            }],
            details: {},
          };
        }

        const formatted = result.chunks.map((c, i) => ({
          rank: i + 1,
          file: c.file,
          heading: c.heading,
          score: Math.round((c.score ?? 0) * 1000) / 1000,
          content: truncateUtf16Safe(c.content, 500),
        }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              results: formatted,
              totalFiles: result.totalFiles,
              totalChunks: result.totalChunks,
            }, null, 2),
          }],
          details: {},
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[knowledge_search] Search failed:", err);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          details: {},
        };
      }
    },
  };
}
