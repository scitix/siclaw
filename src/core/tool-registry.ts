/**
 * Tool Registry — declarative tool registration and resolution.
 *
 * Each tool file exports a `registration: ToolEntry` that declares its
 * metadata (category, modes, availability guard).
 * The registry collects all entries and resolves the final tool list
 * in one pass: mode filter → available check → instantiate → allowedTools filter.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MCP_TOOL_PREFIX } from "./mcp-client.js";
import type {
  SessionMode, KubeconfigRef, MemoryRef, DpStateRef, DelegationContext,
} from "./types.js";
import type { DelegateResponse, DelegateRosterMember } from "../shared/agent-delegate.js";
import type { ChildModelOutcome, SubagentTierMenu, SubagentTierPlan } from "./subagent-models.js";
import type { MemoryIndexer } from "../memory/indexer.js";
import type { KnowledgeResolver } from "../knowledge/resolver.js";
import type { SkillScriptResolver } from "../tools/infra/script-resolver.js";
import type { ToolEffect } from "../shared/tool-effects.js";

export type { SessionMode };

/**
 * Siclaw runtime metadata layered on top of pi-agent tool definitions.
 *
 * pi-agent executes the standard ToolDefinition fields; Siclaw uses these
 * optional flags to decide whether a future runtime permission wrapper must
 * pause and ask the user before the tool can run.
 */
export type ResolvedToolDefinition = ToolDefinition & {
  /** When true, runtime must obtain explicit user approval before execution. */
  requiresUserApproval?: boolean;
  /**
   * How far this tool can go, carried from its registration so the authority
   * guard can compare it against the envelope's effect ceiling. Absent =
   * `observe` (see TOOL_EFFECTS).
   */
  effect?: ToolEffect;
  /**
   * Stable invocation classification emitted with tool lifecycle events.
   * Registry tools use their declarative category; tools created outside the
   * registry set this at their own source boundary (filesystem / mcp:<server>).
   */
  toolset?: string;
};

// ── one spawned child (design §6) — the INTERNAL per-child contract. ──
// This is the request `runSpawnedSubagent` consumes for a SINGLE child (map item, reduce, or a
// collapsed single task). The unified tool→executor boundary is {@link SpawnSubagentGroupRequest}
// (a 1..N batch plan); the executor derives one of these per child from it.

/** "launched" is the immediate return for a background spawn; it is never a terminal/persisted status. */
export type SpawnSubagentStatus = "done" | "partial" | "failed" | "timed_out" | "launched";

export interface SpawnSubagentRequest {
  /** Short UI label for the spawned task. */
  description: string;
  /** The bounded task briefing — the child's only context besides its system prompt. */
  prompt: string;
  /** Resolved sub-agent type id (see subagent-registry). */
  subagentType: string;
  /** When true, run detached and notify the parent on completion (do not block). */
  runInBackground: boolean;
  /** Parent lineage + shared ledger. */
  parentSessionId: string;
  parentAgentId: string | null;
  userId: string;
  taskListId: string;
  /** Stable id tying the parent tool call to the child session (lineage/observability). */
  spawnId: string;
  /**
   * Immutable tier decision context, captured once when the tool call dispatched
   * and shared by every child of that call. Absent = no tiering (inherit).
   */
  tierPlan?: SubagentTierPlan;
}

/**
 * Discriminated by `status`: a background launch carries only a `jobId` (no summary
 * yet), while a finished/foreground run carries the report fields. Removes the old
 * `summary: "launched"` sentinel and makes the illegal "done + jobId" state
 * unrepresentable.
 */
export type SpawnSubagentResult =
  | {
      /** Background job launched (gated off today); usable with job_stop. */
      status: "launched";
      jobId: string;
      childSessionId: string;
    }
  | SpawnSubagentReport;

export interface SpawnSubagentReport {
  status: Exclude<SpawnSubagentStatus, "launched">;
  /** Budgeted capsule returned to the parent as model-visible tool content. */
  summary: string;
  /** Full child report for UI/debug persistence; not model-visible. */
  fullSummary?: string;
  /** The child's own persisted session id, for UI drill-in. */
  childSessionId: string;
  toolCalls: number;
  durationMs: number;
  partialSource?: "steered" | "runtime_fallback";
  interruptedTool?: string;
  /** The sub-agent's execution steps (reasoning + tool calls), so the UI can show a collapsed log after completion. */
  steps?: SubagentStep[];
  /** Which model this child ran on and why — see {@link SubagentGroupItemResult.tierOutcome}. */
  tierOutcome?: ChildModelOutcome;
}

