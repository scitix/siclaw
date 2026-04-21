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
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { createSiclawSession } from "../core/agent-factory.js";
import type { KubeconfigRef, LlmConfigRef, SessionMode, DpStateRef, DpStatus } from "../core/types.js";
import type { BrainSession } from "../core/brain-session.js";
import type { McpClientManager } from "../core/mcp-client.js";
import { createMemoryIndexer, type MemoryIndexer } from "../memory/index.js";
import { saveSessionKnowledge } from "../memory/session-summarizer.js";
import { loadConfig, getEmbeddingConfig } from "../core/config.js";
import { emitDiagnostic } from "../shared/diagnostic-events.js";
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
  /** Mutable reference to the active kubeconfig path — tools read .current at execution time */
  kubeconfigRef: KubeconfigRef;
  /** Mutable LLM config ref for deep_search sub-agents — updated by gateway prompt handler */
  llmConfigRef: LlmConfigRef;
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
}

export interface PersistedDpStateSnapshot {
  dpStatus: DpStatus;
  question?: string;
  round?: number;
  confirmedHypotheses?: Array<{ id: string; text: string; confidence: number }>;
}

/** Delay before releasing an idle session (seconds). Gives frontend time to query context/model. */
const SESSION_RELEASE_TTL_MS = 30_000;

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
   * Optional override for the directory where the broker materializes credential
   * files. LocalSpawner sets this to a per-user path so multiple
   * AgentBoxes don't collide on a shared credentialsDir. When undefined the
   * broker falls back to `<cwd>/.siclaw/credentials`.
   */
  credentialsDir?: string;

  /** Callback fired after a session is released — used by http-server to check idle status */
  onSessionRelease?: () => void;

  // ── Shared components (AgentBox-level, outlive individual sessions) ──
  private _sharedMemoryIndexer: MemoryIndexer | null = null;
  /** Whether shared components have been initialized */
  private _sharedInitialized = false;

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

  /**
   * Lazily initialize shared components (memory indexer, MCP manager).
   * Called on first getOrCreate(). Idempotent.
   */
  private async ensureSharedComponents(): Promise<void> {
    if (this._sharedInitialized) return;
    this._sharedInitialized = true;

    const memoryDir = this.getMemoryDir();

    // ── Memory indexer ──
    try {
      if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true });
      }
      const embeddingOpts = getEmbeddingConfig() ?? undefined;
      this._sharedMemoryIndexer = await createMemoryIndexer(memoryDir, embeddingOpts);
      await this._sharedMemoryIndexer.sync();
      this._sharedMemoryIndexer.startWatching();
      console.log(`[agentbox-session] Shared memory indexer initialized for ${memoryDir}`);
    } catch (err) {
      console.warn(`[agentbox-session] Shared memory indexer init failed:`, err);
      this._sharedMemoryIndexer = null;
    }
    // MCP is initialized per-session inside createSiclawSession via loadConfig().mcpServers.
  }

  /**
   * Get or create a session.
   * Each gateway sessionId maps to its own pi-coding-agent session directory,
   * so pod restarts correctly restore the matching conversation context.
   *
   * After Phase 2, sessions are released after each prompt completes.
   * getOrCreate() restores from JSONL, reusing shared components for fast recovery.
   */
  async getOrCreate(sessionId?: string, mode?: SessionMode, systemPromptTemplate?: string): Promise<ManagedSession> {
    const id = sessionId || this.defaultSessionId;

    let managed = this.sessions.get(id);
    if (managed) {
      managed.lastActiveAt = new Date();
      // Cancel pending release — session is being reused
      if (managed._releaseTimer) {
        clearTimeout(managed._releaseTimer);
        managed._releaseTimer = null;
        console.log(`[agentbox-session] Cancelled pending release for session ${id}`);
      }
      return managed;
    }

    // Ensure shared components are ready
    await this.ensureSharedComponents();

    const sessionDir = this.getSessionDir(id);
    console.log(`[agentbox-session] Creating session: ${id} in ${sessionDir}`);

    // Ensure memory directory exists
    const memoryDir = this.getMemoryDir();
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
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
    const result = await createSiclawSession({
      sessionManager: frameworkSessionManager,
      kubeconfigRef,
      mode: effectiveMode,
      memoryIndexer: this._sharedMemoryIndexer ?? undefined,
      userId: this.userId,
      agentId: this.agentId ?? null,
      knowledgeIndexer: this.knowledgeIndexer,
      systemPromptTemplate,
    });

    // Populate sessionIdRef so skill_call events can associate with this session
    result.sessionIdRef.current = id;

    // New session: sync memory index, then purge stale investigations (chained to avoid race)
    if (isNewSession && this._sharedMemoryIndexer) {
      const memDir = this.getMemoryDir();
      this._sharedMemoryIndexer.sync()
        .then(() => this._sharedMemoryIndexer!.purgeStaleInvestigations(memDir, { skipSync: true }))
        .catch(err => console.warn("[agentbox-session] Memory sync/purge failed:", err));
    }

    managed = {
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
      kubeconfigRef,
      llmConfigRef: result.llmConfigRef,
      _aborted: false,
      skillsDirs: result.skillsDirs,
      mode: effectiveMode,
      // Per-session references point to shared instances (not owned by session)
      mcpManager: result.mcpManager,
      memoryIndexer: result.memoryIndexer,
      dpStateRef: result.dpStateRef,
      _lastSavedMessageCount: 0,
      _releaseTimer: null,
    };

    this.sessions.set(id, managed);
    emitDiagnostic({ type: "session_created", sessionId: id });

    // Tool execution timing (for tool_call diagnostic events).
    // NOTE: tool_execution_start/end events depend on the brain implementation.
    // claude-sdk brain emits them reliably; pi-agent brain depends on the SDK's
    // event stream — if these events aren't emitted, tool metrics will be zero
    // for those sessions (best-effort, no incorrect data).
    // Key by toolCallId (unique per invocation) to avoid concurrent same-name tool overwrites.
    const toolStartTimes = new Map<string, { name: string; startMs: number }>();
    let toolCallSeq = 0;

    // Track agent lifecycle state + debug logging (works with both brain types)
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
          dpStatus?: DpStatus;
          dpQuestion?: string;
          dpRound?: number;
          dpConfirmedHypotheses?: Array<{ id: string; text: string; confidence: number }>;
          checklist?: { question?: string };
          phase?: string;
          question?: string;
        } } | undefined;

      if (!entry?.data) return null;

      if (entry.data.dpStatus) {
        return {
          dpStatus: entry.data.dpStatus,
          question: entry.data.dpQuestion ?? entry.data.checklist?.question,
          round: entry.data.dpRound,
          confirmedHypotheses: entry.data.dpConfirmedHypotheses,
        };
      }

      // Legacy fallback: any persisted checklist/phase means the session was in DP.
      if (entry.data.checklist || (entry.data.phase && entry.data.phase !== "idle")) {
        return {
          dpStatus: "investigating",
          question: entry.data.question ?? entry.data.checklist?.question,
        };
      }
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
   * Performs memory auto-save (if new messages since last save), syncs the
   * shared memory index, then removes the session from the in-memory map.
   * Shared components (memory indexer, MCP) are NOT destroyed.
   *
   * The session can be transparently restored from JSONL on the next getOrCreate().
   */
  async release(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;

    console.log(`[agentbox-session] Releasing session: ${sessionId}`);

    // 1. Auto-save session memory (dedup: only if new messages since last save)
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

    // 2. Shutdown per-session MCP connections
    if (managed.mcpManager) {
      try {
        await managed.mcpManager.shutdown();
      } catch (err) {
        console.warn(`[agentbox-session] MCP shutdown failed for ${sessionId}:`, err);
      }
    }

    // 3. Sync shared memory index to pick up the new summary file
    if (this._sharedMemoryIndexer) {
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
   * Triggers a sync so the existing indexer detects deleted files and
   * cleans up its DB records. We keep the same indexer instance alive
   * because active sessions hold direct references to it via tool closures.
   */
  async resetMemory(): Promise<void> {
    if (!this._sharedMemoryIndexer) {
      console.log(`[agentbox-session] No memory indexer to reset`);
      return;
    }

    try {
      // sync() detects deleted .md files and cleans up files/chunks tables
      await this._sharedMemoryIndexer.sync();
      // investigations table is NOT cleaned by sync — clear it explicitly
      this._sharedMemoryIndexer.clearInvestigations();
      console.log(`[agentbox-session] Memory indexer re-synced after PVC cleanup`);
    } catch (err) {
      console.warn(`[agentbox-session] Memory indexer sync after reset failed:`, err);
    }
  }
}
