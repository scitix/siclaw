/**
 * AgentBox session manager
 *
 * Manages multiple sessions within a single AgentBox (a user may have multiple conversations).
 * Reuses createSiclawSession() to create Agents.
 * Supports session persistence via User PV.
 *
 * The memory indexer is shared at the AgentBox level and reused across sessions.
 * MCP connections are created per-session by createSiclawSession and shut down on release.
 * Sessions are released after each prompt completes (request-level lifecycle)
 * and restored from JSONL on the next prompt.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { createSiclawSession } from "../core/agent-factory.js";
import type {
  SpawnSubagentExecutor,
  SpawnSubagentProgress,
  SubagentStep,
  SpawnSubagentRequest,
  SpawnSubagentResult,
  SpawnSubagentStatus,
  SubagentJobStopExecutor,
  SubagentJobStopResult,
} from "../core/tool-registry.js";
import { getSubagentType, DEFAULT_SUBAGENT_TYPE, getSubagentConcurrency } from "../core/subagent-registry.js";
import { ConcurrencyLimiter } from "../core/concurrency-limiter.js";
import { buildDelegateSummaryBundle } from "./delegation-summary.js";
import type { KubeconfigRef, SessionMode, DpStateRef } from "../core/types.js";
import type { BrainSession } from "../core/brain-session.js";
import type { McpClientManager } from "../core/mcp-client.js";
import { createMemoryIndexer, type MemoryIndexer } from "../memory/index.js";
import { saveSessionKnowledge } from "../memory/session-summarizer.js";
import { loadConfig, getEmbeddingConfig, isMemoryEnabled } from "../core/config.js";
import { emitDiagnostic } from "../shared/diagnostic-events.js";
import { buildRedactionConfigForModelConfig, redactText, type RedactionConfig } from "../shared/output-redactor.js";
import { detectLanguage } from "../shared/detect-language.js";
import type {
  DelegationAppendMessagePayload,
  DelegationEventPayload,
  DelegationLineagePayload,
  DelegationPersistenceEvent,
  DelegationPersistenceResponse,
  DelegationToolUpdatePayload,
  DelegationUpdateMessagePayload,
} from "../shared/delegation-persistence.js";
import { isTaskEvent, buildTaskEventChatMessage, type TaskEvent } from "../shared/task-events.js";
import { getOrCreateLedger, deleteLedger, type LedgerTask } from "../core/task-ledger.js";
import type { GatewayClient } from "./gateway-client.js";
// topic-consolidator import removed — consolidation disabled

export interface ManagedSession {
  id: string;
  brain: BrainSession;
  session: AgentSession;  // backward compat — only guaranteed for pi-agent brain
  createdAt: Date;
  lastActiveAt: Date;
  /** Callbacks fired when the current prompt completes */
  _promptDoneCallbacks: Set<() => void>;
  /** Whether auto-compaction is currently in progress */
  isCompacting: boolean;
  /** Whether the agent is currently active (between agent_start and agent_end) */
  isAgentActive: boolean;
  /** Whether an auto-retry is in progress (between auto_retry_start and auto_retry_end) */
  isRetrying: boolean;
  /** Whether the current prompt has finished (for race condition prevention) */
  _promptDone: boolean;
  /** Events buffered during prompt execution (replayed when SSE connects) */
  _eventBuffer: unknown[];
  /** Unsubscribe function for the event buffer subscription */
  _bufferUnsub: (() => void) | null;
  /** Serializes synthetic parent prompts triggered by delegation notifications */
  _syntheticPromptQueue: Promise<void> | null;
  /**
   * Mutex around brain.prompt() — resolves when the current prompt path
   * (HTTP /prompt OR synth notify) lets go. Prevents the TOCTOU race
   * where waitForParentIdle() observed _promptDone === true and the synth
   * path is mid-await when an HTTP /prompt sneaks in: both paths would
   * end up calling brain.prompt() concurrently. Acquired before
   * brain.prompt(), released in finally.
   *
   * TODO(post-247): consolidate _promptDone / _syntheticPromptQueue /
   * _promptInflight into one mutex queue. Three overlapping primitives is
   * harder to reason about than necessary; this lock patches the
   * immediate jacoblee #2/#3 race but the long-term answer is unification
   * (every brain.prompt() callsite chains through a single Promise queue,
   * _promptDone becomes a status flag derived from the queue).
   */
  _promptInflight: Promise<void> | null;
  /** Mutable reference to the active kubeconfig path — tools read .current at execution time */
  kubeconfigRef: KubeconfigRef;
  /** Whether the current prompt was aborted (prevents empty response retry) */
  _aborted: boolean;
  /** Mutable skill dirs array passed to DefaultResourceLoader — update + reload to switch */
  skillsDirs: string[];
  /** Session mode — determines which system skills are loaded */
  mode: SessionMode;
  /** MCP client manager — per-session, shut down on release/close */
  mcpManager?: McpClientManager;
  /** Memory indexer — shared at AgentBox level, NOT per-session */
  memoryIndexer?: MemoryIndexer;
  /** Read-only DP state ref — pi-agent extension writes to this, agentbox exposes it for recovery */
  dpStateRef?: DpStateRef;
  /** Number of JSONL message entries at the time of last memory auto-save (dedup) */
  _lastSavedMessageCount: number;
  /** Pending release timer (cleared when a new prompt arrives before TTL expires) */
  _releaseTimer: ReturnType<typeof setTimeout> | null;
  /** Background work currently owned by this parent session (e.g. detached sub-agent jobs). */
  _backgroundWorkCount: number;
  /**
   * Extra event subscribers — tools (via sessionEventEmitter in ToolRefs) can
   * push custom events here, and the SSE handler forwards them to clients.
   * Used by spawn_subagent to surface child-agent events in the parent
   * session's stream.
   */
  _extraEventSubs: Set<(event: Record<string, unknown>) => void>;
  /** Buffer of extra events fired before an SSE client connects (replayed on connect, like _eventBuffer for brain events). */
  _extraEventBuffer: Record<string, unknown>[];
}

export interface PersistedDpStateSnapshot {
  active: boolean;
}

/** Delay before releasing an idle session (seconds). Gives frontend time to query context/model. */
const SESSION_RELEASE_TTL_MS = 30_000;
/** Delay before auto-clearing a fully-completed plan (CC V2 parity: HIDE_DELAY_MS). */
const LEDGER_AUTOCLEAR_MS = 5_000;
const DELEGATED_AGENT_MAX_RUNTIME_MS = 10 * 60_000;
const DELEGATED_AGENT_ABORT_TIMEOUT_MS = 2_000;
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function abortBrainBestEffort(
  brain: Pick<BrainSession, "abort">,
  label: string,
  timeoutMs = DELEGATED_AGENT_ABORT_TIMEOUT_MS,
): Promise<void> {
  const abortPromise = Promise.resolve()
    .then(() => brain.abort())
    .catch((err) => {
      console.warn(`[agentbox-session] ${label}: abort failed:`, err);
    });
  const outcome = await Promise.race([
    abortPromise.then(() => "done" as const),
    delay(timeoutMs).then(() => "timeout" as const),
  ]);
  if (outcome === "timeout") {
    console.warn(`[agentbox-session] ${label}: abort did not settle within ${timeoutMs}ms; continuing with timeout result`);
  }
}

