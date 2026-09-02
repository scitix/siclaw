/**
 * Authority guard — enforces the management plane's AuthorityEnvelope at the
 * TOOL-EXECUTION layer, on every call (not once at dispatch):
 *
 *   - a tool matching deniedCapabilities is blocked unconditionally;
 *   - when allowedCapabilities is present, a tool OUTSIDE it is gated: it runs
 *     only when the call carries a one-time `approval_receipt` argument, which
 *     is consumed ATOMICALLY on the control plane right before execution — a
 *     retried call can never execute twice.
 *
 * The envelope is verified before this extension is even registered (invalid
 * envelope ⇒ the turn is refused); the guard only matches names and consumes
 * receipts. Capability lists are authored by the control plane.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesCapability, type AuthorityEnvelopeClaims } from "../../shared/authority-envelope.js";

export interface AuthorityGuardDeps {
  claims: AuthorityEnvelopeClaims;
  /**
   * Consumes a one-time receipt on the control plane (atomic). Resolves when
   * the receipt was consumed by THIS call; rejects on any failure — expired,
   * already consumed, proposal changed — and the tool call is then blocked.
   */
  consumeReceipt: (receipt: string) => Promise<void>;
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
    if (claims.allowedCapabilities?.length && !matchesCapability(claims.allowedCapabilities, toolName)) {
      const receipt = extractReceipt(event);
      if (!receipt) {
        return {
          block: true,
          reason:
            `The tool "${toolName}" is outside this task's allowed capabilities and requires approval: ` +
            "call propose_execution with the exact change, end your turn, and re-invoke this tool with the " +
            "approval_receipt from the decision message.",
        };
      }
      try {
        await deps.consumeReceipt(receipt);
        // The receipt is consumed; strip it from the (mutable) tool input so it
        // never reaches the tool, its output, or the transcript.
        stripReceipt(event);
      } catch (err) {
        return {
          block: true,
          reason:
            "The approval receipt was not accepted (" +
            (err instanceof Error ? err.message : String(err)) +
            "). A receipt is one-time and expires; if the change is still needed, propose it again.",
        };
      }
    }
    return {};
  });
}

/**
 * The receipt travels as an `approval_receipt` argument on the gated call.
 * pi-agent's tool_call event exposes `input` (mutable — see ToolCallEvent docs).
 */
function extractReceipt(event: any): string {
  const args = event?.input;
  const receipt = args && typeof args === "object" ? (args as Record<string, unknown>).approval_receipt : undefined;
  return typeof receipt === "string" ? receipt.trim() : "";
}

function stripReceipt(event: any): void {
  const args = event?.input;
  if (args && typeof args === "object") {
    delete (args as Record<string, unknown>).approval_receipt;
  }
}
