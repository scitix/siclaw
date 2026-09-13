/**
 * Transfers the main conversation to an authorized destination. The tool emits
 * handoff_requested and ends this turn; the control plane validates the target,
 * changes the executor and restores the same conversation at the destination.
 * Only control-plane turns with handoff support expose it. Subagents and
 * standalone sessions cannot transfer the main conversation.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";
import { handoffRefusal } from "../../shared/agent-handoff.js";

interface TransferParams {
  route_key?: string;
  brief?: string;
  new_evidence?: string;
}

function result(text: string, transferred: boolean) {
  return {
    content: [{ type: "text" as const, text }],
    details: { transferred },
    terminate: transferred,
  };
}

export function createTransferToAgentTool(refs: ToolRefs): ToolDefinition {
  const targets = refs.handoffTargets ?? [];
  return {
    name: "transfer_to_agent",
    label: "Transfer Conversation",
    executionMode: "sequential",
    description:
      "Hand this conversation over when an authorized destination is better suited to continue the user's " +
      "request. First call search_handoff_targets with the cluster, host or capability to obtain matching " +
      "destinations and coverage evidence. Use a route_key returned by that search. Agent names and list order alone are not evidence of capability. These are configured " +
      "allowances and binding names, not proof of live tool health, published skill content or network reachability. " +
      "If the target or capability is ambiguous, ask for the missing detail instead of guessing or trying agents " +
      "one by one. If no destination offers a concrete way forward, explain what is missing and ask " +
      "a focused clarification. Not knowing the answer is not itself a reason to transfer. Continue yourself when you can handle the request; do not transfer merely because another " +
      "agent exists.\n\n" +
      "This is a TRANSFER, not a delegation: after you call this, the destination owns the conversation and " +
      "answers the user directly. You will not be asked to summarise anything, and there is no result coming " +
      "back to you. Call this tool ALONE, never in the same batch as another tool. A successful call ends " +
      "your execution automatically; do not produce a closing message or repeat the call. Before calling, " +
      "you may briefly tell the user what you are checking, without explaining internal routing.\n\n" +
      "`brief` is what the destination reads as its instruction. It has the full conversation history, so do " +
      "not retell it — state what needs doing and anything you already established (the exact cluster/host, " +
      "what you already ruled out).\n\n" +
      "A return to an agent that already participated requires new_evidence: cite a newly verified finding " +
      "and explain why it lets that agent proceed. Rewording the request, uncertainty, or the same failure " +
      "is not new evidence.\n\n" +
      (refs.handoffPolicy ? `Remaining transfers in this request: ${refs.handoffPolicy.remaining}. If an agent already participated in this request; returning requires new_evidence.\n` : ""),
    parameters: Type.Object({
      new_evidence: Type.Optional(Type.String({ minLength: 1, description: "Required when returning to an agent that already participated: new verified evidence and why that agent can now make progress. Omit for a first visit." })),
      route_key: Type.String({ minLength: 1, description: "Exact routeKey returned by search_handoff_targets. Do not invent a target." }),
      brief: Type.String({
        minLength: 1,
        description:
          "The instruction for the destination agent: what to do, plus the specific entities and anything you " +
          "have already established. Not a recap of the conversation — it can see that.",
      }),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as TransferParams;
      const routeKey = params.route_key?.trim() ?? "";
      const brief = params.brief?.trim() ?? "";
      if (!refs.handoffSupported || !refs.searchHandoffTargets || !refs.sessionEventEmitter || targets.length === 0) {
        return result("transfer_to_agent is not available in this context.", false);
      }
      if (!routeKey || !brief) {
        return result("transfer_to_agent requires both `route_key` and `brief`.", false);
      }
      const target = targets.find((t) => t.routeKey.toLowerCase() === routeKey.toLowerCase());
      const discovered = refs.handoffSearchMatches?.get(routeKey.toLowerCase());
      if (!target || !discovered || discovered.id !== target.id) {
        return result("Search for the exact resource or required capability with search_handoff_targets before transferring. Use a returned routeKey; do not guess destinations.", false);
      }

      const evidence = typeof params.new_evidence === "string" ? params.new_evidence.trim() : "";
      const refusal = handoffRefusal(refs.handoffPolicy, target.id, evidence);
      if (refusal) return result(refusal, false);
      const traceContext = refs.getHandoffTraceContext?.(_toolCallId);

      // 丢掉本地副本。交出去之后这个 box 对这段会话不再有发言权,留着只会在它某天
      // 又被交回来时,拿一份缺了中间几轮的陈旧上下文去接 —— 而控制面那边是全的。
      // 先持久化失效标记；失败时不发出交接事件。
      try {
        await refs.evictSessionContext?.();
      } catch (err) {
        console.warn("[transfer_to_agent] could not evict the local session context:", err);
        return result("Cannot safely invalidate local context. Handoff was not started.", false);
      }
      refs.sessionEventEmitter({ type: "handoff_requested", targetAgentId: target.id, brief, ...(evidence ? { newEvidence: evidence } : {}), ...(traceContext ? { traceContext } : {}) });

      return result(`Conversation handed to ${target.name}. Execution yielded to the destination.`, true);
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: createTransferToAgentTool,
  modes: ["web", "channel", "task"],
  available: (refs) =>
    Boolean(refs.handoffPolicy?.remaining !== 0 && refs.handoffSupported && refs.searchHandoffTargets && refs.sessionEventEmitter && (refs.handoffTargets?.length ?? 0) > 0 && !refs.isSubagent),
  requiresUserApproval: false,
};
