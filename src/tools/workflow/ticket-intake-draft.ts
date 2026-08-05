import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";
import { normalizeTicketIntakeDraft } from "../../shared/ticket-intake.js";

export function createTicketIntakeDraftTool(refs: ToolRefs): ToolDefinition {
  return {
    name: "ticket_intake_draft",
    label: "Ticket Intake Draft",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("ticket_intake_draft")), 0, 0),
    renderResult: renderTextResult,
    description:
      "Update the full structured draft for a ticket-intake flow that the user explicitly started in the IM channel. " +
      "This tool only saves a draft. It cannot confirm, submit, inspect infrastructure, or create a ticket. " +
      "Keep open_questions precise and set ready_for_review only after all required facts are complete.",
    parameters: Type.Object({
      intake_id: Type.String({ minLength: 1, description: "Opaque intake id from the platform context." }),
      expected_revision: Type.Integer({ minimum: 1, description: "Current revision from the platform context." }),
      classification: Type.Union([
        Type.Literal("answerable_consultation"),
        Type.Literal("needs_clarification"),
        Type.Literal("incident_candidate"),
        Type.Literal("service_request"),
      ]),
      summary: Type.String({ minLength: 1 }),
      product: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
      impact: Type.Optional(Type.String()),
      affected_object: Type.Optional(Type.String()),
      occurred_at: Type.Optional(Type.String()),
      actual_behavior: Type.Optional(Type.String()),
      expected_behavior: Type.Optional(Type.String()),
      attempted_actions: Type.Array(Type.String(), { maxItems: 20 }),
      source_refs: Type.Array(Type.String(), { maxItems: 20 }),
      open_questions: Type.Array(Type.String(), { maxItems: 20 }),
      ready_for_review: Type.Boolean(),
    }),
    async execute(_toolCallId, rawParams) {
      if (!refs.ticketIntakeDraftExecutor) {
        return { content: [{ type: "text", text: "No user-started ticket intake is active." }], details: { accepted: false } };
      }
      const response = await refs.ticketIntakeDraftExecutor({
        sessionId: refs.sessionIdRef.current,
        intakeId: String((rawParams as any).intake_id),
        expectedRevision: Number((rawParams as any).expected_revision),
        draft: normalizeTicketIntakeDraft(rawParams),
      });
      return { content: [{ type: "text", text: response.message }], details: { accepted: response.accepted } };
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: createTicketIntakeDraftTool,
  modes: ["channel"],
  available: (refs) => Boolean(refs.ticketIntakeDraftExecutor && !refs.delegation),
};
