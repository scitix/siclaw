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
  isSubagentGroupEnabled,
} from "../../core/subagent-registry.js";
import { renderTierMenuForDescription, type ChildModelOutcome } from "../../core/subagent-models.js";
import { validateAndRenderGroupPlan } from "../../agentbox/subagent-group.js";

import { selectSubagentTargets, type SubagentTargetSource } from "../../agentbox/subagent-targets.js";
import { validateSubagentContextSelection, type SubagentContextSelection } from "../../agentbox/subagent-context.js";

interface SpawnSubagentParams {
  fork_turns?: SubagentContextSelection;
  resume?: string;
  items_from?: SubagentTargetSource;
  description: string;
  task_template?: string;
  items: Array<string | Record<string, string>>;
  reduce_prompt?: string;
  subagent_type?: string;
  run_in_background?: boolean;
  model_tier?: string;
}

/**
 * Snake_case tier fields for one item's report, shared by the batch and the
 * collapsed-single paths so they cannot describe the same thing differently.
 *
 * Requested vs resolved plus a reason is what separates "the report is weak",
 * "the lead picked the wrong tier" and "the candidate never arrived" — they look
 * identical from outside otherwise. Identifiers only; credentials never leave the
 * candidate payload.
 */
function tierFieldsForReport(outcome: ChildModelOutcome | undefined): Record<string, unknown> {
  if (!outcome) return {};
  return {
    requested_tier: outcome.requestedTier ?? undefined,
    resolved_tier: outcome.resolvedTier ?? undefined,
    selection_source: outcome.source,
    effective_provider: outcome.provider,
    effective_model_id: outcome.modelId,
    fallback_reason: outcome.fallbackReason,
  };
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

function buildDescription(groupEnabled: boolean, backgroundAllowed: boolean): string {
  return [
    "Delegate bounded work to subagents. Use one free-form item for a single task. " +
    "Describe the goal, relevant context, scope/constraints and useful deliverables; the child chooses how to investigate. " +
    "It inherits this Agent's business policy, permissions and environment. Parent conversation is omitted by default; " +
    "use fork_turns:'all' for the active parent context (including existing compaction summaries), or a positive integer for the last N user-message turns. " +
    "Choose the smallest context needed; all children in the call get the same dispatch snapshot. Historical tool evidence is scoped into each child; " +
    "parent system instructions, private reasoning, runtime controls and live task ownership are not copied. " +
    "Children cannot spawn children or edit the parent's plan. Do simple bulk queries yourself when sufficient.",
    groupEnabled
      ? "For different independent assignments, pass each complete prompt as a string in items and omit task_template. " +
        "For the same investigation across many targets, use a shared task_template ({{item}} for strings or {{field}} for objects). " +
        "All items in one call share the selected role and model tier; use separate calls when those must differ. " +
        "Optional reduce_prompt adds a synthesis child; omit it when the parent will combine the reports itself. " +
        "For exhaustive work, obtain the full authorized inventory first. items_from selects targets directly from a complete JSON tool-result artifact, " +
        "checks its total and stable identities, and returns a next_offset for subsequent bounded batches. " +
        "A batch finishing does not prove all inventory targets succeeded: reconcile coverage, failures and skipped items."
      : "Batch mode is disabled: pass exactly one string item without a template or reduce_prompt.",
    "To guide a running child or ask a completed child a follow-up, pass its returned resume handle and one string item with your message. " +
    "Running children receive guidance at a safe boundary; completed children continue their own transcript. " +
    "Do not relaunch duplicate work. Handles belong to this parent session and expire with its output artifacts (normally 24 hours). " +
    "A follow-up is a new result; a previous batch synthesis remains historical, so integrate the revised findings.",
    backgroundAllowed
      ? "Single tasks default to foreground; multi-item batches default to background. Set run_in_background:false to await results inline. " +
        "Background completion is delivered automatically: continue independent work, never poll or spawn a waiter. " +
        "Keep the user request active until required work and synthesis finish; use job_stop to cancel."
      : "This surface runs all tasks in foreground. Await results and report them in this turn; do not promise a later detached reply.",
    "Available roles:\n" + listSubagentTypes().map(t => `- ${t.agentType}: ${t.whenToUse}`).join("\n"),
  ].join("\n\n");
}

export function createSpawnSubagentTool(
  refs: ToolRefs,
  executor = refs.spawnSubagentExecutor,
): ToolDefinition {
  // Background (detached) delegation is allowed only when the global switch is on AND this entry
  // point can receive an async conclusion. Only the `channel` session sets foregroundSubagentOnly
  // (see agent-factory) — there every launch runs foreground so the turn carries the real answer.
  // web/cli keep background; a2a/api/task never resolve this tool (see `modes` below). exec is separate.
  const backgroundAllowed = RUN_IN_BACKGROUND_ENABLED && !refs.foregroundSubagentOnly;
  // The menu this SESSION advertises. Read once, here, because the schema and the
  // description are built once — the same reason the resolution honours the
  // session's snapshot rather than the box's current menu.
  const tierMenu = refs.subagentTierMenu ?? null;
  return {
    name: "spawn_subagent",
    label: "Spawn Sub-agent",
    description:
      buildDescription(isSubagentGroupEnabled(), backgroundAllowed) +
      renderTierMenuForDescription(tierMenu),
    parameters: Type.Object({
      description: Type.String({ description: "Short (3-5 word) label for the task or batch." }),
      fork_turns: Type.Optional(Type.Union([
        Type.Literal("none"), Type.Literal("all"), Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      ], { description: "New children only: 'none' (default) for an independent prompt, 'all' for active parent history, or N for the most recent N user-message turns. Preserves available text, images and completed tool evidence, not archived pre-compaction history. Cannot combine with resume." })),
      task_template: Type.Optional(
        Type.String({
          description:
            "Task template with {{key}} placeholders (or {{item}} for string items). Holds the shared " +
            "framing/report format. Omit only when each string item is already a full prompt.",
        }),
      ),
      items: Type.Optional(Type.Array(
        Type.Union([Type.String(), Type.Record(Type.String(), Type.String())]),
        {
          minItems: 1,
          description:
            "One child per item. Without task_template, each string is an independent complete prompt and may describe entirely different work. " +
            "With task_template, items supply target values. Use all strings ({{item}}) OR all objects " +
            "whose keys match the template's {{placeholders}}; do not mix forms.",
        },
      )),
      resume: Type.Optional(Type.String({ description: "Opaque resume handle from an earlier launch. Supply exactly one string item; no template, reduce or tier override." })),
      items_from: Type.Optional(Type.Object({
        artifact_id: Type.String(),
        array_pointer: Type.String({ description: "JSON pointer to the complete target array." }),
        total_pointer: Type.String({ description: "JSON pointer to the source-declared total; must equal the full array length." }),
        fields: Type.Record(Type.String(), Type.String(), { description: "Template field name to per-row JSON pointer, e.g. {node: /metadata/name, uid: /metadata/uid}." }),
        identity_field: Type.String({ description: "Selected field containing the unique stable target ID." }),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
      })),
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
      // Tier selection exists ONLY when this agent has tiers configured. With no
      // menu the parameter is absent entirely, so a deployment without tiering
      // never shows the model a concept it cannot act on. When present it is a
      // CLOSED union built from the menu: a typo then violates the schema (which
      // the harness can repair) instead of silently falling back and surfacing
      // only later, in the report.
      ...(tierMenu && tierMenu.items.length > 0
        ? {
            model_tier: Type.Optional(
              Type.Union(
                tierMenu.items.map((item) => Type.Literal(item.tier)),
                {
                  description:
                    "Which model tier runs the map children. Omit to use this agent's own model. " +
                    "The reduce child always uses the agent's own model regardless.",
                },
              ),
            ),
          }
        : {}),
      // Advertise detached execution only on surfaces with completion delivery.
      ...(backgroundAllowed
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
      try { validateSubagentContextSelection(p.fork_turns); }
      catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
      const description = p.description?.trim();
      if (!description) return errorResult("spawn_subagent requires a non-empty description.");

      const type = getSubagentType(p.subagent_type);
      if (!type) {
        const valid = listSubagentTypes().map((t) => t.agentType).join(", ");
        return errorResult(`Unknown subagent_type "${p.subagent_type}". Valid types: ${valid}.`);
      }

      let items = (p.items ?? []) as Array<string | Record<string, string>>;
      let coverage: ReturnType<typeof selectSubagentTargets>["coverage"] | undefined;
      if (p.resume && (p.fork_turns !== undefined || p.items_from || p.task_template || p.reduce_prompt || p.model_tier || p.subagent_type || items.length !== 1 || typeof items[0] !== "string")) {
        return errorResult("resume requires exactly one string item and no fork_turns, items_from, template, reduce, type or tier override.");
      }
      if (p.items_from) {
        if (!isSubagentGroupEnabled()) return errorResult("Inventory snapshot batches are disabled in this deployment.");
        if (p.items || !refs.readToolResult) return errorResult("items_from requires artifact access and cannot be combined with items.");
        try {
          const selected = selectSubagentTargets(await refs.readToolResult(p.items_from.artifact_id), p.items_from, getMaxGroupItems());
          items = selected.items;
          coverage = selected.coverage;
        } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
      }
      const reducePrompt = p.reduce_prompt?.trim() || undefined;

      // Ops rollback lever (design decision #20): with the batch capability OFF, spawn_subagent
      // degrades to a pure single-task tool — a multi-item plan or a reduce_prompt is rejected and
      // the item cap is forced to 1. This is a behaviour switch, not a compatibility shim.
      const groupEnabled = isSubagentGroupEnabled();
      if (!groupEnabled && (items.length > 1 || reducePrompt)) {
        return errorResult(
          "spawn_subagent batch mode is disabled (SICLAW_SUBAGENT_GROUP_ENABLED=false): pass a single " +
          "item and no reduce_prompt. To run the same task across several targets, emit one " +
          "spawn_subagent call per target (a single item each) instead of a batch.",
        );
      }
      const maxItems = groupEnabled ? getMaxGroupItems() : 1;

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
      const runInBackground = backgroundAllowed
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
              const items = progress.items.map(({ index, status, childSessionId, activity: itemActivity, item }) => ({
                index,
                ...(item !== undefined ? { item } : {}),
                status,
                ...(childSessionId ? { child_session_id: childSessionId } : {}),
                ...(itemActivity ? { activity: itemActivity } : {}),
              }));
              const activity =
                progress.phase === "reduce"
                  ? "Summarizing results…"
                  : `Running sub-agents… ${done}/${total} done`;
              onUpdate({
                content: [{ type: "text" as const, text: activity }],
                details: {
                  phase: progress.phase,
                  items,
                  ...(progress.reduceChildSessionId
                    ? { reduce_child_session_id: progress.reduceChildSessionId }
                    : {}),
                },
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
          forkTurns: p.fork_turns,
          resumeHandle: p.resume,
          targetCoverage: coverage,
          renderedTasks: plan.tasks,
          reducePrompt,
          subagentType: type.agentType,
          runInBackground,
          parentSessionId: refs.sessionIdRef.current,
          parentAgentId: refs.agentId,
          userId: refs.userId,
          taskListId: refs.taskListId,
          spawnId: toolCallId,
          // Pass the REQUEST, not a resolution: only the executor can see session
          // state, and it owns the env-override / type-default ordering.
          modelTier: p.model_tier ?? null,
        },
        onProgress,
        signal,
      );

      const output = toToolOutput(result, plan.tasks.map((t) => t.item));
      if (coverage) {
        const value = JSON.parse(output.content[0].text);
        value.coverage = "coverage" in result ? result.coverage ?? coverage : coverage;
        output.content[0].text = JSON.stringify(value);
        Object.assign(output.details, { coverage: value.coverage });
      }
      return output;
    },
  };
}

const LAUNCHED_MESSAGE =
  "Subagents are running concurrently for the current request. Continue any independent work. " +
  "Their completion results will be delivered to you; use them to finish the request and report the findings. " +
  "Until then, describe progress as commentary, not a completed answer. Do NOT poll or launch another " +
  "agent just to wait. Use job_stop to cancel if needed.";

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
    const steered = "steered" in result && result.steered;
    const modelVisible = { status: steered ? "steered" : "launched", job_id: result.jobId,
      ...("childSessionId" in result ? { child_session_id: result.childSessionId, resume: result.resumeHandle } : {}),
      ...("children" in result ? { children: result.children?.map(c => ({ child_session_id: c.childSessionId, resume: c.resumeHandle, item: c.item })) } : {}),
      message: "steered" in result && result.steered ? "Guidance queued for the existing child; no additional run was launched. Await its updated result." : LAUNCHED_MESSAGE };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(modelVisible) }],
      // A collapsed single launch carries a childSessionId; a batch launch does not.
      details: {
        ...modelVisible,
        ...(steered ? { status: "done", action: "steer", summary: modelVisible.message } : {}),
        ...("childSessionId" in result ? { child_session_id: result.childSessionId } : {}),
      },
    };
  }

  if ("itemResults" in result) {
    // ── Batch (map→reduce) report ──
    const hasReduce = typeof result.reduceSummary === "string";
    const modelVisible: Record<string, unknown> = {
      status: result.status,
      // Preserve source evidence alongside synthesis. The artifact wrapper bounds model context
      // while keeping all reports recoverable, including evidence a reducer failed to mention.
      item_results: result.itemResults.map((r) => (
        { item: itemToText(r.item), status: r.status, summary: r.fullSummary ?? r.summary, child_session_id: r.childSessionId, resume: r.resumeHandle }
      )),
    };
    if (hasReduce) modelVisible.reduce_summary = result.reduceSummary;
    // No reduce summary, but a group-level explanation exists (circuit-break reason / reduce-stage
    // failure / cancel-skip): surface it so the model learns WHY the batch stopped (#7). Never both
    // — when a reduce ran, reduce_summary IS the synthesis; groupSummary is undefined on that path.
    else if (result.groupSummary) modelVisible.group_summary = result.groupSummary;
    if (result.circuitBroken) modelVisible.circuit_broken = true;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(modelVisible) }],
      details: {
        ...modelVisible,
        // Keep raw item labels and compact summaries for the group card; skipped items carry an empty child ID.
        item_results: result.itemResults.map((r) => ({
          item: r.item,
          status: r.status,
          summary: r.summary,
          child_session_id: r.childSessionId,
          ...tierFieldsForReport(r.tierOutcome),
        })),
        duration_ms: result.durationMs,
        ...(result.reduceChildSessionId ? { reduce_child_session_id: result.reduceChildSessionId } : {}),
      },
    };
  }

  // ── Collapsed single-task report (legacy per-child result wrapped into the uniform envelope) ──
  const single = { item: itemToText(items[0]), status: result.status, summary: result.fullSummary ?? result.summary, child_session_id: result.childSessionId, resume: result.resumeHandle };
  const modelVisible = { status: result.status, item_results: [single] };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(modelVisible) }],
    details: {
      ...modelVisible,
      // Legacy single-spawn fields for the AgentWorkCard (it reads these from details): the raw item,
      // capsule/full report, child session for drill-in, tool-call + duration counters, and the steps.
      // Same tier fields the batch path reports — a single task is the common case,
      // so omitting them here would leave the most-used path unable to show which
      // model ran or why it fell back.
      item_results: [{
        ...single,
        item: items[0],
        child_session_id: result.childSessionId,
        ...tierFieldsForReport(result.tierOutcome),
      }],
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
  modes: ["web", "channel"],
  // Hidden unless the runtime injected an executor (same "never show a non-working tool" contract;
  // children get no executor → spawn_subagent is hidden from them → no recursion). The batch
  // capability is gated by isSubagentGroupEnabled() at the CALL layer (item cap), not here — the tool
  // itself is always available for single-task spawns.
  available: (refs) => Boolean(refs.spawnSubagentExecutor),
  requiresUserApproval: true,
};
