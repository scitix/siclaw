/**
 * request_input — an agent signals that it needs human clarification before it
 * can continue. It is available either to a delegated peer or to a top-level
 * machine-driven turn that explicitly opts in (currently Sicore A2A).
 *
 * Transport model (turn-based, no suspend primitive): the tool emits an
 * `input_required` event onto the session's extra-event bus, which the runtime
 * relays over `chat.event`. The agent then ENDS its turn normally and the caller
 * sees `prompt_done` right after. A delegated coordinator or the A2A control
 * plane relays the question to a human; the answer arrives as the NEXT
 * `chat.send` on the SAME sessionId. The pi-agent JSONL preserves full context,
 * so there is no held brain: "resume" is the next turn on restored history.
 *
 * The `input_required` event lets the coordinator DISCRIMINATE a genuine question
 * from a final answer (§6-D) — without it, every worker turn ending in a question
 * would be ambiguous.
 *
 * Exposed on a delegated turn, or when a machine-driven top-level turn opts in
 * with `allowInputRequest`. Tagged readOnlyDelegable so it survives the
 * read-only filter.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";

interface RequestInputParams {
  question?: string;
}

function result(text: string, delivered: boolean) {
  return {
    content: [{ type: "text" as const, text }],
    details: { delivered },
  };
}

export function createRequestInputTool(refs: ToolRefs): ToolDefinition {
  const delegated = Boolean(refs.delegation);
  const recipient = delegated ? "the coordinator" : "the external caller";
  return {
    name: "request_input",
    label: "Request Input",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("request_input")), 0, 0),
    renderResult: renderTextResult,
    description:
      `Ask ${recipient} for a human clarification you genuinely cannot proceed without. State ONE ` +
      "specific question. After calling this, STOP and end your turn — the answer will arrive as the next " +
      "message in this same conversation, and you continue from there. Use this only for a hard blocker.",
    parameters: Type.Object({
      question: Type.String({
        minLength: 1,
        description: "The single, specific clarification you need in order to continue.",
      }),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as RequestInputParams;
      const question = params.question?.trim() ?? "";
      if (!question) return result("request_input requires a non-empty question.", false);
      if (!refs.sessionEventEmitter || (!refs.delegation && refs.allowInputRequest !== true)) {
        return result("request_input is not available in this context.", false);
      }
      refs.sessionEventEmitter({
        type: "input_required",
        ...(refs.delegation ? { delegationId: refs.delegation.delegationId } : {}),
        question,
      });
      return result(`Question sent to ${recipient}. End your turn now; the answer arrives as the next message.`, true);
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: createRequestInputTool,
  available: (refs) => Boolean(refs.sessionEventEmitter && (refs.delegation || refs.allowInputRequest === true)),
  readOnlyDelegable: true,
};
