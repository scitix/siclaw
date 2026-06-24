/**
 * Tool Registry — declarative tool registration and resolution.
 *
 * Each tool file exports a `registration: ToolEntry` that declares its
 * metadata (category, modes, availability guard).
 * The registry collects all entries and resolves the final tool list
 * in one pass: mode filter → available check → instantiate → allowedTools filter.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  SessionMode, KubeconfigRef, MemoryRef, DpStateRef,
} from "./types.js";
import type { MemoryIndexer } from "../memory/indexer.js";

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
};

// ── spawn_subagent (design §6) — the sub-agent contract. ──

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

export type SpawnSubagentExecutor = (
  request: SpawnSubagentRequest,
  onProgress?: (progress: SpawnSubagentProgress) => void,
  signal?: AbortSignal,
) => Promise<SpawnSubagentResult>;

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

/** All dependencies shared by tool factory functions. */
export interface ToolRefs {
  kubeconfigRef: KubeconfigRef;
  userId: string;
  /** Agent ID — used for metrics labeling. Null when running outside an agent context (TUI/CLI). */
  agentId: string | null;
  sessionIdRef: { current: string };
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
  memoryDir?: string;
  /** See SessionEventEmitter. Undefined when running without a session SSE bus. */
  sessionEventEmitter?: SessionEventEmitter;
  /**
   * Optional spawn_subagent executor (design §6). When absent, spawn_subagent
   * stays out of the resolved tool list so the model never sees a non-working tool.
   */
  spawnSubagentExecutor?: SpawnSubagentExecutor;
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
   * Runtime availability check. Return false to skip this tool (create is not called).
   * Use for tools that depend on resources that may not be available
   * (e.g. memoryIndexer initialization failure).
   * Omit = always available.
   */
  available?: (refs: ToolRefs) => boolean;

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

    // 1. session-mode + operating-mode + available check (create not called yet)
    const applicable = this.entries.filter(
      (e) =>
        (!e.modes || e.modes.includes(mode)) &&
        (!e.availableModes || e.availableModes.includes(activeMode)) &&
        (!e.available || e.available(refs)),
    );

    // 2. Instantiate only applicable tools
    const tools = applicable.map((e) => {
      const def = e.create(refs) as ResolvedToolDefinition;
      if (e.requiresUserApproval) {
        def.requiresUserApproval = true;
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
