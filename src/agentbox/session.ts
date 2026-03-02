/**
 * AgentBox session manager
 *
 * Manages multiple sessions within a single AgentBox (a user may have multiple conversations).
 * Reuses createSiclawSession() to create Agents.
 * Supports session persistence via User PV.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { createSiclawSession, type KubeconfigRef, type LlmConfigRef, type SessionMode } from "../core/agent-factory.js";
import type { BrainSession, BrainType } from "../core/brain-session.js";
import type { McpClientManager } from "../core/mcp-client.js";
import type { MemoryIndexer } from "../memory/index.js";
import type { DpState } from "../tools/dp-tools.js";
import { S3Storage } from "../lib/s3-storage.js";
import { loadConfig } from "../core/config.js";

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
  /** Brain type used by this session */
  brainType: BrainType;
  /** MCP client manager — shutdown on session close */
  mcpManager?: McpClientManager;
  /** Memory indexer for this session (if available) */
  memoryIndexer?: MemoryIndexer;
  /** Mutable DP state — only set for SDK brain (pi-agent uses extension state) */
  dpState?: DpState;
}

export class AgentBoxSessionManager {
  private sessions = new Map<string, ManagedSession>();
  private defaultSessionId = "default";
  private s3: S3Storage | null;

  constructor() {
    this.s3 = S3Storage.fromEnv();
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
   * Get or create a session.
   * Each gateway sessionId maps to its own pi-coding-agent session directory,
   * so pod restarts correctly restore the matching conversation context.
   */
  async getOrCreate(sessionId?: string, mode?: SessionMode, brainType?: BrainType): Promise<ManagedSession> {
    const id = sessionId || this.defaultSessionId;

    let managed = this.sessions.get(id);
    if (managed) {
      managed.lastActiveAt = new Date();
      return managed;
    }

    const sessionDir = this.getSessionDir(id);
    console.log(`[agentbox-session] Creating session: ${id} in ${sessionDir}`);

    // Ensure memory directory exists
    const config = loadConfig();
    const userDataDir = path.resolve(process.cwd(), config.paths.userDataDir);
    const memoryDir = path.join(userDataDir, "memory");
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    // continueRecent within this session's own directory — restores the
    // correct conversation after pod restart. Falls back to create if empty.
    const restored = SessionManager.continueRecent(sessionDir);
    const isNewSession = !restored;
    const frameworkSessionManager = restored ?? SessionManager.create(sessionDir);

    const kubeconfigRef: KubeconfigRef = {
      credentialsDir: path.resolve(process.cwd(), config.paths.credentialsDir),
    };
    const effectiveMode = mode ?? "web";
    const effectiveBrainType = brainType ?? "pi-agent";
    const result = await createSiclawSession({
      sessionManager: frameworkSessionManager,
      kubeconfigRef,
      mode: effectiveMode,
      brainType: effectiveBrainType,
    });

    // New session: re-sync memory index to pick up files from previous sessions
    if (isNewSession && result.memoryIndexer) {
      result.memoryIndexer.sync().catch((err) => {
        console.warn(`[agentbox-session] Memory sync on new session failed:`, err);
      });
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
      brainType: effectiveBrainType,
      mcpManager: result.mcpManager,
      memoryIndexer: result.memoryIndexer,
      dpState: result.dpState,
    };

    // Track agent lifecycle state + debug logging (works with both brain types)
    result.brain.subscribe((event: any) => {
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

    this.sessions.set(id, managed);
    return managed;
  }

  /**
   * Get an existing session.
   */
  get(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all sessions.
   */
  list(): ManagedSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Close the specified session.
   */
  async close(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      console.log(`[agentbox-session] Closing session: ${sessionId}`);
      // Shutdown MCP connections if any
      if (managed.mcpManager) {
        try {
          await managed.mcpManager.shutdown();
        } catch (err) {
          console.warn(`[agentbox-session] MCP shutdown error for ${sessionId}:`, err);
        }
      }
      // Sync memory index before closing to persist any writes from this session
      if (managed.memoryIndexer) {
        try {
          await managed.memoryIndexer.sync();
          managed.memoryIndexer.close();
        } catch (err) {
          console.warn(`[agentbox-session] Memory sync on close failed:`, err);
        }
      }
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Close all sessions.
   */
  async closeAll(): Promise<void> {
    console.log(`[agentbox-session] Closing all sessions (${this.sessions.size})`);
    for (const sessionId of this.sessions.keys()) {
      await this.close(sessionId);
    }
  }
}
