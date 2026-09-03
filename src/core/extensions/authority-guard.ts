/**
 * Authority guard — enforces the management plane's AuthorityEnvelope at the
 * TOOL-EXECUTION layer, on every call (not once at dispatch):
 *
 *   - a tool matching deniedCapabilities is blocked unconditionally;
 *   - a tool whose DECLARED EFFECT exceeds the envelope's `effectCeiling` is
 *     gated, as is a tool outside a non-empty `allowedCapabilities`;
 *   - a `credential_read` tool is blocked outright and is never gated — no
 *     approval issued through the proposal flow authorises reading a secret;
 *   - a gated tool runs only when the call carries the `approval_proposal_id` of
 *     an approved proposal whose recorded action digest matches the call about to
 *     be made. The consumption is atomic on the control plane, so a retried call
 *     can never execute twice.
 *
 * TWO EARLIER DESIGN FAULTS THIS FIXES.
 *
 * (1) The ceiling was unenforceable. Gating happened only when
 * `allowedCapabilities` was non-empty, so an envelope with
 * `effectCeiling: "observe"` and no allow-list permitted every tool including
 * `bash`. The ceiling now stands on its own, compared against each tool's
 * declared effect (shared/tool-effects.ts); the allow-list narrows FURTHER
 * rather than switching enforcement on.
 *
 * (2) An approval was a bearer token. A signed receipt was minted, delivered
 * inside a natural-language resume message — entering the model context, the
 * transcript and the dispatch outbox — and accepted for ANY gated tool, so an
 * approval for "scale A" authorised one call to "delete B". There is no token
 * now: the id is plain text (not a credential) and the guard binds the
 * consumption to the ACTION by recomputing its digest from the arguments the
 * tool is about to run with.
 *
 * The envelope is verified and bound to this request before this extension is
 * even registered (invalid or misbound envelope ⇒ the turn is refused).
 * Capability lists and the ceiling are authored by the control plane.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesCapability, type AuthorityEnvelopeClaims } from "../../shared/authority-envelope.js";
import { actionDigest } from "../../shared/action-digest.js";
import { effectExceedsCeiling } from "../../shared/tool-effects.js";
import { effectForTool } from "../tool-registry.js";

export interface AuthorityGuardDeps {
  claims: AuthorityEnvelopeClaims;
  /**
   * Consumes an approved proposal on the control plane (atomic), for THIS exact
   * action. Resolves when the proposal was approved, unconsumed, and its
   * recorded digest matches `actionDigest`; rejects on any failure — not
   * approved, already consumed, expired, or approved for a DIFFERENT action —
   * and the tool call is then blocked.
   */
  consumeApproval: (req: { proposalId: string; actionDigest: string }) => Promise<void>;
}

// Tools the guard itself must never gate: ending a turn to ask for approval or
// input has to stay possible under ANY ceiling, or a gated agent deadlocks.
const ALWAYS_ALLOWED = new Set(["propose_execution", "request_input", "report_findings"]);

export default function authorityGuardExtension(api: ExtensionAPI, deps: AuthorityGuardDeps): void {
  const { claims } = deps;
  api.on("tool_call", async (event: any) => {
    const toolName: string = String(event?.toolName ?? event?.name ?? "");
    if (!toolName || ALWAYS_ALLOWED.has(toolName)) return {};
    if (matchesCapability(claims.deniedCapabilities, toolName)) {
      return {
        block: true,
        reason:
          `The tool "${toolName}" is denied by this task's authority envelope ` +
          `(effect ceiling: ${claims.effectCeiling}). Do not retry it; work within the allowed capabilities.`,
      };
    }

    const effect = effectForTool(toolName);
    // Reading a credential is not a point on the effect scale, so it is not
    // something an approval can raise the ceiling for. Blocked, never gated.
    if (effect === "credential_read") {
      return {
        block: true,
        reason:
          `The tool "${toolName}" reads credentials, which this task's authority envelope never permits ` +
          "(no approval can authorise it). Do not retry it.",
      };
    }

    const exceedsCeiling = effectExceedsCeiling(effect, claims.effectCeiling);
    const outsideAllowList = Boolean(claims.allowedCapabilities?.length)
      && !matchesCapability(claims.allowedCapabilities, toolName);
    if (!exceedsCeiling && !outsideAllowList) return {};

    // ── gated: an approved, action-bound proposal is required ────────────────
    const why = exceedsCeiling
      ? `its effect (${effect}) exceeds this task's effect ceiling (${claims.effectCeiling})`
      : "it is outside this task's allowed capabilities";
    const proposalId = extractProposalId(event);
    if (!proposalId) {
      return {
        block: true,
        reason:
          `The tool "${toolName}" requires approval because ${why}: ` +
          "call propose_execution with the exact change, end your turn, and re-invoke this tool with the " +
          "approval_proposal_id from the decision message.",
      };
    }
    // Strip BEFORE digesting: the id is the guard's control field, not part of
    // the approved action, and the proposal's digest was computed without it.
    // pi-agent's tool_call event exposes `input` as MUTABLE (see ToolCallEvent
    // docs), which is what lets the id be removed before the tool, its output
    // and the transcript ever see it.
    stripProposalId(event);
    try {
      await deps.consumeApproval({ proposalId, actionDigest: actionDigest(toolName, event?.input) });
    } catch (err) {
      return {
        block: true,
        reason:
          "The approval was not accepted (" +
          (err instanceof Error ? err.message : String(err)) +
          "). An approval is one-time, expires, and covers only the exact change it was granted for; " +
          "if the change is still needed, propose it again.",
      };
    }
    return {};
  });
}

/**
 * The approved proposal's id travels as an `approval_proposal_id` argument on
 * the gated call. It is an identifier, not a credential: possession alone
 * authorises nothing, because the control plane checks that the proposal was
 * approved AND that its recorded digest matches the action being attempted.
 */
function extractProposalId(event: any): string {
  const args = event?.input;
  const id = args && typeof args === "object" ? (args as Record<string, unknown>).approval_proposal_id : undefined;
  return typeof id === "string" ? id.trim() : "";
}

function stripProposalId(event: any): void {
  const args = event?.input;
  if (args && typeof args === "object") {
    delete (args as Record<string, unknown>).approval_proposal_id;
  }
}
