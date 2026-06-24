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
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSiclawSession } from "../core/agent-factory.js";
import type {
  SpawnSubagentExecutor,
  SpawnSubagentProgress,
  SubagentStep,
  SpawnSubagentRequest,
  SpawnSubagentResult,
  SpawnSubagentStatus,
  JobStopExecutor,
  BackgroundExecExecutor,
  TaskOutputReader,
  ChannelMessageExecutor,
  AgentMode,
} from "../core/tool-registry.js";
import { getSubagentType, DEFAULT_SUBAGENT_TYPE, getSubagentConcurrency, getSubagentMaxRuntimeMs, getBackgroundBashConcurrency } from "../core/subagent-registry.js";
import { JobRegistry, type JobStatus } from "../core/job-registry.js";
import { buildNotificationBatch, type TaskNotification } from "../core/task-notification.js";
import { spawnBackgroundBash } from "../core/background-bash-runner.js";
import { DiskTaskOutput, getTaskOutputPath } from "../tools/cmd-exec/disk-output.js";
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
import {
  createModelRouteState,
  normalizeModelRouteState,
  runPromptWithModelRouting,
  resolveEffectivePolicy,
  type ModelRouteEvent,
  type ModelRoutePolicy,
  type ModelRouteState,
} from "../core/model-routing.js";
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
  /** Active operating mode (normal/dp/…) this agent was built for — drives rebuild on change. */
  activeMode: AgentMode;
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
  /** Per-session model routing state, persisted as a sidecar under the session directory. */
  modelRouteState: ModelRouteState;
  /** Last normalized model routing policy supplied by Runtime/Portal for this session. */
  modelRoutePolicy?: ModelRoutePolicy;
  /** When true, brain events are emitted by the route runner after attempt filtering. */
  _routeBrainEventsThroughExtra: boolean;
  /**
   * Extra event subscribers — tools (via sessionEventEmitter in ToolRefs) can
   * push custom events here, and the SSE handler forwards them to clients.
   * Used by spawn_subagent to surface child-agent events in the parent
   * session's stream.
   */
  _extraEventSubs: Set<(event: Record<string, unknown>) => void>;
  /** Buffer of extra events fired before an SSE client connects (replayed on connect, like _eventBuffer for brain events). */
  _extraEventBuffer: Record<string, unknown>[];
  /**
   * Completion notifications claimed but not yet delivered, plus a short coalescing timer.
   * A burst of background jobs finishing close together (e.g. an RDMA server + client) is
   * delivered as ONE synthetic turn instead of N — so the model reacts once rather than
   * re-summarizing per completion. See notifyParent / flushPendingNotifications.
   */
  _pendingNotifications: TaskNotification[];
  _coalesceTimer: ReturnType<typeof setTimeout> | null;
}

export interface PersistedDpStateSnapshot {
  active: boolean;
}

/** Delay before releasing an idle session (seconds). Gives frontend time to query context/model. */
const SESSION_RELEASE_TTL_MS = 30_000;
/**
 * Window for coalescing background-job completion notifications when the parent is idle.
 * A burst finishing within this window becomes ONE synthetic turn. Short enough to be
 * imperceptible for background work, well under SESSION_RELEASE_TTL_MS so the synthetic
 * turn (which clears the release timer) always wins the race.
 */