/** One step of a sub-agent's run — its reasoning text or a tool call — for a main-agent-like live view. */
export interface SubagentStep {
  kind: "assistant" | "tool";
  /** assistant: the reasoning/answer text for this step. */
  text?: string;
  /** tool: name + input + result preview + outcome. */
  toolName?: string;
  toolInput?: string;
  content?: string;
  outcome?: "success" | "error";
  durationMs?: number | null;
}

/** Live progress pushed as a foreground sub-agent works, so the UI streams its execution in real time. */
export interface SpawnSubagentProgress {
  /** "queued" = waiting for a concurrency slot (not yet running); "running" = actively executing. */
  status: "queued" | "running";
  toolCalls: number;
  /** Ordered steps so far (assistant reasoning + tool calls), rendered live like the main agent. */
  steps: SubagentStep[];
  /** Latest activity line, e.g. the tool currently running. */
  activity?: string;
}

/**
 * The single spawn_subagent executor (design v3 §"Orchestration (batch path)"). The tool ALWAYS hands over a
 * batch plan ({@link SpawnSubagentGroupRequest}: 1..N rendered tasks + an optional reduce), so
 * a single task is just the degenerate N=1 group. The executor COLLAPSES a lone task with no
 * reduce to one legacy child run (per-child {@link SpawnSubagentResult}, byte-identical events /
 * delegation_id / notification to the pre-v3 single spawn); otherwise it runs the full map→reduce
 * orchestration ({@link SubagentGroupResult}). Progress is therefore a union — legacy per-child
 * steps on the collapse path, per-item group phases on the batch path — and so is the result;
 * the tool layer normalises both into the uniform `item_results[]` model-visible shape.
 */
export type SpawnSubagentExecutor = (
  request: SpawnSubagentGroupRequest,
  onProgress?: (progress: SpawnSubagentProgress | SubagentGroupProgress) => void,
  signal?: AbortSignal,
) => Promise<SpawnSubagentResult | SubagentGroupResult>;

// ── spawn_subagent batch plan (design §"Tool layer (single entry)" / §"Orchestration (batch path)") — the unified tool's request/result. ──

/** Terminal status of one item in a group. `skipped` = never started (circuit break / timeout). */
export type GroupItemStatus = "done" | "partial" | "failed" | "timed_out" | "skipped";

/**
 * The unified spawn_subagent request — always a batch plan of 1..N items (design v3 §"Tool layer (single entry)").
 * The tool layer has ALREADY validated + rendered the plan (so the executor never re-parses
 * templates); it hands over one fully-rendered prompt per item. `renderedTasks.length === 1`
 * with no `reducePrompt` is the degenerate single-task form the executor collapses to a legacy
 * child run. The per-child {@link SpawnSubagentRequest} is the internal shape `runSpawnedSubagent`
 * consumes; this is the tool→executor boundary.
 */
export interface SpawnSubagentGroupRequest {
  /** Short UI label for the whole call (single task or batch). */
  description: string;
  /** One rendered task per item (item original kept for the report/UI + reduce headers). */
  renderedTasks: Array<{ item: string | Record<string, string>; prompt: string }>;
  /** Optional reduce stage: when present, a final child synthesises all item results. */
  reducePrompt?: string;
  /** Resolved sub-agent type id, shared by every map child AND the reduce child (v1 limit). */
  subagentType: string;
  /** Conditional default at the tool layer: a single item runs foreground, a multi-item batch background. */
  runInBackground: boolean;
  /** Parent lineage + shared ledger. */
  parentSessionId: string;
  parentAgentId: string | null;
  userId: string;
  /** Type-symmetric with SpawnSubagentRequest; children do not consume it (parent-owned ledger). */
  taskListId: string;
  /** toolCallId, reused as the groupId (`{groupId}#{index}` tags each child delegation). */
  spawnId: string;
  /**
   * The tier the caller asked for, or null/absent for none. Resolved into a
   * {@link SubagentTierPlan} by the executor at dispatch — the tool layer passes
   * the request, not the resolution, because only the executor can see session
   * state.
   */
  modelTier?: string | null;
  /**
   * The resolved plan, filled in by the executor and then shared by every child of
   * this dispatch. Not supplied by the tool layer.
   */
  tierPlan?: SubagentTierPlan;
}

