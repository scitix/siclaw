/**
 * task_report — Cron-only tool that forces structured output via a tool call.
 *
 * Models like Kimi-K2.5 end turns with empty text after tool calls.
 * Tool-calling compliance is much higher than free-text compliance,
 * so we capture the report through a tool call instead.
 */

import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { renderTextResult } from "../../tools/infra/tool-render.js";

export function createTaskReportTool(): ToolDefinition {
  return {
    name: "task_report",
    label: "Task Report",
    renderCall(_args: unknown, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("task_report")),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description:
      `Submit the final report for an automated scheduled task. ` +
      `You MUST call this tool exactly once at the end of your work to deliver the result. ` +
      `The summary you provide is recorded as the task output and sent to the user. ` +
      `If you do not call this tool, the task result will be empty.`,
    parameters: Type.Object({
      summary: Type.String({
        description: "Concise, structured report of findings and results (Markdown allowed)",
      }),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as { summary: string };
      return {
        content: [{ type: "text" as const, text: params.summary }],
        details: {},
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: (_refs) => createTaskReportTool(),
  modes: ["task"],
  platform: true,
};
