import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { FEEDBACK_SIGNALS, type FeedbackStatus } from "../memory/types.js";
import type { MemoryRef } from "./deep-search/tool.js";

interface FeedbackParams {
  investigationId: string;
  status: FeedbackStatus;
  correctedRootCause?: string;
  note?: string;
}

export function createInvestigationFeedbackTool(memoryRef: MemoryRef): ToolDefinition {
  return {
    name: "investigation_feedback",
    label: "Investigation Feedback",
    description: `Submit feedback on a completed investigation's diagnosis accuracy.
This adjusts retrieval weighting so correct diagnoses get boosted and wrong ones get suppressed in future investigations.

Use after presenting deep_search findings when the user confirms, corrects, or rejects the diagnosis.
The investigationId comes from the deep_search result details.`,
    parameters: Type.Object({
      investigationId: Type.String({ description: "ID from the deep_search result" }),
      status: Type.Union([
        Type.Literal("confirmed"),
        Type.Literal("corrected"),
        Type.Literal("rejected"),
      ], { description: "confirmed = diagnosis was correct, corrected = partially right but root cause was different, rejected = diagnosis was wrong" }),
      correctedRootCause: Type.Optional(Type.String({ description: "The actual root cause (when status is 'corrected')" })),
      note: Type.Optional(Type.String({ description: "Additional context about the feedback" })),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as FeedbackParams;

      const indexer = memoryRef.indexer;
      if (!indexer) {
        return {
          content: [{ type: "text", text: "Memory indexer not available. Feedback not saved." }],
          details: { error: true },
        };
      }

      // Validate that the investigation exists
      const record = indexer.getInvestigationById(params.investigationId);
      if (!record) {
        return {
          content: [{ type: "text", text: `Investigation not found: ${params.investigationId}` }],
          details: { error: true },
        };
      }

      // Build feedback note: encode status + optional correction/note
      const signal = FEEDBACK_SIGNALS[params.status];
      let note = params.status as string;
      if (params.status === "corrected" && params.correctedRootCause) {
        note = `corrected: ${params.correctedRootCause}`;
      }
      if (params.note) {
        note += ` | ${params.note}`;
      }

      const updated = indexer.updateInvestigationFeedback(params.investigationId, signal, note);
      if (!updated) {
        return {
          content: [{ type: "text", text: "Failed to update investigation feedback." }],
          details: { error: true },
        };
      }

      const statusLabels: Record<FeedbackStatus, string> = {
        confirmed: `Diagnosis confirmed (weight boosted to ${signal}x)`,
        corrected: `Diagnosis corrected (weight reduced to ${signal}x)`,
        rejected: `Diagnosis rejected (weight reduced to ${signal}x)`,
      };

      return {
        content: [{ type: "text", text: `Feedback recorded: ${statusLabels[params.status]}. Future investigations will be adjusted accordingly.` }],
        details: {
          investigationId: params.investigationId,
          status: params.status,
          signal,
        },
      };
    },
  };
}
