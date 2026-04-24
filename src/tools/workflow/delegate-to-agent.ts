/**
 * delegate_to_agent — generic, permission-gated agent delegation contract.
 *
 * The actual spawning/runtime bridge is injected via ToolRefs. Until the
 * runtime provides that executor, this registration is hidden by `available`
 * so the LLM does not see or call a non-working tool.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  DelegateToAgentExecutor,
  DelegateToAgentResult,
  DelegateToAgentStatus,
  DelegateToAgentToolTraceEntry,
  ToolEntry,
  ToolRefs,
} from "../../core/tool-registry.js";

export interface DelegateToAgentToolParams {
  agent_id: string;
  scope: string;
  context_summary?: string;
}

export interface DelegateToAgentToolResult {
  status: DelegateToAgentStatus;
  summary: string;
  tool_calls: number;
  duration_ms: number;
}

export interface DelegateToAgentToolDetails extends DelegateToAgentToolResult {
  session_id: string;
  full_summary?: string;
  summary_truncated?: boolean;
  tool_trace?: DelegateToAgentToolTraceEntry[];
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toToolResult(result: DelegateToAgentResult): DelegateToAgentToolResult {
  return {
    status: result.status ?? "done",
    summary: result.summary,
    tool_calls: result.toolCalls,
    duration_ms: result.durationMs,
  };
}

function toToolDetails(result: DelegateToAgentResult): DelegateToAgentToolDetails {
      return {
        ...toToolResult(result),
        session_id: result.sessionId,
        ...(result.fullSummary ? { full_summary: result.fullSummary } : {}),
        ...(result.summaryTruncated != null ? { summary_truncated: result.summaryTruncated } : {}),
        ...(result.toolTrace ? { tool_trace: result.toolTrace } : {}),
      };
}

export function createDelegateToAgentTool(
  refs: ToolRefs,
  executor: DelegateToAgentExecutor = refs.delegateToAgentExecutor!,
): ToolDefinition {
  return {
    name: "delegate_to_agent",
    label: "Delegate to Agent",
    description:
      "Delegate one focused investigation task to a same-agent sub-agent. " +
      "Use this for expensive/background investigation only when it materially improves the answer. " +
      "Use agent_id='self' for the current single-agent DP flow. " +
      "Non-self expert agents are reserved for a future gateway-routed multi-agent bridge.",
    parameters: Type.Object({
      agent_id: Type.String({
        description:
          "Target agent id. Use 'self' for the current same-agent sub-session flow.",
      }),
      scope: Type.String({
        minLength: 1,
        description:
          "A specific, bounded task for the delegated agent. Include success criteria and what evidence to collect.",
      }),
      context_summary: Type.Optional(Type.String({
        description:
          "Optional tight summary of only the context the delegated agent needs. Prefer concise, evidence-bearing context over transcript dumps.",
      })),
    }),
    async execute(_toolCallId, rawParams) {
      if (!executor) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: "delegate_to_agent is not available in this runtime.",
            }),
          }],
          details: { error: true },
        };
      }

      const params = rawParams as Partial<DelegateToAgentToolParams>;
      const agentId = cleanOptionalString(params.agent_id);
      const scope = cleanOptionalString(params.scope);
      const contextSummary = cleanOptionalString(params.context_summary);

      if (!agentId || !scope) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: "delegate_to_agent requires non-empty agent_id and scope.",
            }),
          }],
          details: { error: true },
        };
      }

      const result = await executor({
        agentId,
        scope,
        contextSummary,
        parentSessionId: refs.sessionIdRef.current,
        parentAgentId: refs.agentId,
        userId: refs.userId,
        delegationId: _toolCallId,
      });

      const toolResult = toToolResult(result);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(toolResult) }],
        details: toToolDetails(result),
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: (refs) => createDelegateToAgentTool(refs),
  modes: ["web", "channel", "cli"],
  available: (refs) => Boolean(refs.delegateToAgentExecutor),
  requiresUserApproval: true,
};
