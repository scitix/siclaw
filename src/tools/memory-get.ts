import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { renderTextResult } from "./tool-render.js";

interface MemoryGetParams {
  path: string;
  from?: number;
  lines?: number;
}

export function createMemoryGetTool(memoryDir: string): ToolDefinition {
  return {
    name: "memory_get",
    label: "Memory Get",
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("memory_get")) +
          " " + theme.fg("accent", args?.path || ""),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Safe snippet read from MEMORY.md or memory/*.md with optional line range.
Use after memory_search to read full or partial content of a matched file.

Parameters:
- path: Relative path within the memory directory (e.g. "MEMORY.md", "2025-01-15.md")
- from: Optional start line number (1-indexed). Defaults to 1.
- lines: Optional number of lines to return. Defaults to all lines.`,
    parameters: Type.Object({
      path: Type.String({ description: "Relative path within memory directory" }),
      from: Type.Optional(Type.Number({ description: "Start line number (1-indexed, default: 1)" })),
      lines: Type.Optional(Type.Number({ description: "Number of lines to return (default: all)" })),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as MemoryGetParams;
      const relPath = params.path?.trim();
      if (!relPath) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Empty path" }) }],
          details: {},
        };
      }

      // Security: resolve and verify path stays within memoryDir
      const absPath = path.resolve(memoryDir, relPath);
      const normalizedMemDir = path.resolve(memoryDir);
      if (!absPath.startsWith(normalizedMemDir + path.sep) && absPath !== normalizedMemDir) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Path traversal blocked" }) }],
          details: {},
        };
      }

      try {
        const stat = await fs.stat(absPath);
        const MAX_FILE_SIZE = 100 * 1024; // 100KB
        if (stat.size > MAX_FILE_SIZE && !params.from && !params.lines) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: `File too large (${stat.size} bytes). Use 'from' and 'lines' to read a portion.`,
                path: relPath,
                size: stat.size,
              }),
            }],
            details: {},
          };
        }

        const content = await fs.readFile(absPath, "utf-8");
        const allLines = content.split("\n");
        const totalLines = allLines.length;

        // Apply line range if specified
        const fromLine = Math.max(1, params.from ?? 1);
        const lineCount = params.lines ?? totalLines;
        const sliced = allLines.slice(fromLine - 1, fromLine - 1 + lineCount);
        const text = sliced.join("\n");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              path: relPath,
              totalLines,
              from: fromLine,
              lines: sliced.length,
              content: text,
            }, null, 2),
          }],
          details: {},
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isNotFound = err instanceof Error && "code" in err && (err as any).code === "ENOENT";
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: isNotFound ? `File not found: ${relPath}` : message,
            }),
          }],
          details: {},
        };
      }
    },
  };
}