export class AgentBoxSessionManager {
  private sessions = new Map<string, ManagedSession>();
  private defaultSessionId = "default";

  /** Optional userId — set by LocalSpawner for per-user skill directory isolation */
  userId?: string;

  /** Optional agentId — set by LocalSpawner / K8s spawner; used for metrics labeling */
  agentId?: string;

  /** Optional knowledge base indexer — set by LocalSpawner for knowledge_search tool */
  knowledgeIndexer?: MemoryIndexer;

  /** Optional credential broker — set by http-server for on-demand credential acquisition */
  credentialBroker?: import("./credential-broker.js").CredentialBroker;

  /**
   * Optional Runtime callback client. In K8s, AgentBox runs in a separate pod
   * and must persist delegation/audit rows through Runtime's internal API.
   */
  gatewayClient?: GatewayClient;

  /**
   * Optional override for the directory where the broker materializes credential
   * files. LocalSpawner sets this to a per-user path so multiple
   * AgentBoxes don't collide on a shared credentialsDir. When undefined the
   * broker falls back to `<cwd>/.siclaw/credentials`.
   */
  credentialsDir?: string;

  /** Callback fired after a session is released — used by http-server to check idle status */
  onSessionRelease?: () => void;

  /** Last model selection supplied by the gateway for this AgentBox. */
  private delegationModelProvider?: string;
  private delegationModelId?: string;
  private delegationModelConfig?: Record<string, unknown>;

  // ── Shared components (AgentBox-level, outlive individual sessions) ──
  private _sharedMemoryIndexer: MemoryIndexer | null = null;
  /** Whether shared components have been initialized */
  private _sharedInitialized = false;

  setDelegationModel(opts: {
    provider?: string;
    modelId?: string;
    config?: Record<string, unknown>;
  }): void {
    if (opts.provider) this.delegationModelProvider = opts.provider;
    if (opts.modelId) this.delegationModelId = opts.modelId;
    if (opts.config) this.delegationModelConfig = opts.config;
  }

  /**
   * Get base session storage directory.
   * Reads userDataDir from settings.json.
   */
  private getBaseSessionDir(): string {
    const config = loadConfig();
    const userDataDir = path.resolve(process.cwd(), config.paths.userDataDir);
    return path.join(userDataDir, "agent", "sessions");
  }

