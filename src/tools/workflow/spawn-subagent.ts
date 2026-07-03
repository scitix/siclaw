/**
 * spawn_subagent — delegate 1..N bounded tasks to isolated sub-agents, with an optional
 * synthesis step (design v3 §"Tool layer (single entry)", single-tool merge).
 *
 * ONE tool, ONE semantics: a batch of `items` (the for-loop) rendered through a shared
 * `task_template`, plus an optional `reduce_prompt` that synthesises all per-item results into
 * one summary. A single task is just `items` of length 1 — there is no second way to delegate.
 *
 *  - N=1, no reduce_prompt → the runtime COLLAPSES to one legacy child run: foreground by
 *    default, live steps stream to the AgentWorkCard, events/delegation_id/notification are
 *    byte-identical to the pre-v3 single spawn.
 *  - N>1, or any reduce_prompt → the runtime runs the map→reduce group orchestration: children
 *    fan out through a bounded worker pool, results feed the reduce stage, and only the final
 *    summary (or per-item capsules when no reduce) returns to the parent context.
 *
 * The plan is validated + rendered HERE (call-layer, fail-fast) via validateAndRenderGroupPlan,
 * so a bad plan bounces back to the model before any child starts. The runtime is injected via
 * ToolRefs.spawnSubagentExecutor; until it is present this tool is hidden so the model never sees
 * a non-working tool (and children get no executor → no recursion).
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type {
  ToolEntry,
  ToolRefs,
  SpawnSubagentResult,
  SubagentGroupResult,
  SpawnSubagentProgress,
  SubagentGroupProgress,
} from "../../core/tool-registry.js";
import {
  getSubagentType,
  listSubagentTypes,
  DEFAULT_SUBAGENT_TYPE,
  getMaxGroupItems,
  RUN_IN_BACKGROUND_ENABLED,
  SUBAGENT_GROUP_ENABLED,
} from "../../core/subagent-registry.js";
import { validateAndRenderGroupPlan } from "../../agentbox/subagent-group.js";

interface SpawnSubagentParams {
  description: string;
  task_template?: string;
  items: Array<string | Record<string, string>>;
  reduce_prompt?: string;
  subagent_type?: string;
  run_in_background?: boolean;
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: true, message }) }],
    details: { error: true },
  };
}

/** Compact one-line rendering of an item for status lines / drill-in labels. */
function itemToText(item: string | Record<string, string>): string {
  return typeof item === "string" ? item : JSON.stringify(item);
}

