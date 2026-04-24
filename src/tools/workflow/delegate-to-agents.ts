/**
 * delegate_to_agents — batch same-agent delegation.
 *
 * This is the pragmatic bridge between a single synchronous tool call and a
 * future durable async agent-work runtime: one parent tool call fans out 1-3
 * independent sub-agent prompts concurrently, then returns budgeted capsules
 * to the parent model and persists full reports in tool details for the UI.
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

export interface DelegateToAgentsTaskParams {
  agent_id?: string;
  scope: string;
  context_summary?: string;
}

export interface DelegateToAgentsToolParams {
  tasks: DelegateToAgentsTaskParams[];
}

export interface DelegateToAgentsToolTaskResult {
  index: number;
  status: DelegateToAgentStatus;
  agent_id: string;
  scope: string;
  summary: string;
  tool_calls: number;
  duration_ms: number;
}

export interface DelegateToAgentsToolResult {
  status: DelegateToAgentStatus;
  tasks: DelegateToAgentsToolTaskResult[];
  total_tool_calls: number;
  duration_ms: number;
}

export interface DelegateToAgentsToolTaskDetails extends DelegateToAgentsToolTaskResult {
  session_id?: string;
  full_summary?: string;
  summary_truncated?: boolean;
  tool_trace?: DelegateToAgentToolTraceEntry[];
  error?: string;
}

export interface DelegateToAgentsToolDetails extends DelegateToAgentsToolResult {
  tasks: DelegateToAgentsToolTaskDetails[];
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toTaskResult(
  index: number,
  params: { agentId: string; scope: string },
  result: DelegateToAgentResult,
): DelegateToAgentsToolTaskResult {
  return {
    index,
    status: result.status ?? "done",
    agent_id: params.agentId,
    scope: params.scope,
    summary: result.summary,
    tool_calls: result.toolCalls,
    duration_ms: result.durationMs,
  };
}

function toTaskDetails(
  taskResult: DelegateToAgentsToolTaskResult,
  result: DelegateToAgentResult,
): DelegateToAgentsToolTaskDetails {
  return {
    ...taskResult,
    ...(result.sessionId ? { session_id: result.sessionId } : {}),
    ...(result.fullSummary ? { full_summary: result.fullSummary } : {}),
    ...(result.summaryTruncated != null ? { summary_truncated: result.summaryTruncated } : {}),
    ...(result.toolTrace ? { tool_trace: result.toolTrace } : {}),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function batchStatus(results: DelegateToAgentsToolTaskResult[]): DelegateToAgentStatus {
  if (results.some((result) => result.status === "failed")) return "failed";
  if (results.some((result) => result.status === "timed_out")) return "timed_out";
  return "done";
}

export function createDelegateToAgentsTool(
  refs: ToolRefs,
  executor: DelegateToAgentExecutor = refs.delegateToAgentExecutor!,
): ToolDefinition {
  return {
    name: "delegate_to_agents",
    label: "Delegate to Agents",
    description:
      "Run 1-3 independent, focused investigation tasks concurrently with same-agent sub-agents. " +
      "Use this when the user asks for multiple sub-agents or when parallel evidence collection would materially reduce latency. " +
      "Use agent_id='self' unless a future gateway-routed expert-agent bridge is explicitly available.",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          agent_id: Type.Optional(Type.String({
            description: "Target agent id. Use 'self' for the current same-agent sub-session flow.",
          })),
          scope: Type.String({
            minLength: 1,
            description:
              "A specific, bounded task for this delegated agent. Include success criteria and evidence to collect.",
          }),
          context_summary: Type.Optional(Type.String({
            description:
              "Optional tight summary of only the context this delegated agent needs.",
          })),
        }),
        {
          minItems: 1,
          maxItems: 3,
          description: "One to three independent tasks that can run concurrently.",
        },
      ),
    }),
    async execute(_toolCallId, rawParams) {
      if (!executor) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: "delegate_to_agents is not available in this runtime.",
            }),
          }],
          details: { error: true },
        };
      }

      const rawTasks = (rawParams as Partial<DelegateToAgentsToolParams>).tasks;
      if (!Array.isArray(rawTasks) || rawTasks.length < 1 || rawTasks.length > 3) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: "delegate_to_agents requires 1 to 3 tasks.",
            }),
          }],
          details: { error: true },
        };
      }

      const tasks = rawTasks.map((task, i) => {
        const agentId = cleanOptionalString(task?.agent_id) ?? "self";
        const scope = cleanOptionalString(task?.scope);
        const contextSummary = cleanOptionalString(task?.context_summary);
        return { index: i + 1, agentId, scope, contextSummary };
      });

      const invalid = tasks.find((task) => !task.scope);
      if (invalid) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: `delegate_to_agents task ${invalid.index} requires a non-empty scope.`,
            }),
          }],
          details: { error: true },
        };
      }

      const startedAt = Date.now();
      const executions = await Promise.all(tasks.map(async (task) => {
        const taskStartedAt = Date.now();
        try {
          const result = await executor({
            agentId: task.agentId,
            scope: task.scope!,
            contextSummary: task.contextSummary,
            parentSessionId: refs.sessionIdRef.current,
            parentAgentId: refs.agentId,
            userId: refs.userId,
            delegationId: _toolCallId,
            taskIndex: task.index,
            totalTasks: tasks.length,
          });
          return { ok: true, task, result } as const;
        } catch (err) {
          return {
            ok: false,
            task,
            error: errorMessage(err),
            durationMs: Date.now() - taskStartedAt,
          } as const;
        }
      }));

      const taskResults = executions.map((execution) => {
        if (execution.ok) {
          return toTaskResult(
            execution.task.index,
            { agentId: execution.task.agentId, scope: execution.task.scope! },
            execution.result,
          );
        }
        return {
          index: execution.task.index,
          status: "failed" as const,
          agent_id: execution.task.agentId,
          scope: execution.task.scope!,
          summary: `Delegated agent failed: ${execution.error}`,
          tool_calls: 0,
          duration_ms: execution.durationMs,
        };
      });
      const details = executions.map((execution, i) => {
        const taskResult = taskResults[i]!;
        if (execution.ok) return toTaskDetails(taskResult, execution.result);
        return {
          ...taskResult,
          error: execution.error,
        } satisfies DelegateToAgentsToolTaskDetails;
      });
      const totalToolCalls = taskResults.reduce((sum, result) => sum + result.tool_calls, 0);
      const durationMs = Date.now() - startedAt;
      const toolResult: DelegateToAgentsToolResult = {
        status: batchStatus(taskResults),
        tasks: taskResults,
        total_tool_calls: totalToolCalls,
        duration_ms: durationMs,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(toolResult) }],
        details: {
          ...toolResult,
          tasks: details,
        } satisfies DelegateToAgentsToolDetails,
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: (refs) => createDelegateToAgentsTool(refs),
  modes: ["web", "channel", "cli"],
  available: (refs) => Boolean(refs.delegateToAgentExecutor),
  requiresUserApproval: true,
};