  /**
   * Get per-session storage directory.
   * Each gateway sessionId gets its own subdirectory so pi-coding-agent
   * sessions are isolated and correctly restored after pod restarts.
   */
  private getSessionDir(sessionId: string): string {
    const base = this.getBaseSessionDir();
    const dir = path.join(base, sessionId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Get the memory directory path.
   */
  private getMemoryDir(): string {
    const config = loadConfig();
    const userDataDir = path.resolve(process.cwd(), config.paths.userDataDir);
    return path.join(userDataDir, "memory");
  }

  private async createSharedMemoryIndexer(memoryDir: string): Promise<MemoryIndexer> {
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
    const embeddingOpts = getEmbeddingConfig() ?? undefined;
    const indexer = await createMemoryIndexer(memoryDir, embeddingOpts);
    await indexer.sync();
    indexer.startWatching();
    return indexer;
  }

  /**
   * Lazily initialize shared components (memory indexer, MCP manager).
   * Called on first getOrCreate(). Idempotent.
   */
  private async ensureSharedComponents(): Promise<void> {
    if (this._sharedInitialized) return;
    this._sharedInitialized = true;

    if (!isMemoryEnabled()) {
      this._sharedMemoryIndexer = null;
      console.log(`[agentbox-session] Memory disabled by SICLAW_MEMORY_ENABLED`);
      return;
    }

    const memoryDir = this.getMemoryDir();

    // ── Memory indexer ──
    try {
      this._sharedMemoryIndexer = await this.createSharedMemoryIndexer(memoryDir);
      console.log(`[agentbox-session] Shared memory indexer initialized for ${memoryDir}`);
    } catch (err) {
      console.warn(`[agentbox-session] Shared memory indexer init failed:`, err);
      this._sharedMemoryIndexer = null;
    }
    // MCP is initialized per-session inside createSiclawSession via loadConfig().mcpServers.
  }

  /** Pending plan auto-clear timers, keyed by taskListId (all tasks completed → clear after delay). */
  private ledgerHideTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Bounds concurrent foreground sub-agent child sessions across this AgentBox
   * (a wide fan-out emits N spawn_subagent calls that pi runs unbounded). Shared
   * by every session in the pod so the cap is per-pod, not per-conversation.
   */
  private subagentLimiter = new ConcurrencyLimiter(getSubagentConcurrency());

  /** In-flight + recent background sub-agent jobs, keyed by jobId (= spawn tool call id). */
  private subagentJobs = new Map<string, {
    jobId: string;
    childSessionId: string;
    status: "running" | "stopped" | SpawnSubagentStatus;
    description: string;
    abort?: () => void;
    startedAt: number;
  }>();

  private createSpawnSubagentExecutor(): SpawnSubagentExecutor {
    return async (request, onProgress, signal) => {
      if (request.runInBackground) return this.startBackgroundSubagent(request);
      // Cap concurrent foreground children: a wide fan-out queues past the limit
      // instead of spinning up one child agent + LLM stream per target at once.
      const lim = this.subagentLimiter;
      if (lim.atCapacity) {
        console.log(
          `[agentbox-session] sub-agent "${request.description}" queued — ` +
          `${lim.activeCount}/${lim.limit} running, ${lim.pendingCount + 1} waiting (SICLAW_SUBAGENT_CONCURRENCY=${lim.limit})`,
        );
        // Tell the UI this child is waiting for a slot, not running — otherwise pi's
        // batch tool_execution_start already painted it as "running" (spinner).
        onProgress?.({
          status: "queued",
          toolCalls: 0,
          steps: [],
          activity: `Waiting for a free slot (${lim.limit} sub-agents run at a time)…`,
        });
      }
      return lim.run(() => {
        console.log(`[agentbox-session] sub-agent "${request.description}" started — ${lim.activeCount}/${lim.limit} running`);
        // Flip a previously-queued card to "running" immediately on slot acquisition,
        // before the child's first tool call emits progress (avoids a stale "Queued").
        onProgress?.({ status: "running", toolCalls: 0, steps: [] });
        return this.runSpawnedSubagent(request, undefined, onProgress, signal);
      });
    };
  }

  private createSubagentJobStopExecutor(): SubagentJobStopExecutor {
    return async (jobId) => this.stopSubagentJob(jobId);
  }

  /**
   * Launch a sub-agent detached (design §7). Returns immediately with status
   * "launched"; the child's terminal event (persisted to the parent session by
   * runSpawnedSubagent) is the completion notification. Background work blocks
   * session release until it finishes.
   */
  private startBackgroundSubagent(request: SpawnSubagentRequest): SpawnSubagentResult {
    const childSessionId = randomUUID();
    const jobId = request.spawnId;
    this.subagentJobs.set(jobId, {
      jobId,
      childSessionId,
      status: "running",
      description: request.description,
      startedAt: Date.now(),
    });

    const parent = this.sessions.get(request.parentSessionId);
    if (parent) {
      parent._backgroundWorkCount++;
      if (parent._releaseTimer) {
        clearTimeout(parent._releaseTimer);
        parent._releaseTimer = null;
      }
    }

    void this.runSpawnedSubagent(request, { childSessionId, jobId })
      .then((res) => {
        const job = this.subagentJobs.get(jobId);
        if (job && job.status === "running") job.status = res.status;
      })
      .catch((err) => {
        console.warn(`[agentbox-session] background sub-agent ${jobId} failed:`, err);
        const job = this.subagentJobs.get(jobId);
        if (job && job.status === "running") job.status = "failed";
      })
      .finally(() => {
        const current = this.sessions.get(request.parentSessionId);
        if (current) {
          current._backgroundWorkCount = Math.max(0, current._backgroundWorkCount - 1);
          if (current._backgroundWorkCount === 0 && current._promptDone) {
            this.scheduleRelease(current.id);
          }
        }
      });

    return {
      status: "launched",
      summary: "launched",
      childSessionId,
      toolCalls: 0,
      durationMs: 0,
      jobId,
    };
  }

  private async stopSubagentJob(jobId: string): Promise<SubagentJobStopResult> {
    const job = this.subagentJobs.get(jobId);
    if (!job) return { stopped: false, message: `No background job "${jobId}".` };
    if (job.status !== "running") return { stopped: false, message: `Job "${jobId}" is not running (${job.status}).` };
    if (!job.abort) return { stopped: false, message: `Job "${jobId}" is starting up; try again shortly.` };
    job.abort();
    job.status = "stopped";
    return { stopped: true, message: `Stopping background sub-agent "${jobId}".` };
  }

  private async persistDelegationEvent(event: DelegationPersistenceEvent): Promise<DelegationPersistenceResponse> {
    if (!this.gatewayClient) return { ok: false };
    return this.gatewayClient.sendDelegationPersistenceEvent(event);
  }

  private async persistEnsureChatSession(
    sessionId: string,
    agentId: string,
    userId: string,
    title?: string,
    preview?: string,
    origin?: string,
    lineage?: DelegationLineagePayload,
  ): Promise<void> {
    await this.persistDelegationEvent({
      type: "delegation.ensure_session",
      sessionId,
      agentId,
      userId,
      title,
      preview,
      origin,
      lineage,
    });
  }

  private async persistAppendMessage(message: DelegationAppendMessagePayload): Promise<string> {
    const result = await this.persistDelegationEvent({ type: "delegation.append_message", message });
    return result.id ?? "";
  }

  /**
   * Persist a task-ledger mutation as a chat_message (metadata.kind === "task_event"),
   * reusing the delegation append channel. The Web UI folds these into the plan on load,
   * so the plan survives refresh (design §14, Approach A). Best-effort.
   */
  private async persistTaskEvent(sessionId: string, event: TaskEvent): Promise<void> {
    await this.persistAppendMessage(buildTaskEventChatMessage(sessionId, event));
  }

  // ── Backend task-ledger durability (design §14) ────────────────────────────
  // The ledger is in-memory (task-ledger.ts), keyed by taskListId == session id.
  // The module map survives session release within a process; these helpers add
  // a PV-backed snapshot so the plan also survives a full pod/process restart.
  private ledgerFile(taskListId: string): string {
    return path.join(this.getSessionDir(taskListId), ".plan-ledger.json");
  }

  /** Best-effort: write the current ledger snapshot to the PV session dir. */
  private persistLedgerSnapshot(taskListId: string): void {
    const tasks = getOrCreateLedger(taskListId).snapshot();
    void fs.promises
      .writeFile(this.ledgerFile(taskListId), JSON.stringify(tasks), "utf8")
      .catch((err) => console.warn(`[agentbox-session] plan-ledger snapshot failed for ${taskListId}:`, err));
  }

  /** Restore the ledger from the PV snapshot — only when the in-memory copy is
   *  empty (i.e. after a process restart; a release-survived ledger is kept). */
  private rehydrateLedger(taskListId: string): void {
    const ledger = getOrCreateLedger(taskListId);
    if (ledger.size > 0) return;
    try {
      const tasks = JSON.parse(fs.readFileSync(this.ledgerFile(taskListId), "utf8")) as LedgerTask[];
      if (Array.isArray(tasks) && tasks.length > 0) ledger.hydrate(tasks);
    } catch { /* no snapshot (new session) — fine */ }
  }

  /** CC V2 resetTaskList parity: when every task is completed, clear the plan after a
   *  short delay; a new pending task before the timer fires cancels the clear. The
   *  reset is emitted as a task_event so the UI/foldPlan + persistence reset too. The
   *  ledger's id sequence is preserved so the next plan's ids never reuse cleared ones. */
  private scheduleLedgerAutoClear(taskListId: string, emit: (event: Record<string, unknown>) => void): void {
    const existing = this.ledgerHideTimers.get(taskListId);
    if (getOrCreateLedger(taskListId).allCompleted()) {
      if (existing) return; // already scheduled
      const timer = setTimeout(() => {
        this.ledgerHideTimers.delete(taskListId);
        const ledger = getOrCreateLedger(taskListId);
        if (!ledger.allCompleted()) return; // a new task arrived; abort the clear
        ledger.clear();
        emit({ kind: "task_event", taskListId, action: "reset" });
      }, LEDGER_AUTOCLEAR_MS);
      timer.unref?.();
      this.ledgerHideTimers.set(taskListId, timer);
    } else if (existing) {
      clearTimeout(existing);
      this.ledgerHideTimers.delete(taskListId);
    }
  }

  private async persistUpdateMessage(message: DelegationUpdateMessagePayload): Promise<void> {
    await this.persistDelegationEvent({ type: "delegation.update_message", message });
  }

  private async persistUpdateDelegationToolMessage(message: DelegationToolUpdatePayload): Promise<void> {
    await this.persistDelegationEvent({ type: "delegation.update_tool_message", message });
  }

  private async persistAppendDelegationEvent(event: DelegationEventPayload): Promise<string> {
    const result = await this.persistDelegationEvent({ type: "delegation.append_event", event });
    return result.id ?? "";
  }

  /**
   * spawn_subagent executor (design §6). Foreground/blocking: create a child
   * sub-session of the same agent core under the selected agent-type, run the
   * bounded task, and return its final report inline. The child shares the
   * parent's task ledger (taskListId) and is NOT given spawn_subagent (no recursion).
   *
   * Observability (design §13): the child runs as its own persisted session with
   * lineage; every tool call and assistant message is streamed-and-persisted; and a
   * terminal event is ALWAYS emitted (including on failure/timeout) so the full
   * record — and the reason it failed — survives for UI drill-in.
   */
  private async runSpawnedSubagent(
    request: SpawnSubagentRequest,
    opts?: { childSessionId?: string; jobId?: string },
    onProgress?: (progress: SpawnSubagentProgress) => void,
    signal?: AbortSignal,
  ): Promise<SpawnSubagentResult> {
    const startedAt = Date.now();
    const childSessionId = opts?.childSessionId ?? randomUUID();
    const childSessionDir = this.getSessionDir(childSessionId);
    const childSessionManager = SessionManager.continueRecent(process.cwd(), childSessionDir);
    const config = loadConfig();
    const kubeconfigRef: KubeconfigRef = {
      credentialsDir: this.credentialsDir ?? path.resolve(process.cwd(), config.paths.credentialsDir),
      credentialBroker: this.credentialBroker,
    };
    const type = getSubagentType(request.subagentType) ?? getSubagentType(DEFAULT_SUBAGENT_TYPE)!;
    const agentId = request.parentAgentId ?? this.agentId ?? null;

    const child = await createSiclawSession({
      sessionManager: childSessionManager,
      kubeconfigRef,
      mode: "web",
      memoryIndexer: this._sharedMemoryIndexer ?? undefined,
      userId: this.userId,
      agentId,
      knowledgeIndexer: this.knowledgeIndexer,
      // Share the parent's task ledger so the child can own/complete tasks.
      taskListId: request.taskListId,
      // The agent-type's prompt flavour for this child.
      systemPromptAppend: type.systemPromptAddendum,
      // Deliberately omit spawnSubagentExecutor + delegate executors → the child
      // never sees spawn_subagent (no recursion).
    });
    child.sessionIdRef.current = childSessionId;

    // Use the same model the parent's delegated agents use, when configured.
    // (request.model per-call override is accepted by the tool but not yet
    // applied here — a follow-on once model-by-alias resolution is wired.)
    if (this.delegationModelProvider && this.delegationModelConfig && child.brain.registerProvider) {
      child.brain.registerProvider(this.delegationModelProvider, this.delegationModelConfig);
    }
    if (this.delegationModelProvider && this.delegationModelId) {
      const model = child.brain.findModel(this.delegationModelProvider, this.delegationModelId);
      if (model) await child.brain.setModel(model);
    }

    // Cancellation: stopRequested is set by either the parent's abort signal
    // (main "stop" button → the spawn_subagent tool's signal) or job_stop.
    let stopRequested = false;
    const requestStop = (reason: string) => {
      stopRequested = true;
      void abortBrainBestEffort(child.brain, reason);
    };
    if (signal) {
      if (signal.aborted) requestStop(`parent aborted ${childSessionId}`);
      else signal.addEventListener("abort", () => requestStop(`parent aborted ${childSessionId}`), { once: true });
    }
    // Wire job cancellation (job_stop) into this run once the child exists.
    if (opts?.jobId) {
      const job = this.subagentJobs.get(opts.jobId);
      if (job) {
        job.childSessionId = childSessionId;
        job.abort = () => requestStop(`job_stop ${childSessionId}`);
      }
    }

    // ── Transcript persistence (design §13). Serialized via a promise queue so
    //    writes land in order; a write failure disables the trace but never the run. ──
    const delegationId = request.spawnId;
    const redactionConfig = buildRedactionConfigForModelConfig(this.delegationModelConfig);
    const lineage = { parentSessionId: request.parentSessionId, parentAgentId: agentId, delegationId, targetAgentId: agentId };
    let persistTrace = Boolean(agentId && request.userId && request.parentSessionId);
    let persistQueue: Promise<void> = Promise.resolve();
    const enqueuePersist = (op: () => Promise<void>) => {
      if (!persistTrace) return;
      persistQueue = persistQueue.then(op).catch((err) => {
        persistTrace = false;
        console.warn(`[agentbox-session] sub-agent trace persistence disabled for ${childSessionId}:`, err);
      });
    };

    if (persistTrace && agentId) {
      try {
        await this.persistEnsureChatSession(
          childSessionId,
          agentId,
          request.userId,
          `Sub-agent: ${request.description}`,
          redactText(request.prompt, redactionConfig).slice(0, 500),
          "subagent",
          lineage,
        );
        await this.persistAppendMessage({
          sessionId: childSessionId,
          role: "user",
          content: redactText(request.prompt, redactionConfig),
          fromAgentId: agentId,
          parentSessionId: request.parentSessionId,
          delegationId,
          targetAgentId: agentId,
        });
      } catch (err) {
        persistTrace = false;
        console.warn(`[agentbox-session] could not initialize sub-agent trace ${childSessionId}:`, err);
      }
    }

    const extractEventText = (content: unknown): string =>
      Array.isArray(content)
        ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text as string).join("")
        : "";

    let finalText = "";
    let toolCalls = 0;
    let status: SpawnSubagentStatus = "done";
    const pendingTools = new Map<string, { startMs: number; toolName: string; toolInput?: string }>();
    // Ordered steps (assistant reasoning + tool calls) streamed to the parent UI so the
    // card shows the sub-agent's execution live, like a mini main-agent run.
    const liveSteps: SubagentStep[] = [];
    const emitProgress = (activity?: string) =>
      onProgress?.({ status: "running", toolCalls, steps: liveSteps.map((s) => ({ ...s })), activity });

    const unsubscribe = child.brain.subscribe((event: any) => {
      if (event?.type === "tool_execution_start" || event?.type === "tool_start") {
        toolCalls++;
        const toolName = (event.toolName as string) || (event.name as string) || "tool";
        const id = String(event.toolCallId ?? event.toolUseID ?? `${toolName}-${toolCalls}`);
        pendingTools.set(id, {
          startMs: Date.now(),
          toolName,
          toolInput: event.args ? redactText(JSON.stringify(event.args), redactionConfig) : undefined,
        });
        emitProgress(`Running ${toolName}…`);
      }
      if (event?.type === "tool_execution_end" || event?.type === "tool_end") {
        const id = String(event.toolCallId ?? event.toolUseID ?? "");
        const pending = pendingTools.get(id);
        pendingTools.delete(id);
        const toolName = (event.toolName as string) || (event.name as string) || pending?.toolName || "tool";
        const durationMs = pending ? Date.now() - pending.startMs : null;
        const outcome: "success" | "error" = event.isError ? "error" : "success";
        const resultText = redactText(extractEventText(event.result?.content), redactionConfig).slice(0, 4000);
        liveSteps.push({ kind: "tool", toolName, toolInput: pending?.toolInput, content: resultText.slice(0, 1000), outcome, durationMs });
        emitProgress(`Finished ${toolName}`);
        enqueuePersist(async () => {
          await this.persistAppendMessage({
            sessionId: childSessionId,
            role: "tool",
            content: resultText,
            toolName,
            toolInput: pending?.toolInput,
            outcome,
            durationMs,
            fromAgentId: agentId,
            parentSessionId: request.parentSessionId,
            delegationId,
            targetAgentId: agentId,
          });
        });
      }
      if (event?.type === "message_end" && event.message?.role === "assistant") {
        const text = extractEventText(event.message.content).trim();
        if (text) {
          finalText = text;
          liveSteps.push({ kind: "assistant", text: redactText(text, redactionConfig) });
          emitProgress();
          enqueuePersist(async () => {
            await this.persistAppendMessage({
              sessionId: childSessionId,
              role: "assistant",
              content: redactText(text, redactionConfig),
              fromAgentId: agentId,
              parentSessionId: request.parentSessionId,
              delegationId,
              targetAgentId: agentId,
            });
          });
        }
      }
    });

    let interruptedTool: string | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("spawn_subagent_timeout")), DELEGATED_AGENT_MAX_RUNTIME_MS),
      );
      await Promise.race([child.brain.prompt(this.buildSpawnedSubagentPrompt(request)), timeoutPromise]);
    } catch (err) {
      interruptedTool = [...pendingTools.values()][0]?.toolName;
      if (stopRequested) {
        status = "partial";
        finalText = finalText
          ? `Sub-agent cancelled by job_stop. Partial report:\n\n${finalText}`
          : "Sub-agent cancelled by job_stop before producing a report.";
      } else if (err instanceof Error && err.message === "spawn_subagent_timeout") {
        status = "timed_out";
        await abortBrainBestEffort(child.brain, `spawned sub-agent ${childSessionId}`);
        finalText = finalText
          ? `Sub-agent timed out after ${DELEGATED_AGENT_MAX_RUNTIME_MS}ms. Partial report:\n\n${finalText}`
          : `Sub-agent timed out after ${DELEGATED_AGENT_MAX_RUNTIME_MS}ms with no output.`;
      } else {
        status = "failed";
        finalText = finalText || `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } finally {
      unsubscribe();
      await child.mcpManager?.shutdown().catch((err) =>
        console.warn(`[agentbox-session] spawned sub-agent MCP shutdown failed for ${childSessionId}:`, err),
      );
    }

    // If job_stop aborted but prompt() resolved instead of throwing, reflect it.
    if (stopRequested && status === "done") {
      status = "partial";
      finalText = finalText
        ? `Sub-agent cancelled by job_stop. Partial report:\n\n${finalText}`
        : "Sub-agent cancelled by job_stop before producing a report.";
    }

    if (!finalText) {
      if (status === "done") status = "failed";
      finalText = "(sub-agent produced no output)";
    }

    const bundle = buildDelegateSummaryBundle(finalText);
    const durationMs = Date.now() - startedAt;

    // Terminal event ALWAYS — including failure/timeout (design §13 hard requirement).
    enqueuePersist(async () => {
      await this.persistAppendDelegationEvent({
        parentSessionId: request.parentSessionId,
        parentAgentId: agentId,
        userId: request.userId,
        delegationId,
        childSessionId,
        targetAgentId: agentId,
        status,
        capsule: bundle.capsule,
        fullSummary: bundle.fullSummary,
        summaryTruncated: bundle.truncated,
        scope: request.prompt,
        toolCalls,
        durationMs,
        interruptedTool,
      });
    });
    await persistQueue;

    return {
      status,
      summary: bundle.capsule,
      fullSummary: bundle.fullSummary,
      childSessionId,
      toolCalls,
      durationMs,
      interruptedTool,
      steps: liveSteps,
    };
  }

  private buildSpawnedSubagentPrompt(request: SpawnSubagentRequest): string {
    // Make the sub-agent answer in the user's language (same mechanism the main
    // agent uses): detect from the briefing the parent wrote and inject the directive.
    const lang = detectLanguage(`${request.description}\n${request.prompt}`);
    const langDirective = lang !== "English" ? `[System: respond in ${lang}]\n` : "";
    return `${langDirective}Task: ${request.description}\n\n${request.prompt.trim()}\n\n` +
      `Complete this task now and end with a concise findings report — the caller only sees your ` +
      `final report, not your intermediate steps. Do not ask for confirmation.`;
  }

  /**
   * Get or create a session.
   * Each gateway sessionId maps to its own pi-coding-agent session directory,
   * so pod restarts correctly restore the matching conversation context.
   *
   * After Phase 2, sessions are released after each prompt completes.
   * getOrCreate() restores from JSONL, reusing shared components for fast recovery.
   */
  async getOrCreate(
    sessionId?: string,
    mode?: SessionMode,
    systemPromptTemplate?: string,
  ): Promise<ManagedSession> {
    const id = sessionId || this.defaultSessionId;

    const existing = this.sessions.get(id);
    if (existing) {
      existing.lastActiveAt = new Date();
      // Cancel pending release — session is being reused
      if (existing._releaseTimer) {
        clearTimeout(existing._releaseTimer);
        existing._releaseTimer = null;
        console.log(`[agentbox-session] Cancelled pending release for session ${id}`);
      }
      return existing;
    }

    // Ensure shared components are ready
    await this.ensureSharedComponents();

    const sessionDir = this.getSessionDir(id);
    console.log(`[agentbox-session] Creating session: ${id} in ${sessionDir}`);

    if (isMemoryEnabled()) {
      const memoryDir = this.getMemoryDir();
      if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true });
      }
    }

    // continueRecent with proper cwd + sessionDir — restores the correct
    // conversation after pod restart, or creates new if directory is empty.
    // NOTE: cwd is the first arg (stored in session header), sessionDir is
    // the second (where JSONL files are stored). Passing sessionDir as cwd
    // caused pi-agent to encode the path and store JSONL in a different dir.
    const frameworkSessionManager = SessionManager.continueRecent(process.cwd(), sessionDir);
    const isNewSession = frameworkSessionManager.getEntries().length <= 1; // only session header

    const config = loadConfig();
    const kubeconfigRef: KubeconfigRef = {
      // Prefer the per-user dir set by LocalSpawner; fall back to the
      // config-driven global path (K8s mode and TUI both use this).
      credentialsDir: this.credentialsDir ?? path.resolve(process.cwd(), config.paths.credentialsDir),
      credentialBroker: this.credentialBroker,
    };
    const effectiveMode = mode ?? "web";

    // Per-session extra event bus — tools (e.g. spawn_subagent) use
    // this to push custom events into the SSE stream alongside the brain's events.
    // Allocated BEFORE createSiclawSession so we can wire the emitter into
    // ToolRefs. Buffered events replay to the SSE handler on connect.
    const extraEventSubs = new Set<(event: Record<string, unknown>) => void>();
    const extraEventBuffer: Record<string, unknown>[] = [];
    // Cap the buffer so a long batch with no SSE client (e.g. user closed
    // the tab while a 10-min delegation runs) cannot grow the heap without
    // bound. 1000 events is far above any realistic SSE catch-up window.
    // On overflow, drop the OLDEST event — late connectors lose context but
    // never OOM the agentbox process. Warn once per session so operators
    // can see when it happens; subsequent drops stay silent.
    const EXTRA_EVENT_BUFFER_CAP = 1000;
    let extraEventBufferOverflowed = false;
    const emitExtraEvent = (event: Record<string, unknown>) => {
      // Task ledger events are persisted (refresh recovery, design §14 Approach A)
      // in addition to being streamed live below.
      if (isTaskEvent(event)) {
        void this.persistTaskEvent(id, event).catch((err) =>
          console.warn(`[agentbox-session] task_event persist failed for ${id}:`, err),
        );
        // Snapshot the (shared) ledger to the PV session dir so the backend plan
        // survives a pod/process restart — keyed by the event's taskListId (the
        // parent's id, even when a sub-agent mutated a task it owns).
        this.persistLedgerSnapshot(event.taskListId ?? id);
        // CC V2 parity: once the whole plan is completed, auto-clear it after a
        // short delay (a new pending task before then cancels the clear).
        if (event.action !== "reset") this.scheduleLedgerAutoClear(event.taskListId ?? id, emitExtraEvent);
      }
      if (extraEventSubs.size === 0) {
        extraEventBuffer.push(event);
        if (extraEventBuffer.length > EXTRA_EVENT_BUFFER_CAP) {
          extraEventBuffer.shift();
          if (!extraEventBufferOverflowed) {
            extraEventBufferOverflowed = true;
            console.warn(`[agentbox-session] extra event buffer for session ${id} exceeded ${EXTRA_EVENT_BUFFER_CAP}; dropping oldest events`);
          }
        }
      } else for (const sub of extraEventSubs) { try { sub(event); } catch { /* best-effort */ } }
    };

    // Rehydrate the task ledger before the agent runs. The module-level ledger
    // map survives session release within a process; this restores it after a
    // full pod/process restart from the PV snapshot. taskListId == session id.
    this.rehydrateLedger(id);

    const result = await createSiclawSession({
      sessionManager: frameworkSessionManager,
      kubeconfigRef,
      mode: effectiveMode,
      memoryIndexer: this._sharedMemoryIndexer ?? undefined,
      userId: this.userId,
      agentId: this.agentId ?? null,
      knowledgeIndexer: this.knowledgeIndexer,
      systemPromptTemplate,
      // Stable per-session ledger key so the plan survives release/rebuild
      // (a fresh random id would orphan the prior in-memory ledger every turn).
      taskListId: id,
      sessionEventEmitter: emitExtraEvent,
      // spawn_subagent is available in normal chat (top-level sessions only — child
      // sessions above omit this executor, so sub-agents cannot recurse).
      spawnSubagentExecutor: this.createSpawnSubagentExecutor(),
      subagentJobStopExecutor: this.createSubagentJobStopExecutor(),
    });

    // Populate sessionIdRef so skill_call events can associate with this session
    result.sessionIdRef.current = id;

    // New session: sync memory index, then purge stale investigations (chained to avoid race)
    if (isMemoryEnabled() && isNewSession && this._sharedMemoryIndexer) {
      const memDir = this.getMemoryDir();
      this._sharedMemoryIndexer.sync()
        .then(() => this._sharedMemoryIndexer!.purgeStaleInvestigations(memDir, { skipSync: true }))
        .catch(err => console.warn("[agentbox-session] Memory sync/purge failed:", err));
    }

    const managed: ManagedSession = {
      id,
      brain: result.brain,
      session: result.session,
      createdAt: new Date(),
      lastActiveAt: new Date(),
      _promptDoneCallbacks: new Set(),
      isCompacting: false,
      isAgentActive: false,
      isRetrying: false,
      _promptDone: true,
      _eventBuffer: [],
      _bufferUnsub: null,
      _syntheticPromptQueue: null,
      kubeconfigRef,
      _aborted: false,
      skillsDirs: result.skillsDirs,
      mode: effectiveMode,
      // Per-session references point to shared instances (not owned by session)
      mcpManager: result.mcpManager,
      memoryIndexer: result.memoryIndexer,
      dpStateRef: result.dpStateRef,
      _lastSavedMessageCount: 0,
      _releaseTimer: null,
      _backgroundWorkCount: 0,
      _promptInflight: null,
      _extraEventSubs: extraEventSubs,
      _extraEventBuffer: extraEventBuffer,
    };

    this.sessions.set(id, managed);
    emitDiagnostic({ type: "session_created", sessionId: id });

    // Tool execution timing (for tool_call diagnostic events).
    // NOTE: tool_execution_start/end events depend on pi-agent's event stream —
    // if these events aren't emitted, tool metrics will be zero for those
    // sessions (best-effort, no incorrect data).
    // Key by toolCallId (unique per invocation) to avoid concurrent same-name tool overwrites.
    const toolStartTimes = new Map<string, { name: string; startMs: number }>();
    let toolCallSeq = 0;

    // Track agent lifecycle state + debug logging
    result.brain.subscribe((event: any) => {
      // Update lastActiveAt on every event (used by Phase 2 stuck detection)
      managed!.lastActiveAt = new Date();

      // Tool execution metrics
      if (event.type === "tool_execution_start") {
        const callId = event.toolCallId ?? `seq-${++toolCallSeq}`;
        toolStartTimes.set(callId, { name: event.toolName, startMs: Date.now() });
      } else if (event.type === "tool_execution_end") {
        const callId = event.toolCallId ?? `seq-${toolCallSeq}`;
        const entry = toolStartTimes.get(callId);
        toolStartTimes.delete(callId);
        emitDiagnostic({
          type: "tool_call",
          toolName: event.toolName ?? entry?.name ?? "unknown",
          outcome: event.isError ? "error" : "success",
          durationMs: entry ? Date.now() - entry.startMs : 0,
          userId: this.userId ?? "unknown",
          agentId: this.agentId ?? null,
        });
      }
      if (event.type === "agent_start") {
        managed!.isAgentActive = true;
      } else if (event.type === "agent_end") {
        managed!.isAgentActive = false;
      } else if (event.type === "auto_compaction_start") {
        managed!.isCompacting = true;
      } else if (event.type === "auto_compaction_end") {
        managed!.isCompacting = false;
      } else if (event.type === "auto_retry_start") {
        managed!.isRetrying = true;
      } else if (event.type === "auto_retry_end") {
        managed!.isRetrying = false;
      }

      // Debug logging for diagnosing mid-execution stops
      switch (event.type) {
        case "agent_start":
          console.log(`[agentbox-debug] [${id}] agent_start`);
          break;
        case "agent_end":
          console.log(`[agentbox-debug] [${id}] agent_end messages=${event.messages?.length ?? 0}`);
          break;
        case "turn_start":
          console.log(`[agentbox-debug] [${id}] turn_start`);
          break;
        case "turn_end":
          console.log(`[agentbox-debug] [${id}] turn_end toolResults=${event.toolResults?.length ?? 0}`);
          break;
        case "message_start":
          console.log(`[agentbox-debug] [${id}] message_start role=${event.message?.role}`);
          break;
        case "message_end": {
          const msg = event.message;
          const contentArr = Array.isArray(msg?.content) ? msg.content : [];
          const textParts = contentArr
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("")
            .slice(0, 500);
          const toolCallNames = contentArr
            .filter((c: any) => c.type === "toolCall")
            .map((c: any) => c.name);
          console.log(`[agentbox-debug] [${id}] message_end role=${msg?.role} stopReason=${msg?.stopReason} toolCalls=[${toolCallNames?.join(",")}] text=${textParts?.slice(0, 200)} error=${msg?.errorMessage?.slice(0, 300) ?? ""}`);
          break;
        }
        case "tool_execution_start":
          console.log(`[agentbox-debug] [${id}] tool_start name=${event.toolName} args=${JSON.stringify(event.args).slice(0, 200)}`);
          break;
        case "tool_execution_end": {
          const resultText = event.result?.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text ?? "")
            .join("") ?? "";
          console.log(`[agentbox-debug] [${id}] tool_end name=${event.toolName} isError=${event.isError} resultSize=${resultText.length}`);
          break;
        }
        case "auto_compaction_start":
          console.log(`[agentbox-debug] [${id}] compaction_start reason=${event.reason}`);
          break;
        case "auto_compaction_end":
          console.log(`[agentbox-debug] [${id}] compaction_end aborted=${event.aborted} willRetry=${event.willRetry} error=${event.errorMessage}`);
          break;
        case "auto_retry_start":
          console.log(`[agentbox-debug] [${id}] retry_start attempt=${event.attempt}/${event.maxAttempts} delay=${event.delayMs}ms error=${event.errorMessage}`);
          break;
        case "auto_retry_end":
          console.log(`[agentbox-debug] [${id}] retry_end success=${event.success} attempt=${event.attempt} error=${event.finalError}`);
          break;
      }
    });

    return managed;
  }

  /**
   * Get an existing session.
   */
  get(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Read the last persisted dp-mode snapshot from the session JSONL without
   * restoring the full session into memory.
   */
  getPersistedDpState(sessionId: string): PersistedDpStateSnapshot | null {
    try {
      const sessionDir = path.join(this.getBaseSessionDir(), sessionId);
      if (!fs.existsSync(sessionDir)) return null;

      const frameworkSessionManager = SessionManager.continueRecent(process.cwd(), sessionDir);
      const entry = frameworkSessionManager.getEntries()
        .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "dp-mode")
        .pop() as { data?: {
          active?: boolean;
          enabled?: boolean;
          dpStatus?: string;
          checklist?: unknown;
          phase?: string;
        } } | undefined;

      if (!entry?.data) return null;

      // New shape: {active: boolean}
      if (typeof entry.data.active === "boolean") {
        return { active: entry.data.active };
      }
      // Legacy: {enabled: bool}, {dpStatus: "idle"|"investigating"|...},
      // or presence of checklist/phase under the old state machine.
      if (entry.data.enabled === true) return { active: true };
      if (entry.data.dpStatus && entry.data.dpStatus !== "idle") return { active: true };
      if (entry.data.checklist) return { active: true };
      if (entry.data.phase && entry.data.phase !== "idle") return { active: true };
      return { active: false };
    } catch (err) {
      console.warn(`[agentbox-session] Failed to read persisted dp-state for ${sessionId}:`, err);
    }

    return null;
  }

  /**
   * List all sessions.
   */
  list(): ManagedSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get the number of active (in-memory) sessions.
   * Used by http-server idle self-destruct to decide when to start the shutdown timer.
   */
  activeCount(): number {
    return this.sessions.size;
  }

  /**
   * Schedule a delayed release for a session.
   *
   * Defaults to SESSION_RELEASE_TTL_MS (idle-release grace window). Callers can
   * pass `ttlMs=0` for a "next-tick" release — the timer still goes through
   * setTimeout, which means a getOrCreate() landing on the same session before
   * the timer fires can cleanly clearTimeout() and avoid the shutdown. This
   * cancel-window matters for reload-triggered invalidate(): see
   * docs/design/mcp-session-lifecycle.md.
   */
  scheduleRelease(sessionId: string, ttlMs: number = SESSION_RELEASE_TTL_MS): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;

    if (managed._backgroundWorkCount > 0) {
      console.log(
        `[agentbox-session] Deferring release for session ${sessionId}; ` +
        `${managed._backgroundWorkCount} background delegation batch(es) still running`,
      );
      return;
    }

    // Clear any existing timer
    if (managed._releaseTimer) {
      clearTimeout(managed._releaseTimer);
    }

    console.log(`[agentbox-session] Scheduling release for session ${sessionId} in ${ttlMs}ms`);
    managed._releaseTimer = setTimeout(() => {
      managed._releaseTimer = null;
      this.release(sessionId).catch((err) => {
        console.warn(`[agentbox-session] Scheduled release failed for ${sessionId}:`, err);
      });
    }, ttlMs);
  }

  /**
   * Release a session after prompt completion.
   *
   * When memory is enabled, performs memory auto-save (if new messages since
   * last save) and syncs the shared memory index, then removes the session
   * from the in-memory map.
   * Shared components (memory indexer, MCP) are NOT destroyed.
   *
   * The session can be transparently restored from JSONL on the next getOrCreate().
   */
  async release(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;

    console.log(`[agentbox-session] Releasing session: ${sessionId}`);

    // 1. Auto-save session memory (dedup: only if new messages since last save)
    if (isMemoryEnabled()) {
      try {
        const sessionDir = this.getSessionDir(sessionId);
        const memoryDir = this.getMemoryDir();
        const currentMessageCount = this.countJsonlMessages(sessionDir);

        if (currentMessageCount > managed._lastSavedMessageCount) {
          const saved = await saveSessionKnowledge({ sessionDir, memoryDir });
          if (saved) {
            managed._lastSavedMessageCount = currentMessageCount;
            console.log(`[agentbox-session] Memory auto-saved for ${sessionId}: ${saved.map(f => path.basename(f)).join(", ")}`);
          }
        } else {
          console.log(`[agentbox-session] Skipping memory auto-save for ${sessionId} (no new messages)`);
        }
      } catch (err) {
        console.warn(`[agentbox-session] Memory auto-save failed for ${sessionId}:`, err);
      }
    } else {
      console.log(`[agentbox-session] Skipping memory auto-save for ${sessionId} (memory disabled)`);
    }

    // 2. Shutdown per-session MCP connections
    if (managed.mcpManager) {
      try {
        await managed.mcpManager.shutdown();
      } catch (err) {
        console.warn(`[agentbox-session] MCP shutdown failed for ${sessionId}:`, err);
      }
    }

    // 3. Sync shared memory index to pick up the new summary file
    if (isMemoryEnabled() && this._sharedMemoryIndexer) {
      await this._sharedMemoryIndexer.sync().catch((err) => {
        console.warn(`[agentbox-session] Memory sync on release failed:`, err);
      });
    }

    // 3. Remove session from map (shared components remain alive).
    // Guard: only delete if the map still holds the same instance — a new
    // getOrCreate() may have replaced it while release() was running async.
    if (this.sessions.get(sessionId) === managed) {
      this.sessions.delete(sessionId);
      emitDiagnostic({ type: "session_released", sessionId });
      console.log(`[agentbox-session] Session released: ${sessionId} (${this.sessions.size} remaining)`);
      // Notify http-server to check idle status
      this.onSessionRelease?.();
    } else {
      console.log(`[agentbox-session] Session ${sessionId} was replaced during release, skipping delete`);
    }
  }

  /**
   * Count message entries in the latest JSONL file for dedup tracking.
   */
  private countJsonlMessages(sessionDir: string): number {
    try {
      const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
      if (files.length === 0) {
        console.log(`[agentbox-session] countJsonlMessages: no .jsonl files in ${sessionDir}`);
        return 0;
      }

      // Find the most recent file
      files.sort((a, b) => {
        const aTime = fs.statSync(path.join(sessionDir, a)).mtimeMs;
        const bTime = fs.statSync(path.join(sessionDir, b)).mtimeMs;
        return bTime - aTime;
      });

      const jsonlPath = path.join(sessionDir, files[0]);
      const content = fs.readFileSync(jsonlPath, "utf-8");
      let count = 0;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant")) {
            count++;
          }
        } catch { /* skip malformed */ }
      }
      console.log(`[agentbox-session] countJsonlMessages: ${count} messages in ${jsonlPath}`);
      return count;
    } catch (err) {
      console.warn(`[agentbox-session] countJsonlMessages error:`, err);
      return 0;
    }
  }

  /**
   * Close the specified session (explicit user action, e.g. /new or /reset).
   * Unlike release(), this is for permanent closure — but shared components
   * are still NOT destroyed (they belong to the AgentBox).
   */
  async close(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      console.log(`[agentbox-session] Closing session: ${sessionId}`);
      if (managed._releaseTimer) {
        clearTimeout(managed._releaseTimer);
        managed._releaseTimer = null;
      }
      // Shutdown per-session MCP connections
      if (managed.mcpManager) {
        try {
          await managed.mcpManager.shutdown();
        } catch (err) {
          console.warn(`[agentbox-session] MCP shutdown failed for ${sessionId}:`, err);
        }
      }
      // Sync shared memory index (don't close it — it's shared)
      if (this._sharedMemoryIndexer) {
        try {
          await this._sharedMemoryIndexer.sync();
        } catch (err) {
          console.warn(`[agentbox-session] Memory sync on close failed:`, err);
        }
      }
      this.sessions.delete(sessionId);
      // Permanent closure — drop the in-memory ledger so it doesn't accumulate
      // (the durable snapshot + Portal task_events remain for history/recovery).
      const hideTimer = this.ledgerHideTimers.get(sessionId);
      if (hideTimer) {
        clearTimeout(hideTimer);
        this.ledgerHideTimers.delete(sessionId);
      }
      deleteLedger(sessionId);
      emitDiagnostic({ type: "session_released", sessionId });
    }
  }

  /**
   * Close all sessions and destroy shared components.
   * Called on AgentBox shutdown.
   */
  async closeAll(): Promise<void> {
    console.log(`[agentbox-session] Closing all sessions (${this.sessions.size})`);
    // Snapshot and clear the map atomically — prevents in-flight release()
    // from emitting a duplicate session_released for the same session.
    const snapshot = new Map(this.sessions);
    this.sessions.clear();

    for (const [id, managed] of snapshot) {
      if (managed._releaseTimer) {
        clearTimeout(managed._releaseTimer);
        managed._releaseTimer = null;
      }
      // Shutdown per-session MCP connections
      if (managed.mcpManager) {
        try {
          await managed.mcpManager.shutdown();
        } catch (err) {
          console.warn(`[agentbox-session] MCP shutdown failed for ${id} during closeAll:`, err);
        }
      }
      emitDiagnostic({ type: "session_released", sessionId: id });
    }

    // Close shared memory indexer
    if (this._sharedMemoryIndexer) {
      try {
        await this._sharedMemoryIndexer.sync();
        this._sharedMemoryIndexer.close();
        console.log(`[agentbox-session] Shared memory indexer closed`);
      } catch (err) {
        console.warn(`[agentbox-session] Shared memory indexer close error:`, err);
      }
      this._sharedMemoryIndexer = null;
    }

    this._sharedInitialized = false;
  }

  /**
   * Reset the shared memory indexer.
   * Called after Gateway has cleared memory files on PVC.
   * Gateway deletes the full memory/ directory, including .memory.db, so a
   * live AgentBox must close the old sqlite handle and build a fresh indexer.
   */
  async resetMemory(): Promise<void> {
    if (!isMemoryEnabled()) {
      if (this._sharedMemoryIndexer) {
        try {
          this._sharedMemoryIndexer.close();
        } catch (err) {
          console.warn(`[agentbox-session] Memory indexer close during disabled reset failed:`, err);
        }
        this._sharedMemoryIndexer = null;
      }
      console.log(`[agentbox-session] Memory disabled; resetMemory is a no-op`);
      return;
    }

    if (!this._sharedMemoryIndexer) {
      console.log(`[agentbox-session] No memory indexer to reset`);
      return;
    }

    try {
      this._sharedMemoryIndexer.close();
    } catch (err) {
      console.warn(`[agentbox-session] Memory indexer close before reset failed:`, err);
    }
    this._sharedMemoryIndexer = null;

    try {
      const memoryDir = this.getMemoryDir();
      this._sharedMemoryIndexer = await this.createSharedMemoryIndexer(memoryDir);
      console.log(`[agentbox-session] Memory indexer rebuilt after PVC cleanup`);
    } catch (err) {
      console.warn(`[agentbox-session] Memory indexer rebuild after reset failed:`, err);
    }
  }
}