function buildDescription(): string {
  const lines = listSubagentTypes().map((t) => `- ${t.agentType}: ${t.whenToUse}`);
  return (
    "Launch isolated sub-agent(s) to handle bounded work and get their findings back — one tool for " +
    "both a single task and a whole batch. You supply a list of `items` (the for-loop) rendered through " +
    "a shared `task_template`, and optionally a `reduce_prompt` that synthesises every per-item result " +
    "into ONE summary. Each item runs as its own isolated sub-agent that cannot spawn further sub-agents " +
    "(one level deep). Use it to run independent work concurrently, to run the SAME investigation across " +
    "many targets, or to keep a large investigation's raw output out of your own context. Never redo work " +
    "a sub-agent is already doing.\n\n" +
    "FAN OUT WITH items, NOT with repeated calls: to run work over several targets, put them all in ONE " +
    "spawn_subagent call's `items` — do NOT emit multiple spawn_subagent calls in the same turn. One call " +
    "= one approval + one orchestrated batch; N separate calls lose that and drift. Do NOT use it for a " +
    "lone lookup you'd do in a single tool call yourself — but the same lookup needed across several " +
    "targets at once IS a batch (the main agent runs one thing at a time, so concurrency goes to sub-agents).\n\n" +
    "Examples:\n" +
    "- Single task: items: [\"Check disk usage on node-01 and report the top offenders.\"] (one complete " +
    "briefing; runs foreground and returns its findings inline).\n" +
    "- Batch (same task × N targets): task_template: \"Find the root cause of {{item}} crashing and report " +
    "evidence.\", items: [\"web-1\",\"web-2\",\"web-3\"], reduce_prompt: \"Group the causes into " +
    "network/storage/other.\" (runs each pod as its own sub-agent, then synthesises).\n" +
    "- Heterogeneous batch: task_template: \"Investigate {{pod}} in namespace {{ns}}.\", items: " +
    "[{\"pod\":\"web-1\",\"ns\":\"prod\"},{\"pod\":\"api-2\",\"ns\":\"staging\"}] (object items; each " +
    "{{key}} MUST match an item key — a mismatch is rejected before anything runs).\n\n" +
    "Writing the template + items: the sub-agent starts fresh and sees ONLY its rendered prompt — brief it " +
    "like a smart colleague who just walked in. The template holds the SHARED framing (goal, what you " +
    "already know or ruled out, and the exact report format you want back — a uniform format directly " +
    "improves reduce quality); each item supplies the per-target specifics. For plain string items use " +
    "{{item}}; omit task_template only when each string item is already a complete prompt. Items must be " +
    "homogeneous — all strings or all objects. Never delegate understanding — give concrete targets, paths, " +
    "and what to check, not 'based on your findings, decide X'.\n\n" +
    "Foreground vs background: a SINGLE item runs FOREGROUND by default (blocks and returns the result " +
    "inline so you can keep reasoning); a MULTI-item batch runs in the BACKGROUND by default (it can take " +
    "10+ minutes, so it launches detached and a completion notification carrying the result arrives on its " +
    "own)." +
    (RUN_IN_BACKGROUND_ENABLED
      ? " Override with run_in_background: set true to detach a single task, or false to block on a small " +
        "batch whose result you need inline right now. After a BACKGROUND launch, just END YOUR TURN (or do " +
        "other independent work) — never poll it, never spawn another sub-agent to 'wait for' it, and never " +
        "fabricate its result; report to the user only when the notification arrives. Returns a job_id you " +
        "can pass to job_stop to cancel."
      : "") +
    "\n\nAvailable subagent_type values (shared by every map + reduce child):\n" +
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
      description: Type.String({ description: "Short (3-5 word) label for the task or batch." }),
      task_template: Type.Optional(
        Type.String({
          description:
            "Task template with {{key}} placeholders (or {{item}} for string items). Holds the shared " +
            "framing/report format. Omit only when each string item is already a full prompt.",
        }),
      ),
      items: Type.Array(
        Type.Union([Type.String(), Type.Record(Type.String(), Type.String())]),
        {
          minItems: 1,
          description:
            "The for-loop list — each item is one sub-agent run (use a single item for one task). Must be " +
            "homogeneous: all strings (rendered via {{item}}) OR all objects (keys must match the template's " +
            "{{placeholders}}).",
        },
      ),
      reduce_prompt: Type.Optional(
        Type.String({
          description:
            "Optional final synthesis instruction: a reduce sub-agent merges all per-item results into ONE " +
            "summary. Omit to get the per-item results back directly.",
        }),
      ),
      subagent_type: Type.Optional(
        Type.String({
          description: `Sub-agent type for every map + reduce child. Default: ${DEFAULT_SUBAGENT_TYPE}.`,
        }),
      ),
      // run_in_background is gated OFF (RUN_IN_BACKGROUND_ENABLED) until background jobs notify the
      // parent model on completion. While gated the param is hidden AND background is force-disabled
      // (see the runInBackground resolution below), so every launch runs FOREGROUND — this overrides
      // the conditional default rather than preserving it. Foreground batches still work; only
      // detached/background launches are unavailable until the notification chain lands.
      ...(RUN_IN_BACKGROUND_ENABLED
        ? {
            run_in_background: Type.Optional(
              Type.Boolean({
                description:
                  "Override the conditional default (single item → foreground, multi-item batch → background). " +
                  "Set true to detach a single task; set false to block on a small batch whose result you need " +
                  "inline right now. After a background launch a completion notification with the result arrives " +
                  "automatically — do NOT poll and do NOT spawn another sub-agent to wait for it. Returns a job_id " +
                  "usable with job_stop.",
              }),
            ),
          }
        : {}),
    }),
    async execute(toolCallId, rawParams, signal, onUpdate) {
      if (!executor) return errorResult("spawn_subagent is not available in this runtime.");

      const p = rawParams as Partial<SpawnSubagentParams>;
      const description = p.description?.trim();
      if (!description) return errorResult("spawn_subagent requires a non-empty description.");

      const type = getSubagentType(p.subagent_type);
      if (!type) {
        const valid = listSubagentTypes().map((t) => t.agentType).join(", ");
        return errorResult(`Unknown subagent_type "${p.subagent_type}". Valid types: ${valid}.`);
      }

      const items = (p.items ?? []) as Array<string | Record<string, string>>;
      const reducePrompt = p.reduce_prompt?.trim() || undefined;

      // Ops rollback lever (design decision #20): with the batch capability OFF, spawn_subagent
      // degrades to a pure single-task tool — a multi-item plan or a reduce_prompt is rejected and
      // the item cap is forced to 1. This is a behaviour switch, not a compatibility shim.
      if (!SUBAGENT_GROUP_ENABLED && (items.length > 1 || reducePrompt)) {
        return errorResult(
          "spawn_subagent batch mode is disabled (SUBAGENT_GROUP_ENABLED=false): pass a single item and " +
          "no reduce_prompt.",
        );
      }
      const maxItems = SUBAGENT_GROUP_ENABLED ? getMaxGroupItems() : 1;

      // Fail-fast: validate + render the whole plan BEFORE any child starts. A bad plan (bad
      // placeholders, mixed items, over the cap, duplicates) bounces straight back to the model.
      const plan = validateAndRenderGroupPlan({
        taskTemplate: p.task_template,
        items,
        maxItems,
      });
      if (!plan.ok) return errorResult(plan.error);

      // Conditional default (design §"Tool layer (single entry)"): a single item runs foreground (grab the result and
      // keep reasoning), a multi-item batch runs background (asymmetric harm — each side fits its own
      // failure mode). An explicit run_in_background always wins; the flag is force-false while gated.
      const runInBackground = RUN_IN_BACKGROUND_ENABLED
        ? (p.run_in_background ?? plan.tasks.length > 1)
        : false;

      // Live progress bridge. The executor emits a UNION: legacy per-child progress on the collapse
      // path (steps/activity → AgentWorkCard) or group progress on the batch path (phase/items → the
      // group card). Discriminate by shape and forward matching details; the frontend dispatches by
      // that shape too. Background runs report via the group_progress chat event instead (onUpdate
      // goes dead after "launched").
      const onProgress = onUpdate
        ? (progress: SpawnSubagentProgress | SubagentGroupProgress) => {
            if ("phase" in progress) {
              const total = progress.items.length;
              const done = progress.items.filter(
                (i) => i.status !== "queued" && i.status !== "running",
              ).length;
              const activity =
                progress.phase === "reduce"
                  ? "Summarizing results…"
                  : `Running sub-agents… ${done}/${total} done`;
              onUpdate({
                content: [{ type: "text" as const, text: activity }],
                details: { phase: progress.phase, items: progress.items },
              });
            } else {
              onUpdate({
                content: [
                  { type: "text" as const, text: progress.activity ?? `Working… ${progress.toolCalls} tool calls` },
                ],
                details: {
                  status: progress.status,
                  tool_calls: progress.toolCalls,
                  steps: progress.steps,
                  activity: progress.activity,
                },
              });
            }
          }
        : undefined;

      const result = await executor(
        {
          description,
          renderedTasks: plan.tasks,
          reducePrompt,
          subagentType: type.agentType,
          runInBackground,
          parentSessionId: refs.sessionIdRef.current,
          parentAgentId: refs.agentId,
          userId: refs.userId,
          taskListId: refs.taskListId,
          spawnId: toolCallId,
        },
        onProgress,
        signal,
      );

      return toToolOutput(result, plan.tasks.map((t) => t.item));
    },
  };
}

