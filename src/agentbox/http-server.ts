/**
 * AgentBox HTTP Server
 *
 * Provides HTTP API for Gateway to call, with SSE streaming support.
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import type { AgentBoxSessionManager } from "./session.js";
import type { SessionMode } from "../core/types.js";
import { loadConfig } from "../core/config.js";
import { emitDiagnostic } from "../shared/diagnostic-events.js";
import { checkMetricsAuth } from "../shared/metrics.js"; // also registers metrics subscriber (side-effect)
import { GatewayClient } from "./gateway-client.js";
import { CredentialBroker } from "./credential-broker.js";
import { HttpTransport } from "./credential-transport.js";
import { getSyncHandler, createClusterHandler, createHostHandler } from "./sync-handlers.js";
import { GATEWAY_SYNC_DESCRIPTORS, type AgentBoxSyncHandler, type GatewaySyncType } from "../shared/gateway-sync.js";
import { detectLanguage } from "../shared/detect-language.js";

type RequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RequestHandler;
}

/**
 * Parse JSON body
 */
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const BODY_TIMEOUT_MS = 30_000; // 30s
const DP_ACTIVATION_MARKER = "[Deep Investigation]\n";
const DP_EXIT_MARKER = "[DP_EXIT]";

async function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      reject(new Error("Body read timeout"));
    }, BODY_TIMEOUT_MS);

    req.on("data", (chunk: Buffer | string) => {
      if (timedOut) return;
      size += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (size > MAX_BODY_SIZE) {
        clearTimeout(timer);
        req.destroy();
        reject(new Error(`Body exceeds ${MAX_BODY_SIZE} byte limit`));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      clearTimeout(timer);
      if (timedOut) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function startsDeepInvestigation(text: string): boolean {
  return text.startsWith(DP_ACTIVATION_MARKER);
}

function startsDpExit(text: string): boolean {
  return text.startsWith(`${DP_EXIT_MARKER}\n`) || text.trim() === DP_EXIT_MARKER;
}

function shouldEnableDelegationTools(
  text: string,
  sessionId: string | undefined,
  sessionManager: AgentBoxSessionManager,
): boolean {
  if (startsDpExit(text)) return false;
  if (startsDeepInvestigation(text)) return true;
  if (!sessionId) return false;

  const live = sessionManager.get(sessionId)?.dpStateRef?.active;
  if (live === true) return true;

  return sessionManager.getPersistedDpState(sessionId)?.active === true;
}

/**
 * Send JSON response
 */
function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const ABORT_ENDPOINT_TIMEOUT_MS = 2_000;

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function abortBrainForHttp(
  brain: { abort: () => Promise<void> | void },
  sessionId: string,
): Promise<"done" | "failed" | "timeout"> {
  const abortPromise = Promise.resolve()
    .then(() => brain.abort())
    .then(() => "done" as const)
    .catch((err) => {
      console.error(`[agentbox-http] Abort error for session ${sessionId}:`, err);
      return "failed" as const;
    });

  const outcome = await Promise.race([
    abortPromise,
    waitMs(ABORT_ENDPOINT_TIMEOUT_MS).then(() => "timeout" as const),
  ]);
  if (outcome === "timeout") {
    console.warn(`[agentbox-http] Abort for session ${sessionId} did not settle within ${ABORT_ENDPOINT_TIMEOUT_MS}ms`);
  }
  return outcome;
}

export interface CreateHttpServerOptions {
  /**
   * If true, skip the 5-minute idle self-destruct. Intended for LocalSpawner,
   * which runs AgentBox in-process with the Portal — `process.exit(0)` from
   * the idle timer would take the whole `siclaw local` process down with it.
   * K8s mode must keep the default so idle pods get recycled.
   */
  disableIdleShutdown?: boolean;
}

/**
 * Create HTTP or HTTPS server (auto-detects certificates)
 */
export function createHttpServer(
  sessionManager: AgentBoxSessionManager,
  options: CreateHttpServerOptions = {},
): http.Server | https.Server {
  // Initialize credential broker synchronously before any session is created.
  // The broker reference is captured by value into each session's KubeconfigRef,
  // so we cannot defer initialization — a late-arriving broker would never be
  // seen by sessions created before it landed.
  // Credential broker: both K8s and Local mode use HTTP to call gateway.
  // SICLAW_GATEWAY_URL is set by K8s env or LocalSpawner process.env injection.
  {
    const credentialsDir = sessionManager.credentialsDir;
    const gatewayUrl = process.env.SICLAW_GATEWAY_URL;
    if (gatewayUrl && !sessionManager.gatewayClient) {
      sessionManager.gatewayClient = new GatewayClient({ gatewayUrl });
    }
    if (gatewayUrl && !sessionManager.credentialBroker && sessionManager.gatewayClient) {
      const client = sessionManager.gatewayClient;
      sessionManager.credentialBroker = new CredentialBroker(new HttpTransport(client), credentialsDir);
      console.log(`[agentbox-http] Credential broker initialized (${gatewayUrl})`);
    }
  }

  // cluster/host handlers close over this server's broker. In Local mode,
  // LocalSpawner runs multiple AgentBoxes in the SAME process — if we had
  // used the module-level sync-handlers registry (as mcp/skills do), each
  // spawn() would overwrite the previous registration and cross-tenant
  // request routing would silently pick the wrong broker. We instead bind
  // these handlers per-httpServer and hand them to the route loop below.
  const perServerHandlers: Partial<Record<GatewaySyncType, AgentBoxSyncHandler<any>>> = {};
  if (sessionManager.credentialBroker) {
    perServerHandlers.cluster = createClusterHandler(sessionManager.credentialBroker);
    perServerHandlers.host = createHostHandler(sessionManager.credentialBroker);
  }

  // ── Idle self-destruct: exit when no SSE connections and no sessions for 5 min ──
  const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  let activeSseCount = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function checkIdle(): void {
    if (options.disableIdleShutdown) return;
    if (activeSseCount === 0 && sessionManager.activeCount() === 0) {
      if (idleTimer) return; // already scheduled
      idleTimer = setTimeout(() => {
        // Re-check before exiting (new connection may have arrived)
        if (activeSseCount === 0 && sessionManager.activeCount() === 0) {
          console.log("[agentbox] No connections for 5 min, shutting down");
          process.exit(0);
        }
        idleTimer = null;
      }, IDLE_TIMEOUT_MS);
      console.log(`[agentbox] Idle detected, will shut down in ${IDLE_TIMEOUT_MS / 1000}s if no activity`);
    }
  }

  // Start initial idle check (pod may never receive any connections)
  checkIdle();

  // Wire session release → idle check (session released after TTL)
  sessionManager.onSessionRelease = () => checkIdle();

  const routes: Route[] = [];

  // Route registration helper
  function addRoute(method: string, path: string, handler: RequestHandler): void {
    const paramNames: string[] = [];
    const patternStr = path.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    routes.push({
      method,
      pattern: new RegExp(`^${patternStr}$`),
      paramNames,
      handler,
    });
  }

  // ==================== Routes ====================

  /**
   * GET /metrics - Prometheus metrics endpoint
   */
  addRoute("GET", "/metrics", async (req, res) => {
    if (!checkMetricsAuth(req, res)) return;
    const { metricsRegistry } = await import("../shared/metrics.js");
    res.writeHead(200, { "Content-Type": metricsRegistry.contentType });
    res.end(await metricsRegistry.metrics());
  });

  /**
   * GET /api/internal/metrics-snapshot - export metrics snapshot for Gateway pull (K8s mode)
   */
  addRoute("GET", "/api/internal/metrics-snapshot", async (_req, res) => {
    const { localCollector } = await import("../shared/local-collector.js");
    sendJson(res, 200, localCollector.exportSnapshot());
  });

  /**
   * GET /health - health check
   */
  addRoute("GET", "/health", async (_req, res) => {
    sendJson(res, 200, {
      status: "ok",
      sessions: sessionManager.list().length,
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /api/sessions - list all sessions
   */
  addRoute("GET", "/api/sessions", async (_req, res) => {
    const sessions = sessionManager.list().map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      lastActiveAt: s.lastActiveAt.toISOString(),
    }));
    sendJson(res, 200, { sessions });
  });

  /**
   * POST /api/prompt - send a message
   *
   * Body: { sessionId?: string, text: string }
   * Response: { ok: true, sessionId: string }
   *
   * The message is sent to the Agent, and responses are returned via SSE stream.
   */
  addRoute("POST", "/api/prompt", async (req, res) => {
    const body = (await parseJsonBody(req)) as { sessionId?: string; text?: string; mode?: SessionMode; modelProvider?: string; modelId?: string; systemPromptTemplate?: string; modelConfig?: Record<string, unknown> };

    if (!body.text) {
      sendJson(res, 400, { error: "Missing 'text' field" });
      return;
    }

    const enableDelegationTools = shouldEnableDelegationTools(body.text, body.sessionId, sessionManager);
    const managed = await sessionManager.getOrCreate(body.sessionId, body.mode, body.systemPromptTemplate, {
      enableDelegationTools,
    });
    if (!managed._promptDone) {
      sendJson(res, 409, {
        error: "Session is already running. Use the steer endpoint to add input to the active prompt.",
        sessionId: managed.id,
      });
      return;
    }

    // Mark the session busy before model setup so a refresh, second tab, or
    // fast double-submit cannot start a second prompt on the same brain.
    managed._promptDone = false;
    managed._aborted = false;
    managed._eventBuffer = [];
    // Unsubscribe previous buffer listener if any
    if (managed._bufferUnsub) {
      managed._bufferUnsub();
    }
    // Subscribe to buffer events so SSE can replay them even if it connects late
    const brainUnsub = managed.brain.subscribe((event) => {
      if (!managed._promptDone) {
        managed._eventBuffer.push(event);
      }
    });

    managed._bufferUnsub = () => {
      brainUnsub();
    };

    if (body.modelProvider || body.modelId || body.modelConfig) {
      sessionManager.setDelegationModel({
        provider: body.modelProvider,
        modelId: body.modelId,
        config: body.modelConfig,
      });
    }

    // Dynamically register provider config from gateway DB (before findModel)
    if (body.modelConfig && body.modelProvider && managed.brain.registerProvider) {
      try {
        managed.brain.registerProvider(body.modelProvider, body.modelConfig);
        console.log(`[agentbox-http] Registered provider "${body.modelProvider}" from gateway DB config`);
      } catch (err) {
        console.warn(`[agentbox-http] Failed to register provider "${body.modelProvider}":`, err instanceof Error ? err.message : err);
      }
    }

    // Set model if specified in prompt request (ensures model is applied before first prompt)
    // Always call setModel when the registry model differs from the session model
    // (covers field changes like reasoning/contextWindow without id/provider change)
    if (body.modelProvider && body.modelId) {
      const found = managed.brain.findModel(body.modelProvider, body.modelId);
      if (found) {
        const currentModel = managed.brain.getModel();
        const needsUpdate = !currentModel
          || currentModel.id !== found.id
          || currentModel.provider !== found.provider
          || currentModel.reasoning !== found.reasoning
          || currentModel.contextWindow !== found.contextWindow
          || currentModel.maxTokens !== found.maxTokens;
        if (needsUpdate) {
          console.log(`[agentbox-http] Setting model for session ${managed.id}: ${found.provider}/${found.id} (reasoning=${found.reasoning})`);
          await managed.brain.setModel(found);
        }
      }
    }

    let promptText = body.text;

    // --- Language detection: inject explicit instruction so model doesn't guess ---
    // IMPORTANT: append after DP markers, not prepend before them.
    // Prepending would break marker detection in pi-agent extension input handlers
    // (e.g., [System: respond in Chinese]\n[Deep Investigation]\n... fails startsWith check).
    const detectedLang = detectLanguage(body.text);
    if (detectedLang !== "English") {
      // Only two DP markers remain after the refactor: activation and exit.
      const dpMarkers = [DP_ACTIVATION_MARKER, `${DP_EXIT_MARKER}\n`];
      const matchedMarker = dpMarkers.find(m => promptText.startsWith(m));
      if (matchedMarker) {
        // Insert language hint after the marker: [Deep Investigation]\n[System: respond in Chinese]\n...
        promptText = matchedMarker + `[System: respond in ${detectedLang}]\n` + promptText.slice(matchedMarker.length);
      } else {
        promptText = `[System: respond in ${detectedLang}]\n${promptText}`;
      }
    }

    // Programmatically update PROFILE.md Language field (code-level, not model-dependent).
    // Only update on non-English detection to avoid flapping: English is the default,
    // so we only persist when the user actively uses another language.
    if (detectedLang !== "English") {
      try {
        const cfg = loadConfig();
        const userDataDir = process.env.SICLAW_USER_DATA_DIR || cfg.paths.userDataDir;
        const profilePath = path.resolve(userDataDir, "memory", "PROFILE.md");
        if (fs.existsSync(profilePath)) {
          const content = fs.readFileSync(profilePath, "utf-8");
          const currentLangMatch = content.match(/\*\*Language\*\*:\s*(.+)/i);
          const currentLang = currentLangMatch?.[1]?.trim();
          if (currentLang !== detectedLang) {
            const updated = content.replace(
              /(\*\*Language\*\*:\s*).+/i,
              `$1${detectedLang}`,
            );
            fs.writeFileSync(profilePath, updated);
          }
        }
      } catch { /* best-effort, don't block prompt */ }
    }

    // Execute prompt asynchronously; notify SSE to close on completion
    console.log(`[agentbox-http] Starting prompt for session ${managed.id} [lang=${detectedLang}]`);

    // Metrics: snapshot stats before prompt for delta calculation
    const prevStats = managed.brain.getSessionStats();
    const promptStartTime = Date.now();
    let promptOutcome: "completed" | "error" = "completed";

    const actuallyFinish = () => {
      managed._promptDone = true;

      // Emit prompt metrics via diagnostic event bus
      const currStats = managed.brain.getSessionStats();
      const model = managed.brain.getModel();
      emitDiagnostic({
        type: "prompt_complete",
        sessionId: managed.id,
        prev: prevStats,
        curr: currStats,
        model,
        durationMs: Date.now() - promptStartTime,
        outcome: promptOutcome,
        userId: sessionManager.userId,
      });

      // Stop buffering
      if (managed._bufferUnsub) {
        managed._bufferUnsub();
        managed._bufferUnsub = null;
      }
      for (const cb of managed._promptDoneCallbacks) {
        cb();
      }
      managed._promptDoneCallbacks.clear();

      // Schedule delayed release — gives frontend time to query context/model
      // after SSE closes. If a new prompt arrives before the TTL, the timer is
      // cancelled in getOrCreate() and the session stays alive.
      sessionManager.scheduleRelease(managed.id);
    };
    const onPromptFinish = () => {
      // If the agent is still active, auto-compaction is in progress, or an
      // auto-retry is pending, defer SSE close until the agent is truly done —
      // otherwise the frontend misses events.
      if (managed.isAgentActive || managed.isCompacting || managed.isRetrying) {
        console.log(`[agentbox-http] Prompt resolved but agent still busy for session ${managed.id} (active=${managed.isAgentActive} compacting=${managed.isCompacting} retrying=${managed.isRetrying}), deferring SSE close`);
        const unsub = managed.brain.subscribe((event: any) => {
          if (event.type === "agent_end" || event.type === "auto_compaction_end" || event.type === "auto_retry_end") {
            // Use setTimeout to let synchronous follow-up events (e.g.
            // auto_compaction_start right after agent_end, or agent_start
            // right after auto_retry_end) fire first.
            setTimeout(() => {
              if (!managed.isCompacting && !managed.isAgentActive && !managed.isRetrying) {
                unsub();
                actuallyFinish();
              }
            }, 50);
          }
        });
        return;
      }
      actuallyFinish();
    };
    managed.brain.prompt(promptText).then(() => {
      console.log(`[agentbox-http] Prompt completed for session ${managed.id}`);
      promptOutcome = "completed";
      onPromptFinish();
    }).catch((err) => {
      console.error(`[agentbox-http] Prompt error for session ${managed.id}:`, err);
      promptOutcome = "error";
      onPromptFinish();
    });

    sendJson(res, 200, { ok: true, sessionId: managed.id });
  });

  /**
   * GET /api/stream/:sessionId - SSE event stream
   *
   * Subscribe to the event stream of the specified session.
   */
  addRoute("GET", "/api/stream/:sessionId", async (req, res, params) => {
    const { sessionId } = params;
    console.log(`[agentbox-http] SSE stream request for session ${sessionId}`);
    const managed = sessionManager.get(sessionId);

    if (!managed) {
      console.log(`[agentbox-http] Session ${sessionId} not found`);
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    console.log(`[agentbox-http] Starting SSE stream for session ${sessionId}`);

    // Track active SSE connections for idle self-destruct
    activeSseCount++;
    resetIdleTimer();

    // Set SSE response headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Track connection state
    let closed = false;
    let sseEventCount = 0;

    // Write a single SSE event
    const writeEvent = (event: unknown) => {
      if (closed || res.writableEnded) return;
      try {
        sseEventCount++;
        const data = JSON.stringify(event);
        res.write(`data: ${data}\n\n`);
      } catch (err) {
        console.warn(`[agentbox-http] SSE write error for session ${sessionId}:`, err);
        closed = true;
      }
    };

    // Close SSE helper
    const closeSSE = () => {
      if (!closed && !res.writableEnded) {
        closed = true;
        res.end();
      }
    };

    // Replay any buffered events (emitted before SSE connected)
    for (const event of managed._eventBuffer) {
      writeEvent(event);
    }
    // Replay extra (tool-pushed) events that arrived before SSE connected.
    // These are tagged events like { type: "subagent_event", ... } from
    // dispatch_subagents' sub-agent bridge.
    for (const event of managed._extraEventBuffer) {
      writeEvent(event);
    }
    managed._extraEventBuffer.length = 0;

    // If prompt already finished before SSE connected, close immediately
    if (managed._promptDone) {
      console.log(`[agentbox-http] Prompt already done for session ${sessionId}, closing SSE after replay (${managed._eventBuffer.length} events)`);
      closeSSE();
      return;
    }

    // Subscribe to the session's extra event bus (tool-pushed events — see
    // ToolRefs.sessionEventEmitter). Unsubscribed alongside the brain
    // subscription in unsubAll below.
    const extraSub = (event: Record<string, unknown>) => writeEvent(event);
    managed._extraEventSubs.add(extraSub);

    // Subscribe to Agent events (live, after buffer replay)
    const unsubscribe = managed.brain.subscribe((event: any) => {
      // Enrich agent_end with context usage so frontend can display token stats
      if (event?.type === "agent_end") {
        const usage = managed.brain.getContextUsage?.();
        const stats = managed.brain.getSessionStats?.();
        if (usage || stats) {
          writeEvent({
            ...event,
            contextUsage: {
              tokens: usage?.tokens ?? 0,
              contextWindow: usage?.contextWindow ?? 0,
              percent: usage?.percent ?? 0,
              inputTokens: stats?.tokens?.input ?? 0,
              outputTokens: stats?.tokens?.output ?? 0,
              cacheReadTokens: stats?.tokens?.cacheRead ?? 0,
              cacheWriteTokens: stats?.tokens?.cacheWrite ?? 0,
              cost: stats?.cost ?? 0,
            },
          });
          return;
        }
      }
      writeEvent(event);
    });

    // Heartbeat: send SSE comment every 30s to keep connection alive
    // during long agent thinking periods (prevents proxy/fetch body timeouts)
    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded) {
        clearInterval(heartbeat);
        return;
      }
      try {
        res.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 30_000);

    // Cleanup helper: unsubscribe from all event sources
    const unsubAll = () => {
      unsubscribe();
      managed._extraEventSubs.delete(extraSub);
    };

    // Decrement SSE counter and check idle (called once per SSE lifecycle)
    let sseCountDecremented = false;
    const decrementSse = () => {
      if (!sseCountDecremented) {
        sseCountDecremented = true;
        activeSseCount--;
        checkIdle();
      }
    };

    // Close SSE when prompt completes
    const cleanup = () => {
      console.log(`[agentbox-http] SSE closing for session ${sessionId} (prompt done, ${sseEventCount} events sent)`);
      clearInterval(heartbeat);
      unsubAll();
      closeSSE();
      decrementSse();
    };
    managed._promptDoneCallbacks.add(cleanup);

    // Unsubscribe when client disconnects
    req.on("close", () => {
      console.log(`[agentbox-http] SSE client disconnected for session ${sessionId} (${sseEventCount} events sent)`);
      closed = true;
      clearInterval(heartbeat);
      managed._promptDoneCallbacks.delete(cleanup);
      unsubAll();
      decrementSse();
    });

    // Handle response errors
    res.on("error", (err) => {
      console.warn(`[agentbox-http] SSE response error for session ${sessionId}:`, err);
      closed = true;
      clearInterval(heartbeat);
      managed._promptDoneCallbacks.delete(cleanup);
      unsubAll();
      decrementSse();
    });
  });

  /**
   * POST /api/sessions/:sessionId/steer - send a steer instruction (insert user message after current tool is interrupted)
   */
  addRoute("POST", "/api/sessions/:sessionId/steer", async (req, res, params) => {
    const { sessionId } = params;
    const managed = sessionManager.get(sessionId);

    if (!managed) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    const body = (await parseJsonBody(req)) as { text?: string };
    if (!body.text) {
      sendJson(res, 400, { error: "Missing 'text' field" });
      return;
    }

    console.log(`[agentbox-http] Steering session ${sessionId}: ${body.text.slice(0, 80)}`);
    try {
      await managed.brain.steer(body.text);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error(`[agentbox-http] Steer error for session ${sessionId}:`, err);
      sendJson(res, 500, { error: "Steer failed" });
    }
  });

  /**
   * GET /api/sessions/:sessionId/dp-state — read DP mode flag for recovery.
   *
   * Simplified after the DP refactor: returns just `{active: boolean}` (or
   * the legacy `{dpStatus}` shape if the session was persisted before the
   * refactor, for one-migration transparency).
   */
  addRoute("GET", "/api/sessions/:sessionId/dp-state", async (_req, res, params) => {
    const { sessionId } = params;
    const managed = sessionManager.get(sessionId);

    if (managed?.dpStateRef) {
      sendJson(res, 200, { active: managed.dpStateRef.active });
      return;
    }

    const persisted = sessionManager.getPersistedDpState(sessionId);
    if (persisted) {
      sendJson(res, 200, persisted);
      return;
    }

    sendJson(res, 200, { active: false });
  });

  /**
   * POST /api/sessions/:sessionId/clear-queue - clear queued steer/followUp messages
   */
  addRoute("POST", "/api/sessions/:sessionId/clear-queue", async (_req, res, params) => {
    const { sessionId } = params;
    const managed = sessionManager.get(sessionId);

    if (!managed) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    console.log(`[agentbox-http] Clearing queue for session ${sessionId}`);
    const cleared = managed.brain.clearQueue();
    sendJson(res, 200, { ok: true, ...cleared });
  });

  /**
   * POST /api/sessions/:sessionId/abort - abort the current prompt
   */
  addRoute("POST", "/api/sessions/:sessionId/abort", async (_req, res, params) => {
    const { sessionId } = params;
    const managed = sessionManager.get(sessionId);

    if (!managed) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    console.log(`[agentbox-http] Aborting session ${sessionId} (abort endpoint called)`);
    console.trace(`[agentbox-http] Abort stack trace for session ${sessionId}`);
    managed._aborted = true;
    const outcome = await abortBrainForHttp(managed.brain, sessionId);
    if (outcome === "failed") {
      sendJson(res, 500, { error: "Abort failed" });
      return;
    }
    sendJson(res, 200, { ok: true, ...(outcome === "timeout" ? { pending: true } : {}) });
  });

  /**
   * POST /api/reload-{mcp,skills} — unified resource reload endpoints
   *
   * Each endpoint delegates to the matching AgentBoxSyncHandler:
   * fetch → materialize → postReload.
   * URL paths are preserved for backward compatibility.
   */
  let _reloadGatewayClient: GatewayClient | null = null;
  function getReloadGatewayClient(): GatewayClient | null {
    const gatewayUrl = process.env.SICLAW_GATEWAY_URL;
    if (!gatewayUrl) return null;
    if (!_reloadGatewayClient) _reloadGatewayClient = new GatewayClient({ gatewayUrl });
    return _reloadGatewayClient;
  }

  for (const descriptor of Object.values(GATEWAY_SYNC_DESCRIPTORS)) {
    addRoute("POST", descriptor.reloadPath, async (_req, res) => {
      const resourceType = descriptor.type;
      console.log(`[agentbox-http] Reloading ${resourceType} configuration`);

      const client = getReloadGatewayClient();
      // Only skip for handlers that actually need the HTTP client. Handlers
      // with requiresGatewayClient=false (cluster/host) bring their own
      // transport via the broker and run fine even when SICLAW_GATEWAY_URL
      // is unset (Local mode).
      if (descriptor.requiresGatewayClient && !client) {
        console.warn(`[agentbox-http] No SICLAW_GATEWAY_URL configured, skipping ${resourceType} reload`);
        sendJson(res, 200, { ok: true, count: 0, type: resourceType });
        return;
      }

      // Prefer the per-server handler (cluster/host) to guarantee the
      // closure binds to THIS httpServer's broker (Local mode isolation);
      // fall back to the module-level registry for mcp/skills which are
      // process-global and carry no per-session state.
      const handler = perServerHandlers[resourceType] ?? getSyncHandler(resourceType);
      if (!handler) {
        sendJson(res, 500, { error: `No handler for sync type "${resourceType}"` });
        return;
      }

      try {
        const payload = await handler.fetch(client ? client.toClientLike() : null);
        const count = await handler.materialize(payload);

        // Build session list for postReload. Handlers choose whether to call
        // brain.reload() (skills/knowledge — in-session hot-reload is safe) or
        // invalidate() (mcp — session must be rebuilt to pick up the new
        // toolset). invalidate() defers the release until any in-flight prompt
        // completes so tool execution is not torn down mid-turn.
        const sessions = sessionManager.list().map((s) => ({
          id: s.id,
          brain: s.brain,
          invalidate: () => {
            // Use scheduleRelease(0) instead of release() directly: the 0ms
            // timer yields to the event loop, so any concurrent getOrCreate
            // (e.g. user's next message arriving mid-invalidate) can cleanly
            // clearTimeout() and keep the session alive. Calling release()
            // synchronously would start an un-cancelable async shutdown that
            // could tear down mcpManager out from under an in-flight prompt.
            const doRelease = () => sessionManager.scheduleRelease(s.id, 0);
            if (s._promptDone) {
              doRelease();
            } else {
              s._promptDoneCallbacks.add(doRelease);
            }
          },
        }));

        if (handler.postReload) {
          await handler.postReload({ sessions });
        }

        console.log(`[agentbox-http] ${resourceType} reloaded: ${count} items`);
        sendJson(res, 200, { ok: true, count, type: resourceType });
      } catch (err: any) {
        console.error(`[agentbox-http] Failed to reload ${resourceType}: ${err.message}`);
        sendJson(res, 500, { error: `${resourceType} reload failed: ${err.message}` });
      }
    });
  }

  /**
   * GET /api/models - list available models (read from settings.json)
   */
  addRoute("GET", "/api/models", async (_req, res) => {
    const config = loadConfig();
    const models: Array<{ id: string; name: string; provider: string; contextWindow: number; maxTokens: number; reasoning: boolean }> = [];
    for (const [provider, providerConfig] of Object.entries(config.providers)) {
      for (const m of providerConfig.models) {
        models.push({
          id: m.id,
          name: m.name,
          provider,
          contextWindow: m.contextWindow ?? 0,
          maxTokens: m.maxTokens ?? 0,
          reasoning: m.reasoning ?? false,
        });
      }
    }
    sendJson(res, 200, { models });
  });

  /**
   * GET /api/sessions/:sessionId/model - get current model
   */
  addRoute("GET", "/api/sessions/:sessionId/model", async (_req, res, params) => {
    const { sessionId } = params;
    const managed = sessionManager.get(sessionId);

    if (!managed) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    const model = managed.brain.getModel();
    sendJson(res, 200, {
      model: model ?? null,
    });
  });

  /**
   * PUT /api/sessions/:sessionId/model - switch model
   */
  addRoute("PUT", "/api/sessions/:sessionId/model", async (req, res, params) => {
    const { sessionId } = params;
    const managed = sessionManager.get(sessionId);

    if (!managed) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    const body = (await parseJsonBody(req)) as { provider?: string; modelId?: string };
    if (!body.provider || !body.modelId) {
      sendJson(res, 400, { error: "Missing 'provider' and/or 'modelId'" });
      return;
    }

    const model = managed.brain.findModel(body.provider, body.modelId);
    if (!model) {
      sendJson(res, 404, { error: "Model not found" });
      return;
    }

    console.log(`[agentbox-http] Switching model for session ${sessionId}: ${model.provider}/${model.id}`);
    await managed.brain.setModel(model);
    sendJson(res, 200, { ok: true, model });
  });

  /**
   * GET /api/sessions/:sessionId/context - get context usage
   */
  addRoute("GET", "/api/sessions/:sessionId/context", async (_req, res, params) => {
    const { sessionId } = params;
    const managed = sessionManager.get(sessionId);

    if (!managed) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    const usage = managed.brain.getContextUsage();
    const stats = managed.brain.getSessionStats();
    sendJson(res, 200, {
      tokens: usage?.tokens ?? 0,
      contextWindow: usage?.contextWindow ?? 0,
      percent: usage?.percent ?? 0,
      isCompacting: managed.isCompacting,
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheReadTokens: stats.tokens.cacheRead,
      cacheWriteTokens: stats.tokens.cacheWrite,
      cost: stats.cost,
    });
  });

  /**
   * DELETE /api/sessions/:sessionId - close session
   */
  addRoute("DELETE", "/api/sessions/:sessionId", async (_req, res, params) => {
    const { sessionId } = params;
    await sessionManager.close(sessionId);
    sendJson(res, 200, { ok: true });
  });

  /**
   * DELETE /api/memory - reset memory indexer after Gateway clears PVC files
   */
  addRoute("DELETE", "/api/memory", async (_req, res) => {
    console.log(`[agentbox-http] Resetting memory indexer`);
    try {
      await sessionManager.resetMemory();
      sendJson(res, 200, { ok: true });
    } catch (err: any) {
      console.error(`[agentbox-http] Memory reset failed: ${err.message}`);
      sendJson(res, 500, { error: `Memory reset failed: ${err.message}` });
    }
  });

  // ==================== Server ====================

  /** Main request handler shared by HTTP and HTTPS servers */
  const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    // mTLS Gateway identity check (HTTPS only, skip /health for K8s probes)
    if (useTls && pathname !== "/health") {
      const tlsSocket = req.socket as TLSSocket;
      const peerCert = tlsSocket.getPeerCertificate?.();
      if (!peerCert || !peerCert.subject) {
        sendJson(res, 403, { error: "Client certificate required" });
        return;
      }
      if (peerCert.subject.OU !== "Gateway" && peerCert.subject.OU !== "Runtime") {
        console.warn(`[agentbox-http] Rejected request from OU=${peerCert.subject.OU} (expected Gateway or Runtime)`);
        sendJson(res, 403, { error: "Forbidden: only Gateway/Runtime can access this API" });
        return;
      }
    }

    // Match route
    for (const route of routes) {
      if (route.method !== method) continue;

      const match = pathname.match(route.pattern);
      if (!match) continue;

      // Extract path parameters
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1];
      });

      try {
        await route.handler(req, res, params);
      } catch (err) {
        console.error(`[agentbox-http] Error handling ${method} ${pathname}:`, err);
        if (!res.headersSent) {
          sendJson(res, 500, { error: "Internal server error" });
        }
      }
      return;
    }

    // 404
    sendJson(res, 404, { error: "Not found" });
  };

  // Detect TLS certificates
  const certPath = process.env.SICLAW_CERT_PATH || "/etc/siclaw/certs";
  const certFile = path.join(certPath, "tls.crt");
  const keyFile = path.join(certPath, "tls.key");
  const caFile = path.join(certPath, "ca.crt");
  const useTls = fs.existsSync(certFile) && fs.existsSync(keyFile) && fs.existsSync(caFile);

  if (useTls) {
    console.log(`[agentbox-http] TLS certificates found at ${certPath}, starting HTTPS server`);
    const server = https.createServer(
      {
        cert: fs.readFileSync(certFile),
        key: fs.readFileSync(keyFile),
        ca: fs.readFileSync(caFile),
        requestCert: true,
        rejectUnauthorized: false, // Allow K8s probes without client cert; app-layer checks OU for non-health routes
      },
      requestHandler,
    );
    return server;
  }

  console.log("[agentbox-http] No TLS certificates found, starting HTTP server (dev mode)");
  const server = http.createServer(requestHandler);
  return server;
}
