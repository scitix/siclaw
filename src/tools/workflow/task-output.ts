/**
 * task_output — read a background job's output in a STATUS-AWARE way.
 *
 * Replaces the model blindly `read`ing the raw `output_file` path, which returns a hard
 * ENOENT while a backgrounded job has produced no output yet (e.g. an `ib_write_bw` server
 * blocked waiting for a client). This tool consults the runtime's JobRegistry (via the
 * injected taskOutputReader) and the on-disk file, so it can report:
 *   - running   → partial output so far + "still running, wait for the completion notice"
 *   - completed/failed/stopped → final output + exit code
 * Output is already sanitized on the write side (SanitizingLineBuffer). Hidden until the
 * runtime injects the reader (so a task_id can actually exist).
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";
import { BACKGROUND_BASH_ENABLED, RUN_IN_BACKGROUND_ENABLED } from "../../core/subagent-registry.js";
import { readTaskOutput } from "../cmd-exec/disk-output.js";

const DEFAULT_TAIL_LINES = 400;

export function createTaskOutputTool(
  refs: ToolRefs,
  reader = refs.taskOutputReader,
): ToolDefinition {
  return {
    name: "task_output",
    label: "Task Output",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("task_output")), 0, 0),
    renderResult: renderTextResult,
    description:
      "Read the output of a background job (started with run_in_background) by its task_id. " +
      "Reports the job's status (running / completed / failed / stopped) plus its output — use " +
      "this instead of reading the raw output_file path. If status is \"running\", the output is " +
      "partial: END YOUR TURN and call task_output again only after the completion notification. " +
      "By default returns the last ~400 lines; pass tail_lines to change (0 = as much as fits, up to the last ~8MB).",
    parameters: Type.Object({
      task_id: Type.String({ description: "The task_id returned by a background launch (run_in_background)." }),
      tail_lines: Type.Optional(
        Type.Number({ description: "Return only the last N lines of output. Omit for the default (~400); 0 for as much as fits (up to the last ~8MB)." }),
      ),
    }),
    async execute(_toolCallId, rawParams) {
      if (!reader) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: "task_output is not available." }) }], details: { error: true } };
      }
      const params = rawParams as { task_id?: string; tail_lines?: number };
      const jobId = params.task_id?.trim();
      if (!jobId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: "task_output requires a task_id." }) }], details: { error: true } };
      }

      const before = reader(jobId);
      if (!before.found) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `No background job "${jobId}" (unknown task_id, or it predates this session).` }) }],
          details: { error: true, task_id: jobId },
        };
      }

      const tail = params.tail_lines ?? DEFAULT_TAIL_LINES;
      const { output, bytes, truncated, exists } = await readTaskOutput(jobId, tail);
      // Re-snapshot AFTER the read: a job that finished during the read is now reported terminal
      // with its (already-flushed) final output, not stale "running".
      const after = reader(jobId);
      const status = after.found ? after.status : before.status;
      const exitCode = after.found ? after.exitCode : before.exitCode;
      const running = status === "running";

      const notes: string[] = [];
      if (running) {
        notes.push("Job is still running — this output is PARTIAL. Do not treat it as final; end your turn and read again after the completion notification.");
      }
      if (truncated) {
        notes.push("Output was truncated to the most recent lines — call task_output with tail_lines:0 for more (up to the last ~8MB).");
      }
      if (!running && !exists) {
        notes.push("The output file is no longer available (it may have been cleaned up after the job finished).");
      }

      const result = {
        task_id: jobId,
        status,
        running,
        ...(exitCode != null ? { exit_code: exitCode } : {}),
        bytes,
        truncated,
        output,
        ...(notes.length ? { note: notes.join(" ") } : {}),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: { task_id: jobId, status, running, bytes, truncated },
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: (refs) => createTaskOutputTool(refs),
  modes: ["web", "channel", "cli"],
  // Available once a background mode is on AND the runtime injected the reader (so a task_id
  // can exist and be looked up). Hidden otherwise.
  available: (refs) =>
    (RUN_IN_BACKGROUND_ENABLED || BACKGROUND_BASH_ENABLED) && Boolean(refs.taskOutputReader),
};