/** Live progress for a FOREGROUND group (background groups report via the group_progress event). */
export interface GroupItemProgress {
  index: number;
  status: "queued" | "running" | GroupItemStatus;
  /** Assigned once the item owns an execution slot; absent while it is still queued/skipped. */
  childSessionId?: string;
  /** Latest concise child activity suitable for the parent group card. */
  activity?: string;
}
export interface SubagentGroupProgress {
  /** "map" while item children run; "reduce" while the summary child runs. */
  phase: "map" | "reduce";
  items: GroupItemProgress[];
  /** Assigned immediately before the reduce child starts. */
  reduceChildSessionId?: string;
}

/** One item's terminal record in the group report. */
export interface SubagentGroupItemResult {
  item: string | Record<string, string>;
  status: GroupItemStatus;
  /** Capsule (model-visible only when there is no reduce stage) or a short error/skip note. */
  summary: string;
  /** The child's persisted session id for UI drill-in; empty string for `skipped` items. */
  childSessionId: string;
  /**
   * Which model this item actually ran on, and why.
   *
   * `resolvedTier` alone would show THAT a fallback happened but never WHY, so
   * "the lead chose badly", "the tier name is wrong or its model was deleted" and
   * "the candidate never arrived" would stay indistinguishable — and one of the
   * three mitigations for a mis-picked tier is "a weak child report exposes it",
   * which needs the tier to be visible per item.
   *
   * Identifiers only. Credentials never leave the candidate payload, and this
   * whole record is non-model-visible detail for the group card anyway.
   */
  tierOutcome?: ChildModelOutcome;
}

/**
 * Discriminated like {@link SpawnSubagentResult}: a background launch carries only a jobId,
 * a finished/foreground run carries the aggregate report.
 */
export type SubagentGroupResult =
  | { status: "launched"; jobId: string }
  | SubagentGroupReport;

export interface SubagentGroupReport {
  status: "done" | "partial" | "failed" | "timed_out";
  itemResults: SubagentGroupItemResult[];
  /** Reduce output, ≤ GROUP_REDUCE_SUMMARY_MAX_CHARS (truncation is annotated). Absent when no reduce ran. */
  reduceSummary?: string;
  reduceChildSessionId?: string;
  /** True when the circuit breaker tripped; the reason is folded into the summary. */
  circuitBroken?: boolean;
  /**
   * Group-level explanation shown to user/model when there is NO reduce summary: the circuit-break
   * reason, a reduce-stage failure note, or a "reduce skipped (cancelled)" note. Absent on the plain
   * success path (the reduce summary / per-item digest already covers it). Distinct from
   * `reduceSummary`, which is present only when a reduce child actually produced synthesis.
   */
  groupSummary?: string;
  durationMs: number;
}

// The batch executor merged into {@link SpawnSubagentExecutor} in v3 (single-tool merge): the one
// spawn_subagent executor accepts this request and returns SpawnSubagentResult | SubagentGroupResult.

export interface JobStopResult {
  stopped: boolean;
  message: string;
}

/** Cancels a running background job — sub-agent OR bash (design §7: job_stop). */
export type JobStopExecutor = (jobId: string) => Promise<JobStopResult>;

/** Live status of a background job, from the runtime's JobRegistry (for the task_output tool). */
export interface TaskOutputSnapshot {
  /** False when the job id is unknown to this runtime's registry. */
  found: boolean;
  status?: import("./job-registry.js").JobStatus;
  exitCode?: number;
  outputFile?: string;
}

/**
 * Reads a background job's CURRENT status from the runtime's JobRegistry. Injected by the
 * agentbox session manager and the TUI host (they own the registry). Enables the task_output
 * tool to return "running / completed / failed / stopped" instead of the model blindly
 * file-reading the output path (which 404s while the job has produced no output).
 */
export type TaskOutputReader = (jobId: string) => TaskOutputSnapshot;

export interface ChannelMessageRequest {
  sessionId: string;
  kind: "milestone" | "final" | "artifact";
  text: string;
}

export interface ChannelMessageResult {
  delivered: boolean;
  message: string;
}

export type ChannelMessageExecutor = (request: ChannelMessageRequest) => Promise<ChannelMessageResult>;

// ── background exec (run_in_background on bash / node_exec / pod_exec) ──────

