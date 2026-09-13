/**
 * request_input asks for human clarification on an explicitly opted-in
 * machine-driven turn. The control plane relays input_required to the caller;
 * the answer becomes the next turn on the same restored session.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

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
  const recipient = "the external caller";
  return {
    name: "request_input",
    label: "Request Input",
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
      if (!refs.sessionEventEmitter || refs.allowInputRequest !== true) {
        return result("request_input is not available in this context.", false);
      }
      refs.sessionEventEmitter({
        type: "input_required",
        question,
      });
      return result(`Question sent to ${recipient}. End your turn now; the answer arrives as the next message.`, true);
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: createRequestInputTool,
  available: (refs) => Boolean(refs.sessionEventEmitter && refs.allowInputRequest === true),
};
