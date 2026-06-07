/**
 * spawn_subagent — delegate one bounded task to an isolated sub-agent (design §6).
 *
 * One call = one child. The model fans out by emitting N calls in a single turn
 * (pi 0.73 runs them concurrently). Foreground/blocking: the child's report is
 * returned inline as this tool's result. The child runs the same agent core under
 * the selected agent-type, cannot spawn its own sub-agents (no recursion), and
 * shares the parent's task ledger via taskListId.
 *
 * The spawning runtime is injected via ToolRefs.spawnSubagentExecutor; until it is
 * present this tool is hidden so the model never sees a non-working tool.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { ToolEntry, ToolRefs, SpawnSubagentResult } from "../../core/tool-registry.js";
import { getSubagentType, listSubagentTypes, DEFAULT_SUBAGENT_TYPE, RUN_IN_BACKGROUND_ENABLED } from "../../core/subagent-registry.js";

interface SpawnSubagentParams {
  description: string;
  prompt: string;
  subagent_type?: string;
  run_in_background?: boolean;
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: true, message }) }],
    details: { error: true },
  };
}

function buildDescription(): string {
  const lines = listSubagentTypes().map((t) => `- ${t.agentType}: ${t.whenToUse}`);
  return (
    "Launch an isolated sub-agent to handle ONE bounded job and get its findings back. Use it to " +
    "run independent work in parallel — emit several spawn_subagent calls in a single turn — or to keep a " +
    "large investigation's raw output out of your own context. Do NOT use it for a lone lookup you'd do " +
    "in one tool call — but the same lookup needed across several targets at once IS a fan-out (the main " +
    "agent runs one thing at a time, so concurrency goes to sub-agents). Never redo work a sub-agent is " +
    "already doing.\n\n" +
    "Writing the prompt: the sub-agent starts fresh and sees ONLY your prompt — brief it like a smart " +
    "colleague who just walked in. State the goal and why it matters, what you already know or have ruled " +
    "out, the exact target/scope, and what evidence to report back. For a lookup, hand over the exact " +
    "command; for an investigation, hand over the question. Terse command-style prompts produce shallow, " +
    "generic work. Never delegate understanding — don't write 'based on your findings, decide X'; give " +
    "concrete targets, paths, and what to check.\n\n" +
    "Sub-agents cannot spawn their own sub-agents (one level deep)." +
    (RUN_IN_BACKGROUND_ENABLED
      ? " With run_in_background you get an automatic completion notification carrying the sub-agent's result — " +
        "after launching, just END YOUR TURN (or do other independent work). Never poll it, never spawn another " +
        "sub-agent to 'wait for' it, and never fabricate its result; report to the user only when the " +
        "notification arrives. If you actually need the result before you can continue, use the FOREGROUND form " +
        "(omit run_in_background) instead — that blocks and returns the result inline."
      : "") +
    "\n\nAvailable subagent_type values:\n" +
    lines.join("\n")
  );
}

export function createSpawnSubagentTool(
  refs: ToolRefs,
  executor = refs.spawnSubagentExecutor,
): ToolDefinition {
  return {
    name: "spawn_subagent",
    label: "Spawn Sub-agent",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("spawn_subagent")), 0, 0),
    renderResult: renderTextResult,
    description: buildDescription(),
    parameters: Type.Object({
      description: Type.String({ description: "Short (3-5 word) label for the task" }),
      prompt: Type.String({
        minLength: 1,
        description: "The full task briefing for the sub-agent (it has no other context).",
      }),
      subagent_type: Type.Optional(Type.String({
        description: `Which sub-agent type to use. Default: ${DEFAULT_SUBAGENT_TYPE}.`,
      })),
      // run_in_background is gated OFF (RUN_IN_BACKGROUND_ENABLED) until background jobs notify the
      // parent model on completion — until then it's foreground-only (see subagent-registry).
      ...(RUN_IN_BACKGROUND_ENABLED
        ? {
            run_in_background: Type.Optional(Type.Boolean({
              description:
                "Run the sub-agent in the background instead of waiting. A completion notification with its result " +
                "arrives automatically — do NOT poll and do NOT spawn another sub-agent to wait for it. Use ONLY " +
                "for genuinely independent work you can proceed without; if you need the result before continuing, " +
                "omit this (foreground) so it returns inline. Returns a job_id you can pass to job_stop to cancel it.",
            })),
          }
        : {}),
    }),
    async execute(toolCallId, rawParams, signal, onUpdate) {
      if (!executor) return errorResult("spawn_subagent is not available in this runtime.");

      const p = rawParams as Partial<SpawnSubagentParams>;
      const description = p.description?.trim();
      const prompt = p.prompt?.trim();
      if (!description || !prompt) {
        return errorResult("spawn_subagent requires non-empty description and prompt.");
      }

      const type = getSubagentType(p.subagent_type);
      if (!type) {
        const valid = listSubagentTypes().map((t) => t.agentType).join(", ");
        return errorResult(`Unknown subagent_type "${p.subagent_type}". Valid types: ${valid}.`);
      }

      // Stream the child's live activity to the UI: each progress update becomes a
      // tool_execution_update the AgentWorkCard renders (status, tool trace, activity).
      const onProgress = onUpdate
        ? (progress: { status: string; toolCalls: number; steps: unknown[]; activity?: string }) =>
            onUpdate({
              content: [{ type: "text" as const, text: progress.activity ?? `Working… ${progress.toolCalls} tool calls` }],
              details: {
                status: progress.status,
                tool_calls: progress.toolCalls,
                steps: progress.steps,
                activity: progress.activity,
              },
            })
        : undefined;

      const result = await executor({
        description,
        prompt,
        subagentType: type.agentType,
        runInBackground: RUN_IN_BACKGROUND_ENABLED && p.run_in_background === true,
        parentSessionId: refs.sessionIdRef.current,
        parentAgentId: refs.agentId,
        userId: refs.userId,
        taskListId: refs.taskListId,
        spawnId: toolCallId,
      }, onProgress, signal);

      return toToolOutput(result);
    },
  };
}

function toToolOutput(result: SpawnSubagentResult) {
  if (result.status === "launched") {
    const modelVisible = {
      status: "launched" as const,
      job_id: result.jobId,
      message:
        "Sub-agent launched in the background. END YOUR TURN NOW unless you have OTHER independent work to do " +
        "right now — do NOT poll it, do NOT sleep/wait, and do NOT spawn another sub-agent or call any tool whose " +
        "purpose is to 'wait for', 'check on', or 'get the result of' this job. There is nothing to wait for: a " +
        "completion notification carrying the result will arrive on its own, and you report to the user THEN. " +
        "Tell the user in plain language what is running; do NOT show them this job_id (use it only with job_stop to cancel).",
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(modelVisible) }],
      details: { ...modelVisible, child_session_id: result.childSessionId },
    };
  }

  const modelVisible = {
    status: result.status,
    summary: result.summary,
    tool_calls: result.toolCalls,
    duration_ms: result.durationMs,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(modelVisible) }],
    details: {
      ...modelVisible,
      child_session_id: result.childSessionId,
      ...(result.steps ? { steps: result.steps } : {}),
      ...(result.fullSummary ? { full_summary: result.fullSummary } : {}),
      ...(result.partialSource ? { partial_source: result.partialSource } : {}),
      ...(result.interruptedTool ? { interrupted_tool: result.interruptedTool } : {}),
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: (refs) => createSpawnSubagentTool(refs),
  modes: ["web", "channel", "cli"],
  // platform: a core capability — exempt from allowedTools workspace filtering
  // (like task_*), so it's never silently hidden when an agent has a whitelist.
  platform: true,
  available: (refs) => Boolean(refs.spawnSubagentExecutor),
  requiresUserApproval: true,
};
