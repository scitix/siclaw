/**
 * propose_execution — an agent proposes a WRITE action (external_write /
 * destructive) instead of performing it. The management plane records the
 * proposal, routes it through human approval, and — if approved — resumes this
 * same session with the approved proposal's ID, which the gated action is then
 * re-invoked with. Same turn-based transport as request_input: the tool emits a
 * reliable `auth_required` event, the agent ENDS its turn, and the decision
 * arrives as the next message on this session.
 *
 * The proposal must carry SPECIFICS — exact diff, target resources, risk and a
 * rollback path — because that is what the approver decides on. A proposal
 * without them is rejected client-side before it wastes an approval round.
 *
 * It must ALSO carry the exact call it intends (`tool_name` + `tool_args`), from
 * which the runtime computes an `actionDigest` and sends it with the proposal.
 * That is what makes an approval apply to ONE action: the guard recomputes the
 * digest from the arguments the tool is about to run with, so an approval for
 * "scale A" cannot be spent on "delete B". The proposal id that comes back is an
 * identifier, not a credential — holding it authorises nothing by itself.
 *
 * ⚠️ The management plane stores `actionDigest` OPAQUELY and never recomputes
 * it. Deliberate: recomputation there would require two languages to agree
 * forever on a canonical JSON encoding, and a silent disagreement would either
 * wave through mismatched actions or reject every legitimate one. One producer,
 * one encoder.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";
import { actionDigest } from "../../shared/action-digest.js";

interface ProposeExecutionParams {
  tool_name?: string;
  tool_args?: unknown;
  effect?: string;
  resources?: string[];
  diff?: unknown;
  reason?: string;
  risk?: string;
  rollback?: string;
  evidence_refs?: string[];
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
      "Provide the EXACT call you intend — `tool_name` and the complete `tool_args` you will pass — plus the " +
      "diff, the target resources, the risk level and a concrete rollback path: the approver decides on these " +
      "specifics, and the approval is bound to exactly this call. After calling this, STOP and end your turn. " +
      "If approved, the next message in this conversation carries an approval_proposal_id; re-invoke that SAME " +
      "tool with those SAME arguments plus approval_proposal_id=<id>. Changing the tool or any argument " +
      "invalidates the approval and you must propose again. If rejected, this task ends — do not retry the " +
      "same change.",
    parameters: Type.Object({
      tool_name: Type.String({
        minLength: 1,
        description: "The exact tool you will invoke once approved, e.g. \"bash\" or \"pod_exec\".",
      }),
      tool_args: Type.Unknown({
        description:
          "The COMPLETE arguments object you will pass to that tool, exactly as you will pass it. The approval " +
          "is bound to these arguments: any difference at re-invocation is rejected.",
      }),
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
      evidence_refs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        description: "References to the evidence behind this proposal (ids/URIs), so the approver can check it.",
      })),
      risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
      rollback: Type.String({ minLength: 1, description: "How to undo the change if it goes wrong." }),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ProposeExecutionParams;
      // ONLY governed turns (allowInputRequest): the approval loop lives on the
      // management plane's task tracker. A legacy delegated turn has no consumer
      // for auth_required — the proposal would vanish while the model was told
      // it was submitted, which is worse than not offering the tool at all.
      if (!refs.sessionEventEmitter || refs.allowInputRequest !== true) {
        return result("propose_execution is not available in this context.", false);
      }
      const effect = params.effect === "destructive" ? "destructive" : params.effect === "external_write" ? "external_write" : "";
      const reason = params.reason?.trim() ?? "";
      const rollback = params.rollback?.trim() ?? "";
      const resources = (params.resources ?? []).filter((r) => typeof r === "string" && r.trim());
      const toolName = params.tool_name?.trim() ?? "";
      if (!effect || !reason || !rollback || resources.length === 0 || params.diff === undefined) {
        return result(
          "propose_execution requires effect, resources, diff, reason and rollback — the approver decides on specifics, not intentions.",
          false,
        );
      }
      // The exact call is required, not optional: without it the proposal cannot
      // be bound to an action, and an approval that is not bound to an action is
      // the bearer token this design exists to remove.
      if (!toolName || params.tool_args === undefined) {
        return result(
          "propose_execution requires tool_name and tool_args — the exact call you will make once approved. " +
          "The approval is bound to that call, so it cannot be issued against an intention.",
          false,
        );
      }
      // Computed HERE, by the only party that ever computes it. The management
      // plane stores it opaquely and compares bytes; the guard recomputes it from
      // the live arguments at re-invocation.
      const digest = actionDigest(toolName, params.tool_args);
      refs.sessionEventEmitter({
        type: "auth_required",
        effect,
        resources,
        diff: params.diff,
        reason,
        risk: params.risk ?? "medium",
        rollback,
        toolName,
        toolArgs: params.tool_args,
        actionDigest: digest,
        ...(params.evidence_refs?.length ? { evidenceRefs: params.evidence_refs } : {}),
      });
      return result(
        "Proposal submitted for approval. End your turn now; the decision arrives as the next message. If " +
        `approved it carries an approval_proposal_id — re-invoke ${toolName} with the SAME arguments plus ` +
        "approval_proposal_id=<id>; any change to the call invalidates the approval.",
        true,
      );
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: createProposeExecutionTool,
  // Unlike request_input, NOT available on legacy delegated turns: only the
  // management plane's task tracker consumes auth_required, so the tool exists
  // only where the loop can actually close. (The A2A delegation transport runs
  // the peer as a governed turn, so peers keep the tool there.)
  available: (refs) => Boolean(refs.sessionEventEmitter && refs.allowInputRequest === true),
  readOnlyDelegable: true,
};