const NOTIFICATION_COALESCE_MS = 600;
/** One-time guard for the "synthetic turn can't persist" diagnostic (see runSyntheticPrompt). */
let warnedNoPersist = false;
/** Delay before auto-clearing a fully-completed plan (CC V2 parity: HIDE_DELAY_MS). */
const LEDGER_AUTOCLEAR_MS = 5_000;
const DELEGATED_AGENT_MAX_RUNTIME_MS = getSubagentMaxRuntimeMs();
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
  /** Per-session write chain so route-state persists land in call order. */
  private _modelRouteStatePersists = new Map<string, Promise<void>>();
  private defaultSessionId = "default";

  /** Optional userId — set by LocalSpawner for per-user skill directory isolation */
  userId?: string;

  /** Optional agentId — set by LocalSpawner / K8s spawner; used for metrics labeling */
  agentId?: string;

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

  /**
   * Per-agent tool capability whitelist — the resolved `allowedTools` list for
   * this AgentBox's agent (see core/tool-capabilities.ts).
   *
   * `null` (the default) = no restriction: createSiclawSession falls back to the
   * global `config.allowedTools`, i.e. exactly the behaviour before this feature
   * existed. A non-null array restricts the agent to those tool names.
   *
   * This state is PER-AGENT by construction: one AgentBoxSessionManager instance
   * per agent (K8s = one pod; LocalSpawner = one `new AgentBoxSessionManager()`
   * per agent). It is filled at startup (K8s: explicit fetch in agentbox-main;
   * Local: LocalSpawner injection) and refreshed on POST /api/reload-tools via a
   * per-box handler that writes here — never via loadConfig/writeConfig/process.env.
   */
  allowedToolsState: string[] | null = null;

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

  /**
   * Unified background-job registry (sub-agents + bash), keyed by jobId.
   * Replaces the old inline subagentJobs map; shared by notifyParent / job_stop.
   */
  private jobs = new JobRegistry();

  /**
   * Sessions for which a Stop arrived BEFORE the session existed (pre-spawn). Consumed one-shot
   * by the next getOrCreate-driven /api/prompt for that id (the prompt being cancelled — which is
   * already in flight and cold-starting, so it consumes within the cold-start window). The TTL
   * is only a leak backstop for an ORPHAN (a Stop whose paired prompt never arrives). Keep it
   * tight: it must outlast a cold start (image pull / container start, "routinely exceeds 30s"
   * per the runtime's async-ack comment) but no longer — a too-long TTL widens the window in
   * which a stale orphan could wrongly short-circuit a brand-new, deliberate prompt for the same
   * reused sessionId. 3 min covers cold start with margin while bounding that risk.
   */
  private _pendingAborts = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly PENDING_ABORT_TTL_MS = 180_000;

  /** Record a pre-spawn Stop so the imminent /api/prompt short-circuits (see _pendingAborts). */
  markPendingAbort(sessionId: string): void {
    // Only a TRUE pre-spawn Stop should arm a pending abort: one where the session was NEVER
    // created, so no in-flight turn exists yet and the imminent first /api/prompt is the one to
    // cancel. A genuine pre-spawn session has no on-disk history dir yet; a session that ran
    // before and was merely RELEASED from memory (30s TTL) always does. Without this guard, a
    // Stop on a released-but-idle session (e.g. the Stop button still live after a missed
    // prompt_done) would arm a pending abort that silently cancels the user's NEXT prompt for
    // the same reused sessionId. If the existence check throws, fall through and arm (best-effort).
    try {
      if (fs.existsSync(path.join(this.getBaseSessionDir(), sessionId))) return;
    } catch { /* fall through — arm */ }
    const existing = this._pendingAborts.get(sessionId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => this._pendingAborts.delete(sessionId), AgentBoxSessionManager.PENDING_ABORT_TTL_MS);
    t.unref?.();
    this._pendingAborts.set(sessionId, t);
  }

  /** Consume (one-shot) a pre-spawn Stop recorded by markPendingAbort. */
  consumePendingAbort(sessionId: string): boolean {
    const t = this._pendingAborts.get(sessionId);
    if (!t) return false;
    clearTimeout(t);
    this._pendingAborts.delete(sessionId);
    return true;
  }

  /**
   * Discard buffered background-job completion notifications + cancel the coalesce timer for a
   * session. Called from /abort: a job that completed moments before Stop already armed the
   * coalesce timer, which would otherwise flush → runSyntheticPrompt → brain.prompt() AFTER Stop
   * ("comes back to life"). The per-entry suppressNotifyTurn check still guards the flush path,
   * but clearing here makes the resurrection impossible regardless.
   */
  discardPendingNotifications(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    managed._pendingNotifications.length = 0;
    if (managed._coalesceTimer) {
      clearTimeout(managed._coalesceTimer);
      managed._coalesceTimer = null;
    }
  }

  private createSpawnSubagentExecutor(): SpawnSubagentExecutor {
    return async (request, onProgress, signal) => {
      if (request.runInBackground) return this.startBackgroundSubagent(request);
      // Already aborted before we even queue (e.g. the whole turn was cancelled): don't
      // acquire a slot or spin up a throwaway child session — short-circuit cleanly.
      if (signal?.aborted) {
        return { status: "partial", summary: "Sub-agent cancelled before starting.", childSessionId: "", toolCalls: 0, durationMs: 0 };
      }
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

  private createJobStopExecutor(): JobStopExecutor {
    // Shared stop logic lives on JobRegistry (same as the TUI path).
    return async (jobId) => this.jobs.stopJob(jobId);
  }

  private createTaskOutputReader(): TaskOutputReader {
    // Snapshot the job's live status so task_output can report running/terminal (same as TUI).
    return (jobId) => this.jobs.snapshot(jobId);
  }

  private createChannelMessageExecutor(): ChannelMessageExecutor {
    return async (request) => {
      if (!(this.gatewayClient && this.agentId)) {
        return {
          delivered: false,
          message: "channel_update unavailable: gateway delivery is not configured for this AgentBox.",
        };
      }
      const text = request.text.trim();
      if (!text) {
        return { delivered: false, message: "channel_update skipped: empty text." };
      }
      const response = await this.persistDelegationEvent({
        type: "channel.deliver_message",
        message: {
          sessionId: request.sessionId,
          kind: request.kind,
          text,
          fromAgentId: this.agentId,
        },
      });
      return {
        delivered: response.ok,
        message: response.ok
          ? `channel_update ${request.kind} accepted by Gateway.`
          : `channel_update ${request.kind} was not delivered.`,
      };
    };
  }

  /**
   * Stop ALL running background jobs (background exec + background sub-agents) of a session.
   * Called from the /abort handler so the user's "Stop" button halts everything the session is
   * running — not just the live turn (foreground tools/sub-agents die with the turn's abort
   * signal), but also the detached background jobs, which are otherwise decoupled from the turn.
   * Returns how many were stopped.
   */
  stopSessionJobs(sessionId: string): number {
    let stopped = 0;
    for (const job of this.jobs.list(sessionId)) {
      // suppressNotifyTurn: the user's Stop is terminal. The completion still folds each job's card
      // to "stopped", but we must NOT wake the model with a synthetic turn reacting to the
      // cancellation — that "comes back to life after Stop" is exactly what the button must avoid.
      if (job.status === "running" && this.jobs.stopJob(job.jobId, { suppressNotifyTurn: true }).stopped) stopped++;
    }
    return stopped;
  }

  /**
   * Background exec executor (run_in_background on bash / node_exec / pod_exec). Injected
   * into ToolRefs; the calling tool hands over the already-assembled command. Throws when
   * the per-session concurrency cap is reached so the tool falls back to foreground.
   */
  private createBackgroundExecExecutor(): BackgroundExecExecutor {
    return (req) => {
      // Stop latch: the user pressed Stop on this session; do NOT spawn a new background job.
      // Register a terminal "stopped" job and return a normal launched handle — NEVER throw,
      // because every background-capable tool treats an executor throw as "fall back to a
      // FOREGROUND run", which would re-introduce the escape this latch closes. The launching
      // tool's card folds to stopped via the exec_job_done event from notifyParent below;
      // suppressNotifyTurn keeps the model from waking on its own cancellation.
      const aborting = this.sessions.get(req.parentSessionId);
      if (aborting?._aborted) {
        const outputFile = getTaskOutputPath(req.jobId);
        const disk = new DiskTaskOutput(req.jobId);
        void disk.ensureCreated().then(() => disk.markFinal()).catch(() => {});
        this.jobs.register({
          jobId: req.jobId,
          type: req.jobType ?? "bash",
          parentSessionId: req.parentSessionId,
          description: req.description,
          status: "stopped",
          startedAt: Date.now(),
          notified: false,
          suppressNotifyTurn: true,
          outputFile,
        });
        try { req.onComplete?.(); } catch { /* best-effort (e.g. node_exec debug-pod unpin) */ }
        void this.notifyParent(req.parentSessionId, req.jobId, {
          taskId: req.jobId,
          outputFile,
          status: "stopped",
          summary: `Background command "${req.description}" was stopped`,
        });
        return { jobId: req.jobId, outputFile };
      }

      const cap = getBackgroundBashConcurrency();
      // Cap counts ALL background exec jobs (bash/node/pod), not sub-agents.
      const running = this.jobs
        .list(req.parentSessionId)
        .filter((j) => j.type !== "subagent" && j.status === "running").length;
      if (running >= cap) {
        throw new Error(
          `Background exec concurrency cap reached (${running}/${cap}); run this command in the foreground.`,
        );
      }

      const parent = this.sessions.get(req.parentSessionId);
      if (parent) {
        parent._backgroundWorkCount++;
        if (parent._releaseTimer) {
          clearTimeout(parent._releaseTimer);
          parent._releaseTimer = null;
        }
      }

      // Pair the increment with the decrement: if spawnBackgroundBash throws
      // synchronously (e.g. SanitizingLineBuffer fail-closed, spawn EACCES) the job's
      // close/error handlers never wire onSettled, so undo the increment here — otherwise
      // _backgroundWorkCount leaks and the session can never be released.
      try {
        return spawnBackgroundBash(
          req,
          this.jobs,
          (jobId, n) => void this.notifyParent(req.parentSessionId, jobId, n),
          () => this.releaseBackgroundWork(req.parentSessionId),
        );
      } catch (err) {
        this.releaseBackgroundWork(req.parentSessionId);
        throw err;
      }
    };
  }

  /** Decrement a parent's background-work count and re-arm release once idle. */
  private releaseBackgroundWork(parentSessionId: string): void {
    const current = this.sessions.get(parentSessionId);
    if (!current) return;
    current._backgroundWorkCount = Math.max(0, current._backgroundWorkCount - 1);
    if (current._backgroundWorkCount === 0 && current._promptDone) {
      this.scheduleRelease(current.id);
    }
  }

  /**
   * Launch a sub-agent detached (design §7). Returns immediately with status
   * "launched"; on completion notifyParent injects a <task_notification> into the
   * parent model. Background work blocks session release until it finishes.
   */
  private startBackgroundSubagent(request: SpawnSubagentRequest): SpawnSubagentResult {
    const childSessionId = randomUUID();
    const jobId = request.spawnId;
    // Stop latch: the user pressed Stop before this sub-agent launched; register it terminal
    // ("stopped") and skip runSpawnedSubagent so no child run/LLM work starts. suppressNotifyTurn
    // keeps the model from waking on the cancellation.
    if (this.sessions.get(request.parentSessionId)?._aborted) {
      this.jobs.register({
        jobId,
        type: "subagent",
        parentSessionId: request.parentSessionId,
        childSessionId,
        status: "stopped",
        description: request.description,
        startedAt: Date.now(),
        notified: false,
        suppressNotifyTurn: true,
      });
      // notifyParent gives the LIVE card fold (subagent_done). It is NOT persisted, so we ALSO
      // write the terminal delegation_event + child session row that runSpawnedSubagent would
      // have written — without these the launch card re-paints as "Running…" forever on reload
      // (annotateSubagentCompletions reads the persisted delegation_event), and the
      // "open transcript" deep-link 404s. Mirrors runSpawnedSubagent's terminal persistence.
      const stoppedAgentId = request.parentAgentId ?? this.agentId ?? null;
      if (this.gatewayClient && stoppedAgentId && request.userId) {
        void (async () => {
          try {
            await this.persistEnsureChatSession(
              childSessionId, stoppedAgentId, request.userId,
              `Sub-agent: ${request.description}`,
              "", "subagent",
              { parentSessionId: request.parentSessionId, parentAgentId: stoppedAgentId, delegationId: jobId, targetAgentId: stoppedAgentId },
            );
          } catch { /* best-effort */ }
          try {
            await this.persistAppendDelegationEvent({
              parentSessionId: request.parentSessionId,
              parentAgentId: stoppedAgentId,
              userId: request.userId,
              delegationId: jobId,
              childSessionId,
              targetAgentId: stoppedAgentId,
              // "partial" is the terminal status runSpawnedSubagent persists for a stopped
              // sub-agent (the delegation status enum has no "stopped"); keep it consistent so
              // the card folds the same way on reload.
              status: "partial",
              capsule: `Sub-agent "${request.description}" was stopped`,
              fullSummary: `Sub-agent "${request.description}" was stopped before it started.`,
              summaryTruncated: false,
              scope: request.prompt,
              toolCalls: 0,
              durationMs: 0,
            });
          } catch { /* best-effort */ }
        })();
      }
      void this.notifyParent(request.parentSessionId, jobId, {
        taskId: jobId,
        status: "stopped",
        summary: `Sub-agent "${request.description}" was stopped`,
      });
      return { status: "launched", childSessionId, jobId };
    }
    this.jobs.register({
      jobId,
      type: "subagent",
      parentSessionId: request.parentSessionId,
      childSessionId,
      status: "running",
      description: request.description,
      startedAt: Date.now(),
      notified: false,
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
        const job = this.jobs.get(jobId);
        const status: JobStatus =
          job?.status === "stopped"
            ? "stopped"
            : res.status === "launched"
              ? "running"
              : res.status; // SpawnSubagentStatus terminal ⊂ JobStatus
        this.jobs.setStatus(jobId, status);
        const summary =
          job?.status === "stopped"
            ? `Sub-agent "${request.description}" was stopped`
            : res.status === "launched"
              ? `Sub-agent "${request.description}" finished`
              : `Sub-agent "${request.description}" ${res.status}: ${res.summary}`;
        void this.notifyParent(request.parentSessionId, jobId, {
          taskId: jobId,
          status,
          summary,
        });
      })
      .catch((err) => {
        console.warn(`[agentbox-session] background sub-agent ${jobId} failed:`, err);
        // Honor a user job_stop: a rejection AFTER stop is a "stopped" outcome, not a
        // spurious "failed" notification (mirrors the .then path).
        const stopped = this.jobs.get(jobId)?.status === "stopped";
        this.jobs.setStatus(jobId, stopped ? "stopped" : "failed");
        void this.notifyParent(request.parentSessionId, jobId, {
          taskId: jobId,
          status: stopped ? "stopped" : "failed",
          summary: stopped
            ? `Sub-agent "${request.description}" was stopped`
            : `Sub-agent "${request.description}" failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      })
      .finally(() => this.releaseBackgroundWork(request.parentSessionId));

    return {
      status: "launched",
      childSessionId,
      jobId,
    };
  }

  /**
   * Inject a completed background job's <task_notification> into the parent model.
   *  - claimNotification dedups (job_stop vs process-exit race → exactly one notice).
   *  - Parent run in-flight → flush now via followUp (rides the current turn).
   *  - Parent idle → buffer + a short coalescing window, so a burst of completions becomes
   *    ONE synthetic turn (the model reacts once instead of re-summarizing per job).
   */
  private async notifyParent(
    sessionId: string,
    jobId: string,
    n: TaskNotification,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return; // session released — nothing to notify (rare; release is deferred while work pending)
    if (!this.jobs.claimNotification(jobId)) return;

    // Surface the completion in the launching tool's OWN box, not as a chat bubble: persist a
    // hidden exec_job_event (correlated to the launch by jobId) and fire a refetch so the box
    // flips running → done/failed live and on reload. Exec jobs only (sub-agents have their
    // own Jobs-bar fold). Independent of the model turn below.
    const job = this.jobs.get(jobId);
    if (job && job.type !== "subagent") {
      void this.persistExecJobEvent(sessionId, jobId, n.status, job.exitCode);
    } else if (job) {
      // Background sub-agent: fold its launch card live (running → done/failed/timed_out)
      // regardless of the model's synthetic-turn reaction. The persisted delegation_event still
      // drives the refetch fold; this TARGETED live event (mirrors exec_job_done) makes it
      // immediate and paged-back/streaming-safe — without it, a completion the model correctly
      // stays silent about leaves the card stuck on "Running…" until a manual refresh.
      void this.persistDelegationEvent({
        type: "delegation.emit_chat_event",
        sessionId,
        event: { type: "subagent_done", sessionId, job_id: jobId, status: n.status },
      }).catch(() => {});
    }

    // User Stop is terminal: the card already folded to "stopped" above, but do NOT wake the model
    // with a synthetic turn reacting to its own cancellation (the "won't stop" behavior). Card
    // folds, model stays silent.
    if (job?.suppressNotifyTurn) return;

    // Buffer the model-facing notification and arm the coalescing window. We deliver it ONLY
    // via the synthetic-turn path (never followUp): the completion itself already shows in the
    // tool box (exec_job_done above), and a followUp's acknowledgement rides the running turn
    // where it can't be suppressed. The synthetic path drops pure acks (no tool call).
    managed._pendingNotifications.push(n);
    if (!managed._coalesceTimer) {
      managed._coalesceTimer = setTimeout(() => {
        void this.flushPendingNotifications(sessionId);
      }, NOTIFICATION_COALESCE_MS);
      managed._coalesceTimer.unref?.();
    }
  }

  /**
   * Deliver all buffered completion notifications as a single message. In-flight → followUp
   * (rides the turn); idle → one synthetic turn. Re-fetches the session because the
   * coalescing window may outlive it (released) — a no-op then. followUp rejection falls
   * back to a synthetic turn so a notice is never lost (the latch is already spent).
   */
  private async flushPendingNotifications(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    if (managed._coalesceTimer) {
      clearTimeout(managed._coalesceTimer);
      managed._coalesceTimer = null;
    }
    // Stop is terminal: a Stop sets _aborted and stays true until the next REAL user prompt
    // resets it. Do NOT flush a synthetic turn during the Stop window — that would wake the
    // model on a completion it cancelled ("comes back to life after Stop").
    if (managed._aborted) {
      managed._pendingNotifications.length = 0;
      return;
    }
    if (!managed._promptDone) {
      // A turn is running — wait for it to finish, then deliver as a synthetic turn (where a
      // pure-ack reaction is suppressed). Re-arm rather than followUp: a followUp's ack rides
      // the running turn and can't be suppressed. The box already updated live, so the user
      // isn't waiting on this; only the model's optional reaction is deferred.
      managed._coalesceTimer = setTimeout(() => {
        void this.flushPendingNotifications(sessionId);
      }, NOTIFICATION_COALESCE_MS);
      managed._coalesceTimer.unref?.();
      return;
    }
    const batch = managed._pendingNotifications.splice(0);
    if (batch.length === 0) return;
    // A notification with NO output_file carries its result INLINE in the summary (sub-agents —
    // see task-notification.ts). For those the model's report is pure text (no read tool call),
    // so the turnHadTool persist guard below would wrongly drop it — allow a text-only reaction.
    // Require EVERY notification in the batch to be inline-result (`.every`, not `.some`): a
    // mixed batch (sub-agent + a shell/exec job whose data lives in output_file) must keep the
    // STRICT guard, else the shell job's pure-ack ("nothing new") text gets persisted as a noise
    // bubble — the exact thing turnHadTool suppresses. In that rare mixed case the sub-agent's
    // result is still visible via its own card fold (annotateSubagentCompletions), so only the
    // model's optional prose is dropped, never the result itself.
    const allInlineResult = batch.every((n) => !n.outputFile);
    await this.runSyntheticPrompt(managed, buildNotificationBatch(batch), allInlineResult);
  }

  /**
   * Run a notification as a synthetic parent turn when the parent is idle. Serialized
   * via _syntheticPromptQueue; acquires the SAME _promptDone/_promptInflight mutex that
   * HTTP /prompt uses, SYNCHRONOUSLY before any await — so an interleaving /prompt either
   * already started (re-check degrades us to followUp) or hits the 409 guard. This closes
   * the TOCTOU documented at the _promptInflight declaration.
   */
  private runSyntheticPrompt(managed: ManagedSession, text: string, allowTextOnlyPersist = false): Promise<void> {
    const run = (managed._syntheticPromptQueue ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        // Stop is terminal: if the user pressed Stop while this synthetic turn was queued, do
        // NOT start it (and do NOT followUp — that would ride a turn too). _aborted stays true
        // until the next real user prompt resets it. Checked under the queue, before the reset.
        if (managed._aborted) return;
        // Re-check under the queue: an HTTP /prompt may have started since notifyParent
        // decided "idle". If so, degrade to followUp (delivered to that running turn).
        if (!managed._promptDone || managed._promptInflight) {
          await managed.brain.followUp(text);
          return;
        }
        // Acquire the mutex synchronously (no await between check and set).
        managed._promptDone = false;
        managed._aborted = false;
        // Cancel any pending release timer (mirrors getOrCreate): a background job's
        // onSettled may have armed scheduleRelease just before this turn started — left
        // running, release() would tear the session down mid-synthetic-turn (it has no
        // in-flight guard). Both run in this same tick, so clearing here always wins.
        if (managed._releaseTimer) {
          clearTimeout(managed._releaseTimer);
          managed._releaseTimer = null;
        }
        let release!: () => void;
        managed._promptInflight = new Promise<void>((r) => { release = r; });
        // Buffer events so a reconnecting SSE client can replay the synthetic turn.
        // The /send SSE consumer is already gone (turn 1 closed it), so the synthetic
        // turn has NO gateway consumer — persist + live-emit its completed messages
        // ourselves (via the delegation channel) so the notification + the model's
        // reaction appear in chat history (refresh) and live in a connected session.
        managed._eventBuffer = [];
        if (managed._bufferUnsub) managed._bufferUnsub();
        const sid = managed.id;
        // delegation.append_message / emit_chat_event auth is agent+session based and does
        // NOT need userId (the agentbox often has SICLAW_AGENT_ID but no USER_ID env), so
        // gate only on gatewayClient + agentId.
        const canPersist = Boolean(this.gatewayClient && this.agentId);
        // P3.7: if we can't persist, the synthetic turn runs but neither persists nor fires
        // the live `background_turn_done` trigger, so the user never sees the background
        // job's completion (it's effectively lost). That only happens when gatewayClient /
        // agentId aren't wired — a deployment misconfig. Surface it once so it's diagnosable
        // instead of a silent disappearance.
        if (!canPersist && !warnedNoPersist) {
          warnedNoPersist = true;
          console.warn(
            "[agentbox-session] background-job completion turns cannot be persisted/delivered " +
            `(gatewayClient=${Boolean(this.gatewayClient)}, agentId=${Boolean(this.agentId)}). ` +
            "Set SICLAW_AGENT_ID and wire the gateway client so completions survive a refresh.",
          );
        }
        // Buffer the turn's messages and whether it did any real work (a tool call). We
        // persist at turn end, conditionally — a reaction with NO tool call is a pure
        // acknowledgement and is dropped (no bubble); see the finally block.
        const turnMessages: any[] = [];
        let turnHadTool = false;
        const routePolicy = managed.modelRoutePolicy;
        // Single entry: every synthetic turn runs through the routing runner —
        // real routing when a fallback target exists, otherwise a lone candidate
        // built from the current model. The runner's emitBrainEvent is the sole
        // event source whenever a policy resolves; only the no-current-model edge
        // falls back to a bare prompt collected via the subscription below.
        const effectivePolicy = resolveEffectivePolicy(routePolicy, managed.modelRouteState, managed.brain.getModel?.());
        managed._routeBrainEventsThroughExtra = effectivePolicy !== undefined;
        let latestModelRouteSwitch: Extract<ModelRouteEvent, { type: "model_route_switch" }> | null = null;
        let currentModelRouteMetadata: Record<string, unknown> | null = null;
        const handleRouteEvent = (event: ModelRouteEvent): void => {
          if (!managed._promptDone) managed._eventBuffer.push({ ...event, sessionId: sid });
          if (event.type === "model_route_switch") {
            latestModelRouteSwitch = event;
            return;
          }
          if (event.type !== "model_route_success") return;

          const metadata: Record<string, unknown> = {
            candidate_key: event.candidateKey,
            provider: event.provider,
            model_id: event.modelId,
            is_fallback: event.isFallback,
            primary_candidate_key: event.primaryCandidateKey,
            attempt: event.attempt,
          };
          if (latestModelRouteSwitch && latestModelRouteSwitch.toCandidateKey === event.candidateKey) {
            metadata.switched_from_candidate_key = latestModelRouteSwitch.fromCandidateKey;
            metadata.switched_from_provider = latestModelRouteSwitch.fromProvider;
            metadata.switched_from_model_id = latestModelRouteSwitch.fromModelId;
            metadata.failure_kind = latestModelRouteSwitch.failureKind;
            metadata.error_message = latestModelRouteSwitch.errorMessage;
            metadata.cooldown_until = latestModelRouteSwitch.cooldownUntil;
          }
          if (event.recoveredFromCandidateKey) {
            metadata.recovered_from_candidate_key = event.recoveredFromCandidateKey;
            metadata.recovered_from_provider = event.recoveredFromProvider;
            metadata.recovered_from_model_id = event.recoveredFromModelId;
          }
          currentModelRouteMetadata = event.isFallback || event.recoveredFromCandidateKey ? metadata : null;
        };
        const handleBrainEvent = (event: any): void => {
          if (!managed._promptDone) managed._eventBuffer.push(event);
          if (event?.type === "tool_execution_start") turnHadTool = true;
          if (event?.type === "message_end" && event.message) {
            if (event.message.role === "toolResult") turnHadTool = true;
            turnMessages.push(event.message);
          }
        };
        const brainUnsub = managed.brain.subscribe((event: any) => {
          if (effectivePolicy === undefined) handleBrainEvent(event);
        });
        managed._bufferUnsub = () => brainUnsub();
        try {
          await runPromptWithModelRouting(
            managed.brain,
            text,
            effectivePolicy,
            managed.modelRouteState,
            {
              emitEvent: handleRouteEvent,
              emitBrainEvent: handleBrainEvent,
              onStateChange: () => this.persistModelRouteState(managed.id, managed.modelRouteState),
              shouldAbort: () => managed._aborted,
              // Synthetic background turns persist by collecting brain events
              // (turnMessages) and have no live viewer — buffer every attempt
              // so a failed primary can't leak into the persisted turn.
              optimisticPrimaryStream: false,
            },
          );
        } catch (err) {
          console.warn(`[agentbox-session] synthetic prompt failed for ${managed.id}:`, err);
        } finally {
          managed._promptDone = true;
          managed._routeBrainEventsThroughExtra = false;
          if (managed._bufferUnsub) { managed._bufferUnsub(); managed._bufferUnsub = null; }
          for (const cb of managed._promptDoneCallbacks) { try { cb(); } catch { /* ignore */ } }
          managed._promptDoneCallbacks.clear();
          managed._promptInflight = null;
          release();
          if (managed._backgroundWorkCount === 0) this.scheduleRelease(managed.id);
          // Decide whether to keep the model's reaction. Normally we keep it ONLY if it made a
          // tool call: for a bash/exec completion the data lives in output_file, so a data-bearing
          // report necessarily reads that file first (a tool call), and a text-only reaction is a
          // pure ack ("nothing new") we drop to avoid a noise bubble (the completion already shows
          // in the launching tool's own box).
          // EXCEPTION (allowTextOnlyPersist): a sub-agent's result is delivered INLINE in the
          // notification summary — the model reports it as pure text with NO tool call. There the
          // text IS the answer the user is waiting for, so keep a non-empty text-only reaction too.
          const turnHadText = turnMessages.some((m) => {
            if (m.role !== "assistant") return false;
            const c = Array.isArray(m.content)
              ? m.content.filter((x: any) => x?.type === "text").map((x: any) => x.text ?? "").join("")
              : typeof m.content === "string" ? m.content : "";
            return c.trim().length > 0;
          });
          // When kept, persist the whole turn then fire a refetch so the frontend shows it.
          if (canPersist && (turnHadTool || (allowTextOnlyPersist && turnHadText))) {
            void Promise.allSettled(
              turnMessages.map((m) => this.persistSyntheticMessage(sid, m, currentModelRouteMetadata).catch(() => {})),
            ).then(() =>
              this.persistDelegationEvent({
                type: "delegation.emit_chat_event",
                sessionId: sid,
                event: { type: "background_turn_done", sessionId: sid },
              }).catch(() => {}),
            );
          }
        }
      });
    managed._syntheticPromptQueue = run.finally(() => {
      if (managed._syntheticPromptQueue === run) managed._syntheticPromptQueue = null;
    });
    return run;
  }

  private async persistDelegationEvent(event: DelegationPersistenceEvent): Promise<DelegationPersistenceResponse> {
    if (!this.gatewayClient) return { ok: false };
    return this.gatewayClient.sendDelegationPersistenceEvent(event);
  }

  /**
   * Persist a hidden completion marker for a background exec job, then fire a refetch so the
   * frontend folds it into the launching tool's box (running → done/failed). Correlated to
   * the launch by jobId (=== the launch result's backgroundTaskId). No-op when persistence
   * isn't wired (gatewayClient/agentId absent).
   */
  private async persistExecJobEvent(
    sessionId: string,
    jobId: string,
    status: JobStatus,
    exitCode: number | undefined,
  ): Promise<void> {
    if (!(this.gatewayClient && this.agentId)) return;
    try {
      await this.persistAppendMessage({
        sessionId,
        parentSessionId: sessionId,
        fromAgentId: this.agentId,
        targetAgentId: this.agentId,
        role: "user",
        content: "",
        metadata: { kind: "exec_job_event", job_id: jobId, status, exit_code: exitCode ?? null },
        outcome: status === "failed" ? "error" : null,
      });
      // Live, TARGETED box update (not a refetch): the frontend flips the launching tool's
      // box in place — works even while a turn is streaming (so it's immediate, not delayed
      // until the in-flight turn ends), and never clobbers the live stream.
      await this.persistDelegationEvent({
        type: "delegation.emit_chat_event",
        sessionId,
        event: { type: "exec_job_done", job_id: jobId, status, exit_code: exitCode ?? null },
      });
    } catch { /* best-effort UI update */ }
  }

  /**
   * Persist one completed message of a synthetic notification turn to the PARENT session
   * (sessionId === parentSessionId so the delegation auth passes for our own agent).
   * Reuses the delegation append channel since the gateway's per-/send SSE consumer is
   * not attached to this turn. The leading <task_notification> user message is tagged
   * metadata.kind so the UI can fold it like other system notices.
   */
  private async persistSyntheticMessage(
    sessionId: string,
    message: any,
    modelRouteMetadata?: Record<string, unknown> | null,
  ): Promise<void> {
    const role: "user" | "assistant" | "tool" =
      message.role === "toolResult" ? "tool" : message.role === "assistant" ? "assistant" : "user";
    const content = Array.isArray(message.content)
      ? message.content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("")
      : typeof message.content === "string" ? message.content : "";
    if (role === "assistant" && !content.trim()) return; // skip empty (pure tool-call) assistant frames
    const isNotification = role === "user" && content.trimStart().startsWith("<task_notification>");
    await this.persistAppendMessage({
      sessionId,
      parentSessionId: sessionId,
      fromAgentId: this.agentId,
      targetAgentId: this.agentId,
      role,
      content,
      toolName: message.toolName ?? null,
      metadata: isNotification
        ? { kind: "task_notification" }
        : role === "assistant" && modelRouteMetadata
          ? { model_route: modelRouteMetadata }
          : null,
      // A COMPLETED tool row must persist a terminal outcome. Without this a successful tool call
      // in a synthetic (background-completion) turn was written with outcome=null, which the
      // frontend maps to "running" → a spinner that never resolves and a recovered-run poller stuck
      // on "Thinking…" after refresh. Only tool rows carry an outcome; user/assistant rows stay null.
      outcome: role === "tool" ? (message.isError ? "error" : "success") : null,
    });
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

  private modelRouteStateFile(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), ".model-route-state.json");
  }

  private loadModelRouteState(sessionId: string): ModelRouteState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.modelRouteStateFile(sessionId), "utf8"));
      return normalizeModelRouteState(raw);
    } catch (err) {
      // Missing file is the normal first-run case; anything else (corrupt
      // JSON, permissions) silently resetting cooldowns deserves a trace.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.warn(`[agentbox-session] model-route state for ${sessionId} unreadable, starting fresh:`, err);
      }
      return createModelRouteState();
    }
  }

  /**
   * Best-effort model-route state durability. The state is independent of
   * pi-agent's append-only JSONL history: it controls which candidate Siclaw
   * should try next after AgentBox release/rebuild, but it does not alter the
   * conversation context.
   */
  persistModelRouteState(sessionId: string, state: ModelRouteState): void {
    const file = this.modelRouteStateFile(sessionId);
    // Snapshot synchronously, then serialize writes per session: each write is
    // atomic (tmp + rename), but without ordering a slow older write could
    // rename over a newer one, leaving stale state on disk.
    const payload = `${JSON.stringify(normalizeModelRouteState(state), null, 2)}\n`;
    const prev = this._modelRouteStatePersists.get(sessionId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(tmp, payload, "utf8");
        await fs.promises.rename(tmp, file);
      } catch (err) {
        console.warn(`[agentbox-session] model-route state persist failed for ${sessionId}:`, err);
        void fs.promises.unlink(tmp).catch(() => {});
      }
    });
    this._modelRouteStatePersists.set(sessionId, next);
    void next.finally(() => {
      if (this._modelRouteStatePersists.get(sessionId) === next) {
        this._modelRouteStatePersists.delete(sessionId);
      }
    });
  }

  /**
   * Best-effort: write the current ledger snapshot to the PV session dir. Writes to a
   * unique temp file then atomically renames over the target, so a wide fan-out's
   * interleaved snapshot writes can never leave a half-written / truncated file for a
   * concurrent reader (rehydrate-on-restart) — last writer wins cleanly.
   */
  private persistLedgerSnapshot(taskListId: string): void {
    const tasks = getOrCreateLedger(taskListId).snapshot();
    const file = this.ledgerFile(taskListId);
    const tmp = `${file}.${randomUUID()}.tmp`;
    void fs.promises
      .writeFile(tmp, JSON.stringify(tasks), "utf8")
      .then(() => fs.promises.rename(tmp, file))
      .catch((err) => {
        console.warn(`[agentbox-session] plan-ledger snapshot failed for ${taskListId}:`, err);
        void fs.promises.unlink(tmp).catch(() => {});
      });
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
        // Only the parent touches the ledger (sub-agents have no task tools — see
        // isSubagent gating), so allCompleted() reflects the whole plan and clearing
        // here can't wipe anything out from under a child. No in-flight-child guard.
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
      // A spawned sub-agent must never be broader than its parent: inherit the
      // parent's per-agent tool whitelist. Without this, a restricted agent that
      // has the `spawn_subagents` capability could escalate by spawning a child
      // that falls back to the global config.allowedTools (all tools). null
      // (unrestricted parent) stays null — identical to pre-feature behaviour.
      allowedTools: this.allowedToolsState,
      // The plan is parent-owned: sub-agents have no task tools (isSubagent hides
      // them), so the child neither reads nor writes the ledger — the parent marks
      // tasks complete as children report back. The parent's taskListId is therefore
      // intentionally NOT shared with the child (nothing there would consume it).
      isSubagent: true,
      // The agent-type's prompt flavour for this child.
      systemPromptAppend: type.systemPromptAddendum,
      // Deliberately omit spawnSubagentExecutor + delegate executors → the child
      // never sees spawn_subagent (no recursion).
    });
    child.sessionIdRef.current = childSessionId;

    // Use the same model the parent's delegated agents use, when configured.
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
      const job = this.jobs.get(opts.jobId);
      if (job) {
        job.childSessionId = childSessionId;
        job.abort = () => requestStop(`job_stop ${childSessionId}`);
      }
    }

    // Setup-window Stop: if the user pressed Stop while we were awaiting createSiclawSession
    // above (job.abort was not wired yet, so a /abort sweep's stopJob no-op'd with "starting up"
    // and left the job "running"), honour it now before the child's run starts. The reliable
    // signal is the PARENT session's _aborted (set at /abort, true for the whole Stop window) —
    // NOT the job status, which stopJob never set to "stopped" in this window.
    if (this.sessions.get(request.parentSessionId)?._aborted) {
      requestStop(`parent stopped during sub-agent setup ${childSessionId}`);
    }

    // ── Transcript persistence (design §13). Serialized via a promise queue so
    //    writes land in order; a write failure disables the trace but never the run. ──
    const delegationId = request.spawnId;
    const redactionConfig = buildRedactionConfigForModelConfig(this.delegationModelConfig);
    const lineage = { parentSessionId: request.parentSessionId, parentAgentId: agentId, delegationId, targetAgentId: agentId };
    // canPersist = is the trace persistable at all (config present). Constant — never
    // flipped. persistTrace is the per-write latch that disables further *non-terminal*
    // writes after the first failure; the terminal event must NOT ride this latch.
    const canPersist = Boolean(agentId && request.userId && request.parentSessionId);
    let persistTrace = canPersist;
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
      // Stop landed before/during setup: requestStop already fired, but child.brain.abort() is a
      // no-op with no active run — so DON'T start the prompt at all, or it would run a fresh,
      // un-aborted turn. Throw straight into the stopRequested branch below.
      if (stopRequested) throw new Error("stopped before sub-agent prompt started");
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
        console.warn(`[agentbox-session] sub-agent ${childSessionId} failed:`, err);
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

    // Drain prior (best-effort) trace writes, then emit the terminal event.
    await persistQueue;
    // Terminal event ALWAYS — including failure/timeout (design §13 hard requirement).
    // Routed OFF the persistTrace latch: a transient failure on an earlier trace write
    // must not drop this, or the child is left stuck "running" in the UI forever. It
    // still respects whether persistence is configured at all (canPersist).
    if (canPersist) {
      try {
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
      } catch (err) {
        console.warn(`[agentbox-session] terminal delegation event persist failed for ${childSessionId}:`, err);
      }
    }

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
    activeMode: AgentMode = "normal",
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
      // Reuse unless the operating mode changed mid-session (e.g. user toggled Deep
      // Investigation): rebuild so tools scoped by `availableModes` are re-resolved.
      // Don't rebuild mid-first-prompt (_promptDone false).
      if (existing.activeMode === activeMode || !existing._promptDone) {
        return existing;
      }
      console.log(
        `[agentbox-session] Rebuilding session ${id} for mode change ${existing.activeMode} -> ${activeMode}`,
      );
      await this.release(id);
    }

    // Ensure shared components are ready
    await this.ensureSharedComponents();

    const sessionDir = this.getSessionDir(id);
    console.log(`[agentbox-session] Creating session: ${id} in ${sessionDir}`);
    const modelRouteState = this.loadModelRouteState(id);

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
      activeMode,
      memoryIndexer: this._sharedMemoryIndexer ?? undefined,
      userId: this.userId,
      agentId: this.agentId ?? null,
      // Per-agent tool capability whitelist. null = unrestricted (falls back to
      // global config.allowedTools in agent-factory — today's behaviour for any
      // agent that never set tool_capabilities).
      allowedTools: this.allowedToolsState,
      systemPromptTemplate,
      // Stable per-session ledger key so the plan survives release/rebuild
      // (a fresh random id would orphan the prior in-memory ledger every turn).
      taskListId: id,
      sessionEventEmitter: emitExtraEvent,
      // spawn_subagent is available in normal chat (top-level sessions only — child
      // sessions above omit this executor, so sub-agents cannot recurse).
      spawnSubagentExecutor: this.createSpawnSubagentExecutor(),
      jobStopExecutor: this.createJobStopExecutor(),
      backgroundExecExecutor: this.createBackgroundExecExecutor(),
      taskOutputReader: this.createTaskOutputReader(),
      channelMessageExecutor: this.createChannelMessageExecutor(),
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
      activeMode,
      // Per-session references point to shared instances (not owned by session)
      mcpManager: result.mcpManager,
      memoryIndexer: result.memoryIndexer,
      dpStateRef: result.dpStateRef,
      _lastSavedMessageCount: 0,
      _releaseTimer: null,
      _backgroundWorkCount: 0,
      modelRouteState,
      modelRoutePolicy: undefined,
      _routeBrainEventsThroughExtra: false,
      _promptInflight: null,
      _extraEventSubs: extraEventSubs,
      _extraEventBuffer: extraEventBuffer,
      _pendingNotifications: [],
      _coalesceTimer: null,
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
      if (managed._coalesceTimer) { clearTimeout(managed._coalesceTimer); managed._coalesceTimer = null; }
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