/**
 * A background-exec launch request. The calling tool assembles the FULLY-WRAPPED
 * command and the sanitized env, plus the sanitizer resolved by preExecSecurity — the
 * executor only spawns + streams + notifies, keeping all command/security construction
 * in the tool.
 *
 * Three exec modes (exactly one set):
 *  - `command` (shell mode): run via `bash -c` — used by the local `bash` tool, whose
 *    command may include `sudo -E -u sandbox …` wrapping.
 *  - `file` + `args` (argv mode, no shell): used by node_exec/pod_exec and node/pod/local
 *    scripts to spawn `kubectl exec … -- nsenter … <cmd>` (or an interpreter) without
 *    re-tokenizing/quoting the nested command. `stdin` may carry the script body.
 *  - `streamFactory` (in-process stream mode): used by host_exec/host_script — there is no
 *    child process; the factory dials ssh2 and returns live stdout/stderr streams + done.
 */
export interface BackgroundExecRequest {
  /** Shell-mode command (bash). Mutually exclusive with file/args/streamFactory. */
  command?: string;
  /** argv-mode binary (node/pod/scripts). Mutually exclusive with command/streamFactory. */
  file?: string;
  args?: string[];
  /** Script body piped to the child's stdin (argv mode: node/pod/local scripts). */
  stdin?: string;
  /** In-process stream source (host_exec/host_script via ssh2). Mutually exclusive with
   *  command/file. Called once by the runner; the handle's `done` settles the job and the
   *  factory owns connection teardown. */
  streamFactory?: () => Promise<BackgroundStreamHandle>;
  cwd?: string;
  env: Record<string, string>;
  /** Sanitizer from preExecSecurity. MUST be line-safe (caller rejects otherwise) or null. */
  action: import("../tools/infra/output-sanitizer.js").OutputAction | null;
  hasSensitiveKubectl: boolean;
  description: string;
  parentSessionId: string;
  /** Tool-call id, reused as the jobId (matches spawn_subagent's spawnId convention). */
  jobId: string;
  /** True in K8s prod where the command is sudo-wrapped (bash shell mode only). */
  isProd: boolean;
  /** Job kind for the registry + concurrency accounting. Defaults to "bash". */
  jobType?: "bash" | "node" | "pod" | "host" | "local";
  /** Called exactly once when the job settles (completed/failed/killed), before notify.
   *  node_exec uses it to unpin (release) the debug pod it acquired for the job. */
  onComplete?: () => void;
  /** Called by job_stop's abort BEFORE the local child is killed. node_exec uses it to
   *  promptly kill the REMOTE process group (the local kubectl-exec kill does not reach a
   *  host-namespace process). Best-effort, fire-and-forget. */
  onAbort?: () => void;
}

export interface BackgroundExecResult {
  jobId: string;
  outputFile: string;
}

/** Live stream handle for an in-process background job (e.g. ssh2 channel). Structurally
 *  matches ssh-dial's SshStreamHandle so sshExecStream's result is assignable. */
export interface BackgroundStreamHandle {
  stdout: import("node:stream").Readable;
  stderr: import("node:stream").Readable;
  /** Resolves when the remote side closes (exitCode null = killed by signal). */
  done: Promise<{ exitCode: number | null; signal?: string }>;
  /** Best-effort: close/abort the stream. */
  abort: () => void;
}

/**
 * Launches a background exec job. Returns immediately (the process keeps running);
 * completion is delivered to the parent model via the runtime's notify path. When
 * absent, the `run_in_background` param is hidden from the model.
 */
export type BackgroundExecExecutor = (req: BackgroundExecRequest) => BackgroundExecResult;

/**
 * Wiring injected into a cmd-exec tool factory (bash / node_exec / pod_exec) to enable
 * run_in_background: the executor + a ref to the live session id. Shared by all three tools.
 */
export interface BackgroundExecWiring {
  executor?: BackgroundExecExecutor;
  sessionIdRef?: { current: string };
}

/**
 * Callback a tool can invoke to push a custom event into the parent session's
 * SSE stream (e.g., forwarding a spawned sub-agent's events so the frontend
 * can render them in a nested block). Injected per-session from agentbox; may
 * be undefined in non-gateway contexts (TUI, tests).
 */
export type SessionEventEmitter = (event: Record<string, unknown>) => void;

/** A single live step of a delegated peer's turn — same shape the spawn_subagent
 *  card renders (assistant reasoning line, or a tool call with its result). */
export interface DelegateStep {
  kind: "assistant" | "tool";
  text?: string;
  toolName?: string;
  toolInput?: string;
  content?: string;
  outcome?: "success" | "error";
  durationMs?: number | null;
}

/** Live progress of a delegated turn, emitted as the peer streams. Mirrors the
 *  spawn_subagent progress shape so the coordinator card updates identically. */
