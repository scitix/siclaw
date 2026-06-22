/**
 * channel_update — explicit agent-selected visible updates for IM channels.
 *
 * The tool only expresses intent. Runtime/Gateway owns per-channel policy:
 * whether to update the current card, send a new reply, coalesce, or suppress.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";

interface ChannelUpdateParams {
  kind?: "milestone" | "final" | "artifact";
  text?: string;
}

function result(text: string, delivered: boolean) {
  return {
    content: [{ type: "text" as const, text }],
    details: { delivered },
  };
}

export function createChannelUpdateTool(refs: ToolRefs): ToolDefinition {
  return {
    name: "channel_update",
    label: "Channel Update",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("channel_update")), 0, 0),
    renderResult: renderTextResult,
    description:
      "Send a concise user-visible update to the current IM channel when a long-running investigation has " +
      "a meaningful milestone, final conclusion, blocker, or artifact note. Do NOT use this for raw tool " +
      "output, internal task bookkeeping, retries, heartbeat text, or every small step. Gateway may coalesce, " +
      "update the existing card, suppress, or cap messages according to channel policy.",
    parameters: Type.Object({
      kind: Type.Optional(Type.Union([
        Type.Literal("milestone"),
        Type.Literal("final"),
        Type.Literal("artifact"),
      ], { description: "milestone for sparse progress, final for the user-facing conclusion, artifact for generated media notes." })),
      text: Type.String({ minLength: 1, description: "Concise visible update text. Keep milestone updates short." }),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ChannelUpdateParams;
      const text = params.text?.trim() ?? "";
      if (!text) return result("channel_update requires non-empty text.", false);
      if (!refs.channelMessageExecutor) return result("channel_update is not available in this runtime.", false);

      const delivered = await refs.channelMessageExecutor({
        sessionId: refs.sessionIdRef.current,
        kind: params.kind ?? "milestone",
        text,
      });
      return result(delivered.message, delivered.delivered);
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: createChannelUpdateTool,
  modes: ["channel"],
  platform: true,
  available: (refs) => Boolean(refs.channelMessageExecutor && refs.sessionIdRef),
};
