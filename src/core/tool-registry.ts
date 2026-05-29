/**
 * Tool Registry — declarative tool registration and resolution.
 *
 * Each tool file exports a `registration: ToolEntry` that declares its
 * metadata (category, modes, platform exemption, availability guard).
 * The registry collects all entries and resolves the final tool list
 * in one pass: mode filter → available check → instantiate → allowedTools filter.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
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

export interface DelegateToAgentRequest {
  /** Target agent id. "self" means spawn a same-agent sub-session. */
  agentId: string;
  /** Specific task for the delegated agent. */
  scope: string;
  /** Optional compact context selected by the caller model. */
  contextSummary?: string;
  /** Parent chat/session metadata for lineage and UI grouping. */
  parentSessionId: string;
  parentAgentId: string | null;
  userId: string;
  /** Stable id tying the parent tool call and delegated child sessions together. */
  delegationId?: string;
  /** 1-based task index inside a batch delegation. */
  taskIndex?: number;
  /** Total delegated tasks in the batch. */
  totalTasks?: number;
}

export type DelegateToAgentStatus = "done" | "partial" | "failed" | "timed_out";

export interface DelegateToAgentToolTraceEntry {
  toolName: string;
  toolInput?: string | null;
  outcome: "success" | "error" | "blocked";
  durationMs: number | null;
  contentPreview?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface DelegateToAgentResult {
  /** Execution status for UI recovery and parent-agent interpretation. */
  status?: DelegateToAgentStatus;
  /** Budgeted capsule returned to the parent agent as model-visible tool content. */
  summary: string;
  /** Full sub-agent final report for UI/debug persistence; not sent in model-visible tool content. */
  fullSummary?: string;
  summaryTruncated?: boolean;
  sessionId: string;
  toolCalls: number;
  durationMs: number;
  /** Lightweight UI trace. Full redacted output is persisted in the child execution session. */
  toolTrace?: DelegateToAgentToolTraceEntry[];
  /** Audit/UI-only source for partial delegated results. Not intended for parent model context. */
  partialSource?: "steered" | "runtime_fallback";
  /** Audit/UI-only tool name that was still active when a partial fallback was produced. */
  interruptedTool?: string;
}

export type DelegateToAgentExecutor = (
  request: DelegateToAgentRequest,
) => Promise<DelegateToAgentResult>;

export interface DelegateToAgentsTaskRequest {
  index: number;
  agentId: string;
  scope: string;
  contextSummary?: string;
}

export interface DelegateToAgentsRequest {
  delegationId: string;
  parentSessionId: string;
  parentAgentId: string | null;
  userId: string;
  tasks: DelegateToAgentsTaskRequest[];
}

export interface DelegateToAgentsTaskStartResult {
  index: number;
  status: "running";
  agent_id: string;
  scope: string;
  summary: string;
  tool_calls: 0;
  duration_ms: 0;
}

export interface DelegateToAgentsStartResult {
  status: "running";
  delegation_id: string;
  /**
   * False while the batch is still running. The model must wait for the
   * delegation.batch_complete notification before treating delegated evidence as
   * available.
   */
  results_available: false;
  next_event: "delegation.batch_complete";
  parent_instruction: string;
  tasks: DelegateToAgentsTaskStartResult[];
  total_tool_calls: 0;
  duration_ms: 0;
}

export type DelegateToAgentsExecutor = (
  request: DelegateToAgentsRequest,
) => Promise<DelegateToAgentsStartResult>;

// ── spawn_subagent (design §6) — the v2 sub-agent contract. Independent of the
//    legacy DelegateToAgent* shape above. ──

/** "launched" is the immediate return for a background spawn; it is never a terminal/persisted status. */
export type SpawnSubagentStatus = "done" | "partial" | "failed" | "timed_out" | "launched";

export interface SpawnSubagentRequest {
  /** Short UI label for the spawned task. */
  description: string;
  /** The bounded task briefing — the child's only context besides its system prompt. */
  prompt: string;
  /** Resolved sub-agent type id (see subagent-registry). */
  subagentType: string;
  /** Optional model override; defaults to the type's model / parent inherit. */
  model?: string;
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

export interface SpawnSubagentResult {
  status: SpawnSubagentStatus;
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
  /** Set when status === "launched": the background job id, usable with job_stop. */
  jobId?: string;
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
  status: "running";
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

export interface SubagentJobStopResult {
  stopped: boolean;
  message: string;
}

/** Cancels a running background sub-agent job (design §7: job_stop). */
export type SubagentJobStopExecutor = (jobId: string) => Promise<SubagentJobStopResult>;

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
  memoryRef: MemoryRef;
  dpStateRef: DpStateRef;
  knowledgeIndexer?: MemoryIndexer;
  memoryIndexer?: MemoryIndexer;
  memoryDir?: string;
  /** See SessionEventEmitter. Undefined when running without a session SSE bus. */
  sessionEventEmitter?: SessionEventEmitter;
  /**
   * Optional delegation executor. When absent, delegate_to_agent stays out of
   * the resolved tool list, so the model never sees a non-working tool.
   */
  delegateToAgentExecutor?: DelegateToAgentExecutor;
  /**
   * Optional batch delegation executor. The model sees one batch tool; the
   * runtime handles background execution and parent-session notification.
   */
  delegateToAgentsExecutor?: DelegateToAgentsExecutor;
  /**
   * Optional spawn_subagent executor (design §6). When absent, spawn_subagent
   * stays out of the resolved tool list so the model never sees a non-working tool.
   */
  spawnSubagentExecutor?: SpawnSubagentExecutor;
  /** Cancels a running background sub-agent job (design §7). Enables the job_stop tool. */
  subagentJobStopExecutor?: SubagentJobStopExecutor;
}

/** Declarative registration for a single tool. */
export interface ToolEntry {
  /** Tool category — documentation only, not used for filtering. */
  category: "cmd-exec" | "script-exec" | "query" | "workflow";