export interface DelegateProgress {
  toolCalls: number;
  steps: DelegateStep[];
  activity?: string;
  /** The peer session id, known from delegation start — lets the card show the
   *  "open full session" affordance live (before the final result arrives). */
  childSessionId?: string;
}

/**
 * Delegates a bounded read-only task to a PEER agent (its own box, reached via
 * the gateway) and resolves with the peer's final result. `onProgress` fires as
 * the peer streams (live steps), so the caller can render the peer's work in
 * real time. Injected per-session from agentbox (which holds the gatewayClient).
 * Absent → the `delegate_to_agent` tool stays out of the resolved tool list.
 */
export type DelegateToAgentExecutor = (
  req: { peerAgentId: string; text: string; peerSessionId?: string; evidenceRefs?: string[] },
  onProgress?: (p: DelegateProgress) => void,
  /** Aborts the delegation when the coordinator's turn is stopped: closes the
   *  relay stream and cancels the peer's turn. */
  signal?: AbortSignal,
) => Promise<DelegateResponse>;

/** All dependencies shared by tool factory functions. */
export interface ToolRefs {
  kubeconfigRef: KubeconfigRef;
  userId: string;
  /** Agent ID — used for metrics labeling. Null when running outside an agent context (TUI/CLI). */
  agentId: string | null;
  sessionIdRef: { current: string };
  /**
   * Bumped once per turn by whoever owns the prompt, so a tool can scope state to
   * ONE routing attempt instead of the whole session. Tools read it lazily and
   * reset their own state when it changes — there is no registry-side reset, and
   * tools stay correct when it is absent (they just keep session scope, the
   * pre-existing behaviour).
   */
  turnRef?: { current: number };
  /** Shared task-ledger id. A session and the sub-agents it spawns share one taskListId. */
  taskListId: string;
  /**
   * True when this session is a spawned sub-agent (child). The plan/task tools are
   * hidden from sub-agents — the plan is owned by the parent; a child that mutated the
   * shared ledger would have no SSE emitter, so its changes wouldn't reach the UI.
   */
  isSubagent?: boolean;
  memoryRef: MemoryRef;
  dpStateRef: DpStateRef;
  memoryIndexer?: MemoryIndexer;
  /** Labels-only resolver over the knowledge pages mounted for this Agent. */
  knowledgeIndexer?: KnowledgeResolver;
  /** Session-scoped Skill script lookup. Required for LocalSpawner isolation. */
  skillScriptResolver?: SkillScriptResolver;
  memoryDir?: string;
  /** See SessionEventEmitter. Undefined when running without a session SSE bus. */
  sessionEventEmitter?: SessionEventEmitter;
  /**
   * Explicitly exposes `request_input` for a top-level machine-driven turn
   * (currently A2A). Delegated peer turns use `delegation` instead.
   */
  allowInputRequest?: boolean;
  /** Per-session citation registrar sharing successful-read state with Read. */
  knowledgeCitationTool?: ToolDefinition;
  /**
   * Optional spawn_subagent executor (design §6, v3 single-tool merge). Handles the whole
   * batch plan (1..N items + optional reduce), collapsing a single no-reduce task to a legacy
   * child run. When absent, spawn_subagent stays out of the resolved tool list so the model
   * never sees a non-working tool (children get no executor → no recursion).
   */
  spawnSubagentExecutor?: SpawnSubagentExecutor;
  /**
   * Force spawn_subagent to run FOREGROUND (block, return results inline) — hides the
   * `run_in_background` param and flips a multi-item batch's default from background to
   * foreground. Set only for the `channel` session mode: it exposes spawn_subagent (see the
   * tool's registration `modes`) yet has no persistent client to receive a detached conclusion,
   * so a background batch would strand its result. web/cli also expose spawn_subagent but are
   * persistent (leave this false → keep background); a2a/api/task don't expose spawn_subagent at
   * all. Does NOT affect `run_in_background` exec (node/pod/bash), a within-turn primitive.
   */
  foregroundSubagentOnly?: boolean;
  /**
   * The sub-agent model tier MENU this session advertises — credential-free
   * `{tier, whenToUse}` entries. Absent/null means this deployment has no tiers,
   * and then `spawn_subagent` exposes no `model_tier` parameter at all.
   *
   * Supplied at session construction from the session's snapshot, not read live:
   * the tool schema and description are built once, so the menu the lead is shown
   * must be the menu its choice is resolved against.
   */
  subagentTierMenu?: SubagentTierMenu | null;
  /** Cancels a running background job (sub-agent or bash). Enables the job_stop tool. */
  jobStopExecutor?: JobStopExecutor;
  /**
   * Launches a background exec job (run_in_background on bash / node_exec / pod_exec).
   * When absent, the `run_in_background` param is not exposed on those tools. Injected by
   * the agentbox session manager and the TUI background host.
   */
  backgroundExecExecutor?: BackgroundExecExecutor;
  /** Reads a background job's live status from the runtime's JobRegistry. Enables task_output. */
  taskOutputReader?: TaskOutputReader;
  /** Sends an agent-selected visible update to the active IM channel; Gateway owns delivery policy. */
  channelMessageExecutor?: ChannelMessageExecutor;
  /**
   * Present when this turn was delegated by a coordinator agent to a peer,
   * siclaw-native via the gateway's internal delegate API. Its presence marks a
   * delegated turn; `readOnly` drives the read-only
   * tool filter in `resolve()`. Tools use it to gate visibility (report_findings
   * appears only when delegated; channel_update is suppressed) and to stamp the
   * result artifact with `delegationId`. See docs/design/agent-delegation.md.
   */
  delegation?: DelegationContext;
  /**
   * Delegation roster for a COORDINATOR agent: the peer agents it may delegate
   * to, with derived manifest (name/description/bindings). Non-empty + an
   * executor present → the `delegate_to_agent` tool is exposed and its
   * description lists these peers. Delivered from the gateway (K8s boxes have no
   * DB). See docs/design/agent-delegation.md §5.
   */
  delegationRoster?: DelegateRosterMember[];
  /** Runs a delegation to a peer agent. See DelegateToAgentExecutor. */
  delegateToAgentExecutor?: DelegateToAgentExecutor;
}

