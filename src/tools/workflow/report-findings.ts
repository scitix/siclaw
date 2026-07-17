/**
 * report_findings — the structured result-artifact hand-off for a DELEGATED turn.
 *
 * When a coordinator agent (e.g. the incident concierge) delegates a bounded
 * diagnostic task to this worker over the mesh, the worker's raw stream is
 * relayed to the user for transparency, but the coordinator's context must
 * receive a COMPACT structured result — not the full prose. This tool is that
 * load-bearing interface (design agent-delegation.md §6-B): the worker calls it
 * once near the end of its turn with {findings, actions_taken, residual_state};
 * the tool emits a `delegation_artifact` event onto the session's extra-event
 * bus, which the runtime relays verbatim over `chat.event` back to the
 * coordinator (no new SSE endpoint — same path spawn_subagent progress uses).
 *
 * Exposed ONLY on a delegated turn (see registration.available), and tagged
 * readOnlyDelegable so it survives the read-only delegation tool filter.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";

interface ReportFindingsParams {
  findings?: string;
  actions_taken?: string;
  residual_state?: string;
}

function result(text: string, delivered: boolean) {
  return {
    content: [{ type: "text" as const, text }],
    details: { delivered },
  };
}

export function createReportFindingsTool(refs: ToolRefs): ToolDefinition {
  return {
    name: "report_findings",
    label: "Report Findings",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("report_findings")), 0, 0),
    renderResult: renderTextResult,
    description:
      "Return the STRUCTURED result of this delegated task to the coordinator. Call this ONCE at the " +
      "very end, after you have gathered your evidence. The coordinator sees only this structured " +
      "artifact (not your raw steps), so make `findings` self-contained. Keep it compact — this is the " +
      "hand-off interface, not a transcript.",
    parameters: Type.Object({
      findings: Type.String({
        minLength: 1,
        description: "The diagnostic conclusion: what you found, with the key evidence. Self-contained.",
      }),
      actions_taken: Type.Optional(Type.String({
        description: "What you changed on the target (commands that mutated state, remediations applied). " +
          "REQUIRED if you took any action — the coordinator's structured artifact relies on this to know " +
          "what happened. Use \"none\" only for a genuinely read-only diagnosis.",
      })),
      residual_state: Type.Optional(Type.String({
        description: "Anything left unresolved / needing follow-up / that the coordinator should decide.",
      })),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ReportFindingsParams;
      const findings = params.findings?.trim() ?? "";
      if (!findings) return result("report_findings requires non-empty findings.", false);
      if (!refs.sessionEventEmitter || !refs.delegation) {
        return result("report_findings is not available in this context.", false);
      }
      refs.sessionEventEmitter({
        type: "delegation_artifact",
        delegationId: refs.delegation.delegationId,
        findings,
        // A delegated peer runs under its OWN capabilities (not forced read-only), so it
        // MAY have mutated state. Default to a neutral "not reported" when the peer omitted
        // this — never assert "none (read-only)", which would hide real actions from the
        // coordinator's structured artifact.
        actions_taken: params.actions_taken?.trim() || "not reported",
        residual_state: params.residual_state?.trim() || "",
      });
      return result("Findings reported to the coordinator.", true);
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: createReportFindingsTool,
  // Present only on a delegated turn (and only when the extra-event bus exists to
  // carry the artifact). readOnlyDelegable so it survives the read-only filter.
  available: (refs) => Boolean(refs.delegation && refs.sessionEventEmitter),
  readOnlyDelegable: true,
};
