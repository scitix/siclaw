/**
 * propose_execution — an agent proposes a WRITE action (external_write /
 * destructive) instead of performing it. The management plane records the
 * proposal, routes it through human approval, and — if approved — resumes this
 * same session with a one-time receipt the gated action is then re-invoked
 * with. Same turn-based transport as request_input: the tool emits a reliable
 * `auth_required` event, the agent ENDS its turn, and the decision arrives as
 * the next message on this session.
 *
 * The proposal must carry SPECIFICS — exact diff, target resources, risk and a
 * rollback path — because that is what the approver decides on. A proposal
 * without them is rejected client-side before it wastes an approval round.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";

interface ProposeExecutionParams {
  effect?: string;
  resources?: string[];
  diff?: unknown;
  reason?: string;
  risk?: string;
  rollback?: string;
}

function result(text: string, delivered: boolean) {
  return {
    content: [{ type: "text" as const, text }],
    details: { delivered },
  };
}

export function createProposeExecutionTool(refs: ToolRefs): ToolDefinition {
  return {
    name: "propose_execution",
    label: "Propose Execution",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("propose_execution")), 0, 0),
    renderResult: renderTextResult,
    description:
      "Propose a WRITE action (external_write or destructive) for human approval instead of executing it. " +
      "Provide the EXACT diff, the target resources, the risk level and a concrete rollback path — the approver " +
      "decides on these specifics. After calling this, STOP and end your turn. If approved, the next message in " +
      "this conversation carries a one-time receipt; re-invoke the gated action passing that receipt. If rejected, " +
      "this task ends — do not retry the same change.",
    parameters: Type.Object({
      effect: Type.Union([Type.Literal("external_write"), Type.Literal("destructive")], {
        description: "external_write: tickets/config/cluster objects. destructive: delete/evict/restart/overwrite.",
      }),
      resources: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Exact target resources, e.g. deployment://production-a/payments.",
      }),
      diff: Type.Unknown({
        description: "The exact change, machine-readable where possible, e.g. {\"replicas\":{\"from\":10,\"to\":12}}.",
      }),
      reason: Type.String({ minLength: 1, description: "Why this change is needed now." }),
      risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
      rollback: Type.String({ minLength: 1, description: "How to undo the change if it goes wrong." }),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ProposeExecutionParams;
      if (!refs.sessionEventEmitter || (!refs.delegation && refs.allowInputRequest !== true)) {
        return result("propose_execution is not available in this context.", false);
      }
      const effect = params.effect === "destructive" ? "destructive" : params.effect === "external_write" ? "external_write" : "";
      const reason = params.reason?.trim() ?? "";
      const rollback = params.rollback?.trim() ?? "";
      const resources = (params.resources ?? []).filter((r) => typeof r === "string" && r.trim());
      if (!effect || !reason || !rollback || resources.length === 0 || params.diff === undefined) {
        return result(
          "propose_execution requires effect, resources, diff, reason and rollback — the approver decides on specifics, not intentions.",
          false,
        );
      }
      refs.sessionEventEmitter({
        type: "auth_required",
        effect,
        resources,
        diff: params.diff,
        reason,
        risk: params.risk ?? "medium",
        rollback,
      });
      return result(
        "Proposal submitted for approval. End your turn now; the decision (with a one-time receipt if approved) arrives as the next message.",
        true,
      );
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: createProposeExecutionTool,
  available: (refs) => Boolean(refs.sessionEventEmitter && (refs.delegation || refs.allowInputRequest === true)),
  readOnlyDelegable: true,
};
