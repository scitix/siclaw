/**
 * request_input — a delegated worker signals it needs a human clarification
 * before it can continue (the "input-required" state, design agent-delegation.md
 * §6 / war-room §5.7 / §6-D).
 *
 * Transport model (turn-based, no suspend primitive): the tool emits an
 * `input_required` event onto the session's extra-event bus, which the runtime
 * relays over `chat.event` to the coordinator. The worker then ENDS its turn
 * normally (the coordinator sees `prompt_done` right after). The coordinator
 * relays the question to a human; when the human answers, the coordinator sends
 * the answer as the NEXT `chat.send` on the SAME sessionId — the worker's
 * pi-agent session (JSONL) preserves full context, so it resumes seamlessly.
 * There is no held/suspended brain: "resume" is just the next turn.
 *
 * The `input_required` event lets the coordinator DISCRIMINATE a genuine question
 * from a final answer (§6-D) — without it, every worker turn ending in a question
 * would be ambiguous.
 *
 * Exposed ONLY on a delegated turn; tagged readOnlyDelegable so it survives the
 * read-only filter. Use sparingly — prefer reporting what's missing in
 * report_findings.residual_state over blocking on a question.
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
  return {
    name: "request_input",
    label: "Request Input",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("request_input")), 0, 0),
    renderResult: renderTextResult,
    description:
      "Ask the coordinator for a human clarification you genuinely cannot proceed without. State ONE " +
      "specific question. After calling this, STOP and end your turn — the answer will arrive as the next " +
      "message in this same conversation, and you continue from there. Prefer reporting a gap in " +
      "report_findings over asking; use this only for a hard blocker.",
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
      if (!refs.sessionEventEmitter || !refs.delegation) {
        return result("request_input is not available in this context.", false);
      }
      refs.sessionEventEmitter({
        type: "input_required",
        delegationId: refs.delegation.delegationId,
        question,
      });
      return result("Question sent to the coordinator. End your turn now; the answer arrives as the next message.", true);
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: createRequestInputTool,
  available: (refs) => Boolean(refs.delegation && refs.sessionEventEmitter),
  readOnlyDelegable: true,
};
