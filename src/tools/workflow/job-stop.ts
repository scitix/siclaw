/**
 * job_stop — cancel a running background sub-agent job (design §7).
 *
 * The job id comes from a prior spawn_subagent({ run_in_background: true }) result.
 * Hidden until the runtime injects the stop executor.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";
import { RUN_IN_BACKGROUND_ENABLED } from "../../core/subagent-registry.js";

export function createJobStopTool(
  refs: ToolRefs,
  executor = refs.subagentJobStopExecutor,
): ToolDefinition {
  return {
    name: "job_stop",
    label: "Stop Job",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("job_stop")), 0, 0),
    renderResult: renderTextResult,
    description: "Cancel a running background sub-agent by its job_id (from a spawn_subagent launch).",
    parameters: Type.Object({
      job_id: Type.String({ description: "The job_id returned by a background spawn_subagent." }),
    }),
    async execute(_toolCallId, rawParams) {
      if (!executor) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: "job_stop is not available." }) }], details: { error: true } };
      }
      const jobId = (rawParams as { job_id?: string }).job_id?.trim();
      if (!jobId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: "job_stop requires a job_id." }) }], details: { error: true } };
      }
      const result = await executor(jobId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: { ...result, job_id: jobId },
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: (refs) => createJobStopTool(refs),
  modes: ["web", "channel", "cli"],
  platform: true,
  // Gated OFF with background jobs (RUN_IN_BACKGROUND_ENABLED) — no job_id can exist
  // when run_in_background is hidden, so the tool stays unregistered until that lands.
  available: (refs) => RUN_IN_BACKGROUND_ENABLED && Boolean(refs.subagentJobStopExecutor),
};