/** Declarative registration for a single tool. */
export interface ToolEntry {
  /** Tool category — documentation only, not used for filtering. */
  category: "cmd-exec" | "script-exec" | "query" | "workflow";

  /**
   * Factory function — receives shared refs, returns a ToolDefinition.
   * If your tool accesses optional refs (memoryIndexer, memoryDir),
   * you MUST provide an `available` guard that checks them. The registry calls
   * `available` before `create` — the guard is the safety net for `!` assertions.
   */
  create: (refs: ToolRefs) => ToolDefinition;

  /**
   * Session modes where this tool is available. Omit = all modes.
   * Replaces the scattered `if (mode === "web")` logic in agent-factory.
   */
  modes?: SessionMode[];

  /**
   * Runtime permission metadata.
   *
   * Use for tools that can branch work, spend meaningful resources, or delegate
   * to another agent. The registry only annotates the ToolDefinition; execution
   * gating is owned by the session/runtime layer so existing tools keep their
   * behavior until such a wrapper is installed.
   */
  requiresUserApproval?: boolean;

  /**
   * How far this tool can go — compared against the authority envelope's effect
   * ceiling by the authority guard (see shared/tool-effects.ts).
   *
   * DECLARE IT ON EVERY TOOL THAT CAN MUTATE ANYTHING. Omitting it means
   * `observe`, so a new mutating tool that forgets this line would run freely
   * under an observe-only ceiling. `tool-registry.test.ts` asserts that every
   * tool in the mutating capability groups declares a non-observe effect, which
   * is what turns "remember to declare it" into a build failure.
   *
   * Must agree with TOOL_EFFECTS (a test pins that too): this field annotates
   * the resolved ToolDefinition, while TOOL_EFFECTS is the by-name lookup the
   * guard uses for tools that never pass through this registry.
   */
  effect?: ToolEffect;

  /**
   * Runtime availability check. Return false to skip this tool (create is not called).
   * Use for tools that depend on resources that may not be available
   * (e.g. memoryIndexer initialization failure).
   * Omit = always available.
   */
  available?: (refs: ToolRefs) => boolean;

  /**
   * True on tools safe to expose in a READ-ONLY DELEGATED turn (queries, reads,
   * the result-artifact reporter). When `refs.delegation?.readOnly` is set,
   * `resolve()` keeps ONLY tools with this flag — every exec/script/mutation tool
   * drops out, so a delegated worker physically cannot write. Omit = not exposed
   * under read-only delegation. Orthogonal to `allowedTools` (per-agent capability
   * whitelist) — both filters apply. See docs/design/agent-delegation.md §8.
   */
  readOnlyDelegable?: boolean;

