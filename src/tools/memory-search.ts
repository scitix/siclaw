import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { renderTextResult } from "./tool-render.js";
import type { MemoryIndexer } from "../memory/index.js";

interface MemorySearchParams {
  query: string;
  topK?: number;
  minScore?: number;
}

/** Truncate string without splitting UTF-16 surrogate pairs */
function truncateUtf16Safe(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  // If we'd split a surrogate pair, back up by one
  const code = str.charCodeAt(maxLen - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? maxLen - 1 : maxLen;
  return str.slice(0, end);
}

export function createMemorySearchTool(indexer: MemoryIndexer): ToolDefinition {
  return {
    name: "memory_search",
    label: "Memory Search",
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("memory_search")) +
          " " + theme.fg("accent", args?.query || ""),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Semantically search long-term memory files (memory/*.md) using hybrid vector + keyword search.
Use this tool BEFORE answering questions about prior work, decisions, preferences, or historical context.

Parameters:
- query: Natural language search query
- topK: Max results to return (default: 10)
- minScore: Minimum relevance score threshold (default: 0.35)

Returns matching memory chunks with file path, heading context, content snippet, and relevance score.`,
    parameters: Type.Object({
      query: Type.String({ description: "Natural language search query" }),
      topK: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
      minScore: Type.Optional(Type.Number({ description: "Minimum score threshold (default: 0.35)" })),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as MemorySearchParams;
      const query = params.query?.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Empty query" }) }],
          details: {},
        };
      }

      try {
        const result = await indexer.search(query, params.topK ?? 10, params.minScore);

        if (result.chunks.length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                results: [],
                message: "No matching memories found.",
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
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          details: {},
        };
      }
    },
  };
}
