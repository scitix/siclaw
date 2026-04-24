/**
 * delegate_to_agents_async — fire-and-notify batch same-agent delegation.
 *
 * Starts 1-3 independent sub-agent investigations and returns immediately.
 * The runtime owns completion persistence and parent-agent notification.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  DelegateToAgentsAsyncExecutor,
  ToolEntry,
  ToolRefs,
} from "../../core/tool-registry.js";

export interface DelegateToAgentsAsyncTaskParams {
  agent_id?: string;
  scope: string;
  context_summary?: string;
}

export interface DelegateToAgentsAsyncToolParams {
  tasks: DelegateToAgentsAsyncTaskParams[];
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createDelegateToAgentsAsyncTool(
  refs: ToolRefs,
  executor: DelegateToAgentsAsyncExecutor = refs.delegateToAgentsAsyncExecutor!,
): ToolDefinition {
  return {
    name: "delegate_to_agents_async",
    label: "Delegate to Agents Async",
    description:
      "Start 1-3 independent same-agent sub-agent investigations in the background. " +
      "Use this in Deep Investigation when parallel evidence collection may take time. " +
      "The runtime will notify this parent session once the batch finishes; do not poll for results.",
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
    async execute(toolCallId, rawParams) {
      if (!executor) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: "delegate_to_agents_async is not available in this runtime.",
            }),
          }],
          details: { error: true },
        };
      }

      const rawTasks = (rawParams as Partial<DelegateToAgentsAsyncToolParams>).tasks;
      if (!Array.isArray(rawTasks) || rawTasks.length < 1 || rawTasks.length > 3) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: "delegate_to_agents_async requires 1 to 3 tasks.",
            }),
          }],
          details: { error: true },
        };
      }

      const tasks = rawTasks.map((task, i) => ({
        index: i + 1,
        agentId: cleanOptionalString(task?.agent_id) ?? "self",
        scope: cleanOptionalString(task?.scope),
        contextSummary: cleanOptionalString(task?.context_summary),
      }));
      const invalid = tasks.find((task) => !task.scope);
      if (invalid) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: `delegate_to_agents_async task ${invalid.index} requires a non-empty scope.`,
            }),
          }],
          details: { error: true },
        };
      }

      const result = await executor({
        delegationId: toolCallId,
        parentSessionId: refs.sessionIdRef.current,
        parentAgentId: refs.agentId,
        userId: refs.userId,
        tasks: tasks.map((task) => ({
          index: task.index,
          agentId: task.agentId,
          scope: task.scope!,
          ...(task.contextSummary ? { contextSummary: task.contextSummary } : {}),
        })),
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: {
          ...result,
          async: true,
        },
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: (refs) => createDelegateToAgentsAsyncTool(refs),
  modes: ["web", "channel", "cli"],
  available: (refs) => Boolean(refs.delegateToAgentsAsyncExecutor),
  requiresUserApproval: true,
};