  /**
   * Operating modes that expose this tool. Omit = available in every mode (the
   * common case). Otherwise the tool is shown only when the session's active mode
   * is in this list:
   * - `["normal"]` — hidden in Deep Investigation (e.g. the plan/task tools, whose
   *   structure conflicts with DP's hypothesis-checkpoint flow).
   * - `["dp"]` — only inside Deep Investigation (a DP-exclusive tool).
   * - `["normal", "dp"]` — both (same as omitting).
   * This is a general mode axis (orthogonal to SessionMode): DP is the first mode;
   * future modes are added to `AgentMode` and tagged here. The session is rebuilt
   * when the active mode changes, so this is honoured even mid-session.
   */
  availableModes?: AgentMode[];
}

/**
 * The agent's active operating mode within a session — a general, extensible axis
 * orthogonal to SessionMode. `"normal"` is the default; `"dp"` is Deep Investigation.
 * Add new modes here (and resolve them where the active mode is computed).
 */
export type AgentMode = "normal" | "dp";

/**
 * Tool name → declared effect, for the authority guard's by-name lookup.
 *
 * Why a map next to the per-entry `effect` declarations: the guard sees a NAME,
 * and not every name it sees comes from a ToolEntry. `write` and `edit` are
 * pi-agent harness built-ins with no registration here, yet they mutate the
 * workspace and must be governed by the ceiling like everything else. So this
 * map is the lookup, `ToolEntry.effect` is the resolved-definition annotation,
 * and a test asserts the two never disagree for a registered tool.
 *
 * ⚠️ DEFAULT FOR AN UNDECLARED TOOL IS `observe`. That is only safe because
 * every mutating BUILT-IN is listed here, and a test enforces it for the
 * mutating capability groups. A new tool that can change anything — inside or
 * outside this repo — MUST be added here; if it is not, the effect ceiling will
 * treat it as a read and let it run under `observe`.
 *
 * ⚠️ **动态名字（MCP）不走这个默认值。** 它们登记不进这张表，`effectForTool` 对
 * `mcp__` 前缀单独判：服务器声明 readOnlyHint 才算 observe，其余按 external_write。
 * 见下面 MCP_TOOL_EFFECTS。
 *
 * 这一段原先写的是"动态工具解析成 observe，用 envelope 的 allowedCapabilities /
 * deniedCapabilities 去约束它们" —— **那条缓解从来没有被签发过**（Sicore 侧 gate.go
 * 明确注释说不签 scope），于是只读调查里任意 MCP 写工具都能直接执行。一条只存在于
 * 注释里的控制等于没有控制，所以改成在这里 fail closed。
 */
export const TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = Object.freeze({
  // Harness built-ins (no ToolEntry): sandbox/workspace writes.
  write: "local_write",
  edit: "local_write",
  // Skill authoring writes into the session's skill workspace.
  skill_preview: "local_write",
  // Command execution — reaches real nodes, pods and hosts.
  bash: "external_write",
  node_exec: "external_write",
  pod_exec: "external_write",
  host_exec: "external_write",
  // Script execution — same reach, larger payload.
  node_script: "external_write",
  pod_script: "external_write",
  local_script: "external_write",
  host_script: "external_write",
  // Amplification: each of these makes ANOTHER agent act, so its own effect is
  // at least that of what it can start.
  spawn_subagent: "external_write",
  delegate_to_agent: "external_write",
  // Scheduling persists future work that runs without a human in the loop.
  manage_schedule: "external_write",
  // Stops a background job this agent started: runtime state, not a real resource.
  job_stop: "local_write",
} satisfies Record<string, ToolEffect>);

/**
 * The effect declared for a tool name; `observe` when nothing is declared.
 *
 * Fail-closed reasoning lives in TOOL_EFFECTS above: the permissive default is
 * deliberate and is held safe by the completeness of that map plus the
 * assertion test, not by hoping every ceiling is generous.
 */
