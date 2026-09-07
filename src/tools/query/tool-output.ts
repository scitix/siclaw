import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolEntry } from "../../core/tool-registry.js";
import type { ToolOutputStore } from "../infra/tool-output-store.js";
import { renderTextResult } from "../infra/tool-render.js";

export function createToolOutputTool(store?: ToolOutputStore): ToolDefinition {
  return {
    name: "tool_output",
    label: "Tool Output",
    description: "Expand an omitted block or read selected lines of saved command output by output_id, without rerunning the command. " +
      "For a preview's numbered block, pass block_id; the tool resolves its original start/end lines and returns complete lines, " +
      "including partially visible boundary lines. Returns the block's line range, total_lines, and up to 8000 source characters. " +
      "Without block_id, offset and column are 1-based and limit defaults to 100 lines. " +
      "For more output, pass all returned next fields, retaining block_id when present; continuation stops at that block's last line. " +
      "A long line can span several reads. " +
      "Saved output remains available until the task is explicitly closed.",
    parameters: Type.Object({
      output_id: Type.String({ description: "The output_id in a command result's siclaw-output reference." }),
      block_id: Type.Optional(Type.Integer({ minimum: 1, description: "Expand this numbered omitted block from the preview. Its original inclusive line range is calculated automatically." })),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to read (1-based). Defaults to the block's first line, or 1 without block_id; block reads must remain inside its range." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum lines to read within the 8000-character budget. Defaults to the remaining block lines, or 100 without block_id." })),
      column: Type.Optional(Type.Integer({ minimum: 1, description: "Starting UTF-16 column in the first line (1-based); use next.column to continue a long line." })),
    }),
    renderResult: renderTextResult,
    async execute(_id, rawParams) {
      try {
        const params = rawParams as { output_id: string; block_id?: number; offset?: number; limit?: number; column?: number };
        if (!store) throw new Error("tool_output is unavailable in this session.");
        const page = store.read(params.output_id, params.offset, params.limit, params.column, params.block_id);
        const reference = `[siclaw-output ${page.total_chars} chars; ${page.total_lines} lines total; read selected lines with tool_output(${JSON.stringify({ output_id: page.output_id, block_id: params.block_id, offset: page.offset, limit: params.limit, column: page.column })})]`;
        const { output, ...metadata } = page;
        return {
          content: [{ type: "text", text: `${reference}\n${JSON.stringify(metadata)}\n${output}` }],
          details: metadata,
        };
      } catch (error) {
        return { content: [{ type: "text", text: (error as Error).message }], details: { error: true } };
      }
    },
  };
}

export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createToolOutputTool(refs.toolOutputStore),
  available: (refs) => Boolean(refs.toolOutputStore),
  readOnlyDelegable: true,
};