const LAUNCHED_MESSAGE =
  "Sub-agent(s) launched in the background. END YOUR TURN NOW unless you have OTHER independent work to do " +
  "right now — do NOT poll it, do NOT sleep/wait, and do NOT spawn another sub-agent or call any tool whose " +
  "purpose is to 'wait for', 'check on', or 'get the result of' this job. There is nothing to wait for: a " +
  "completion notification carrying the result will arrive on its own, and you report to the user THEN. " +
  "Tell the user in plain language what is running; do NOT show them this job_id (use it only with job_stop to cancel).";

/**
 * Normalise both executor result shapes into the UNIFORM model-visible envelope
 * `{ status, item_results[], reduce_summary? }` (design decision #18). `items` is the original
 * item list (kept by the tool) used to label each result. `details` additionally carries the
 * per-item drill-in ids and — on the collapse path — the legacy single-spawn fields the
 * AgentWorkCard renders (summary / tool_calls / duration / steps / full_summary).
 */
function toToolOutput(
  result: SpawnSubagentResult | SubagentGroupResult,
  items: Array<string | Record<string, string>>,
) {
  if (result.status === "launched") {
    const modelVisible = { status: "launched" as const, job_id: result.jobId, message: LAUNCHED_MESSAGE };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(modelVisible) }],
      // A collapsed single launch carries a childSessionId; a batch launch does not.
      details: {
        ...modelVisible,
        ...("childSessionId" in result ? { child_session_id: result.childSessionId } : {}),
      },
    };
  }

  if ("itemResults" in result) {
    // ── Batch (map→reduce) report ──
    const hasReduce = typeof result.reduceSummary === "string";
    const modelVisible: Record<string, unknown> = {
      status: result.status,
      // Uniform key `item_results` in every shape (design decision #18). When a reduce stage ran the
      // per-item capsules are omitted (the reduce summary is the model's synthesis; keeping N capsules
      // would defeat the reduce's context savings) — only item + status remain.
      item_results: result.itemResults.map((r) =>
        hasReduce
          ? { item: itemToText(r.item), status: r.status }
          : { item: itemToText(r.item), status: r.status, summary: r.summary },
      ),
    };
    if (hasReduce) modelVisible.reduce_summary = result.reduceSummary;
    if (result.circuitBroken) modelVisible.circuit_broken = true;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(modelVisible) }],
      details: {
        ...modelVisible,
        // Full per-item detail (raw item + child_session_id for UI drill-in) lives in details, not
        // model-visible content — the group card renders it; skipped items carry an empty id.
        item_results: result.itemResults.map((r) => ({
          item: r.item,
          status: r.status,
          summary: r.summary,
          child_session_id: r.childSessionId,
        })),
        duration_ms: result.durationMs,
        ...(result.reduceChildSessionId ? { reduce_child_session_id: result.reduceChildSessionId } : {}),
      },
    };
  }

  // ── Collapsed single-task report (legacy per-child result wrapped into the uniform envelope) ──
  const single = { item: itemToText(items[0]), status: result.status, summary: result.summary };
  const modelVisible = { status: result.status, item_results: [single] };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(modelVisible) }],
    details: {
      ...modelVisible,
      // Legacy single-spawn fields for the AgentWorkCard (it reads these from details): the raw item,
      // capsule/full report, child session for drill-in, tool-call + duration counters, and the steps.
      item_results: [{ ...single, item: items[0], child_session_id: result.childSessionId }],
      summary: result.summary,
      tool_calls: result.toolCalls,
      duration_ms: result.durationMs,
      child_session_id: result.childSessionId,
      ...(result.fullSummary ? { full_summary: result.fullSummary } : {}),
      ...(result.steps ? { steps: result.steps } : {}),
      ...(result.partialSource ? { partial_source: result.partialSource } : {}),
      ...(result.interruptedTool ? { interrupted_tool: result.interruptedTool } : {}),
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: (refs) => createSpawnSubagentTool(refs),
  modes: ["web", "channel", "cli"],
  // Hidden unless the runtime injected an executor (same "never show a non-working tool" contract;
  // children get no executor → spawn_subagent is hidden from them → no recursion). The batch
  // capability is gated by SUBAGENT_GROUP_ENABLED at the CALL layer (item cap), not here — the tool
  // itself is always available for single-task spawns.
  available: (refs) => Boolean(refs.spawnSubagentExecutor),
  requiresUserApproval: true,
};