/**
 * MCP 工具的 effect —— **由发现时的 annotations 决定，缺省不是 observe。**
 *
 * ⚠️ **这是 P0 修复。** 之前 `effectForTool` 对任何未登记的名字返回 `observe`，而 MCP
 * 工具的名字是动态的、按定义登记不进 TOOL_EFFECTS。于是一个只读调查（ceiling=observe）
 * 里，**任意 MCP 写工具都能直接执行** —— guard 认为它是读，Envelope 又没有签发
 * allow-list（Sicore 侧 gate.go 刻意不签，注释里说"runtime 在工具名这一层执行"）。
 * TOOL_EFFECTS 的注释当时已经写明了这个洞并指向 allowedCapabilities 作为缓解，
 * 但那条缓解从来没有被签发过 —— 一条只存在于注释里的控制。
 *
 * 现在的判据：
 *   - MCP 服务器声明了 `annotations.readOnlyHint: true` → observe
 *   - 其余一律 external_write（它按定义要连到外部服务器上去）
 *
 * ⚠️ **readOnlyHint 是服务器自报的**，所以这不是密码学意义上的保证。它的信任级别等同于
 * "一个已注册的 skill 自己声明 effect"：MCP 服务器由平台管理员注册，在信任边界之内。
 * 真正的收紧手段是 Envelope 上的 allowed/deniedCapabilities，那是平台说了算的。
 *
 * ⚠️ **默认必须是 external_write 而不是 observe。** 不认识的工具不是"读"——
 * 它只是没被分类。安全判据在不确定时只能往严的一侧倒。
 */
const MCP_TOOL_EFFECTS = new Map<string, ToolEffect>();

/**
 * 记下一个 MCP 工具的 effect。发现工具时调用（McpClientManager）。
 *
 * ⚠️ 键是**全名**（`mcp__server__tool`），与 guard 看到的名字一致 —— guard 只拿得到
 * 名字，拿不到 ToolDefinition。
 */
export function recordMcpToolEffect(fullName: string, readOnlyHint: boolean | undefined): void {
  MCP_TOOL_EFFECTS.set(fullName, readOnlyHint === true ? "observe" : "external_write");
}

/** 测试用：清空已记录的 MCP 工具 effect。 */
export function resetMcpToolEffects(): void {
  MCP_TOOL_EFFECTS.clear();
}

export function effectForTool(name: string): ToolEffect {
  const declared = TOOL_EFFECTS[name];
  if (declared) return declared;
  // ⚠️ **动态名字（MCP）不落回 observe。** 见 MCP_TOOL_EFFECTS 上面那段。
  // 没记录过的 MCP 工具同样按 external_write 处理：发现流程没跑到、或者工具是后来
  // 才出现的，都不构成"它是只读的"的理由。
  if (name.startsWith(MCP_TOOL_PREFIX)) {
    return MCP_TOOL_EFFECTS.get(name) ?? "external_write";
  }
  return "observe";
}

export class ToolRegistry {
  private entries: ToolEntry[] = [];

  register(...entries: ToolEntry[]): void {
    this.entries.push(...entries);
  }

  /**
   * Resolve the final tool list in one pass:
   * 1. Filter by mode + available guard (zero cost — create not called)
   * 2. Instantiate only the tools that passed filtering
   * 3. Apply allowedTools whitelist (sole availability axis; no exemptions)
   */
  resolve(opts: {
    mode: SessionMode;
    refs: ToolRefs;
    allowedTools?: string[] | null;
    /** Active operating mode (normal/dp/…). Filters tools by `availableModes`. */
    activeMode?: AgentMode;
  }): ResolvedToolDefinition[] {
    const { mode, refs, allowedTools, activeMode = "normal" } = opts;

    // Read-only delegated turn: the worker was delegated a bounded task by a
    // coordinator over the mesh, at the read-only tier (design §8). Keep ONLY
    // tools tagged readOnlyDelegable — this drops every exec/script/mutation
    // tool, so the worker physically cannot write. Non-delegated turns and
    // write-tier delegation (P1) are unaffected.
    const delegatedReadOnly = refs.delegation?.readOnly === true;

    // 1. session-mode + operating-mode + delegation + available check (create not called yet)
    const applicable = this.entries.filter(
      (e) =>
        (!e.modes || e.modes.includes(mode)) &&
        (!e.availableModes || e.availableModes.includes(activeMode)) &&
        (!delegatedReadOnly || e.readOnlyDelegable === true) &&
        (!e.available || e.available(refs)),
    );

    // 2. Instantiate only applicable tools
    const tools = applicable.map((e) => {
      const def = e.create(refs) as ResolvedToolDefinition;
      def.toolset = e.category;
      if (e.requiresUserApproval) {
        def.requiresUserApproval = true;
      }
      // Carry the declared effect onto the resolved definition, the same way
      // requiresUserApproval is carried, so the authority guard can read how far
      // this tool goes without a second lookup.
      if (e.effect) {
        def.effect = e.effect;
      }
      return def;
    });

    // 3. allowedTools whitelist (sole availability axis; no exemptions)
    if (Array.isArray(allowedTools)) {
      const allowed = new Set(allowedTools);
      return tools.filter((d) => allowed.has(d.name));
    }

    return tools;
  }
}