  /**
   * Factory function — receives shared refs, returns a ToolDefinition.
   * If your tool accesses optional refs (memoryIndexer, memoryDir, knowledgeIndexer),
   * you MUST provide an `available` guard that checks them. The registry calls
   * `available` before `create` — the guard is the safety net for `!` assertions.
   */
  create: (refs: ToolRefs) => ToolDefinition;

  /**
   * Session modes where this tool is available. Omit = all modes.
   * Replaces the scattered `if (mode === "web")` logic in agent-factory.
   */
  modes?: SessionMode[];

  /** Platform tool — exempt from allowedTools workspace filtering. */
  platform?: boolean;

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
   * 3. Apply allowedTools whitelist (platform tools exempt)
   */
  resolve(opts: {
    mode: SessionMode;
    refs: ToolRefs;
    allowedTools?: string[] | null;
  }): ResolvedToolDefinition[] {
    const { mode, refs, allowedTools } = opts;

    // 1. mode filter + available check (create not called yet)
    const applicable = this.entries.filter(
      (e) =>
        (!e.modes || e.modes.includes(mode)) &&
        (!e.available || e.available(refs)),
    );

    // 2. Instantiate only applicable tools
    const tools = applicable.map((e) => {
      const def = e.create(refs) as ResolvedToolDefinition;
      if (e.requiresUserApproval) {
        def.requiresUserApproval = true;
      }
      return {
        def,
        platform: e.platform ?? false,
      };
    });

    // 3. allowedTools whitelist (platform tools exempt)
    if (Array.isArray(allowedTools)) {
      const allowed = new Set(allowedTools);
      return tools
        .filter((t) => t.platform || allowed.has(t.def.name))
        .map((t) => t.def);
    }

    return tools.map((t) => t.def);
  }
}
