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

import { formatToolResultArtifactReference } from "../../core/tool-result-artifact.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";
import { BACKGROUND_BASH_ENABLED, RUN_IN_BACKGROUND_ENABLED } from "../../core/subagent-registry.js";
import { readTaskOutput, readTaskOutputPage } from "../cmd-exec/disk-output.js";

const DEFAULT_TAIL_LINES = 400;

export function createTaskOutputTool(
  refs: ToolRefs,
  reader = refs.taskOutputReader,
): ToolDefinition {
  return {
    name: "task_output",
    label: "Task Output",
    description:
      "Read the output of a background job (started with run_in_background) by its task_id. " +
      "Reports the job's status (running / completed / failed / stopped) plus its output — use " +
      "this instead of reading the raw output_file path. If status is \"running\", the output is " +
      "partial: continue independent work, or wait for its completion notification without polling. Read partial output only when needed for a readiness decision. " +
      "By default returns the last ~400 lines. To read the entire output without losing earlier evidence, pass offset:0 and follow next_offset (byte offsets) until complete. limit controls the page size.",
    parameters: Type.Object({
      task_id: Type.String({ description: "The task_id returned by a background launch (run_in_background)." }),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset into complete output; start at 0 and follow next_offset." })),
      limit: Type.Optional(Type.Integer({ minimum: 4, maximum: 65536, description: "Page size in bytes (default 32768)." })),
      tail_lines: Type.Optional(
        Type.Number({ description: "Return only the last N lines of output. Omit for the default (~400); 0 for as much as fits (up to the last ~8MB)." }),
      ),
    }),
    async execute(_toolCallId, rawParams) {
      if (!reader) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: "task_output is not available." }) }], details: { error: true } };
      }
      const params = rawParams as { task_id?: string; tail_lines?: number; offset?: number; limit?: number };
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

      if (before.reportArtifact) {
        return { content: [{ type: "text" as const, text: formatToolResultArtifactReference(before.reportArtifact,
          `Job status: ${before.status}. Read the complete sub-agent report with tool_result_read.`, 1200) }],
          details: { task_id: jobId, status: before.status, toolResultArtifact: before.reportArtifact } };
      }
      const tail = params.tail_lines ?? DEFAULT_TAIL_LINES;
      const page = params.offset !== undefined || params.limit !== undefined
        ? await readTaskOutputPage(jobId, params.offset ?? 0, params.limit)
        : undefined;
      const { output, bytes, truncated, exists } = page ?? await readTaskOutput(jobId, tail);
      // Re-snapshot AFTER the read: a job that finished during the read is now reported terminal
      // with its (already-flushed) final output, not stale "running".
      const after = reader(jobId);
      const status = after.found ? after.status : before.status;
      const exitCode = after.found ? after.exitCode : before.exitCode;
      const running = status === "running";

      const notes: string[] = [];
      if (running) {
        notes.push("Job is still running — this output is PARTIAL. Do not present a final answer; continue independent work or wait for the completion notification.");
      }
      if (truncated) {
        notes.push("This is a bounded excerpt. Read from offset:0 and follow next_offset to recover the complete output; do not infer missing evidence from a preview.");
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
        ...(page ? { offset: page.offset, next_offset: page.next_offset, complete: page.complete && !running } : {}),
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
  // Available once a background mode is on AND the runtime injected the reader (so a task_id
  // can exist and be looked up). Hidden otherwise.
  available: (refs) =>
    (RUN_IN_BACKGROUND_ENABLED || BACKGROUND_BASH_ENABLED) && Boolean(refs.taskOutputReader),
};
