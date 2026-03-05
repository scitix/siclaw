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
import type { SessionMode } from "../core/agent-factory.js";
import type { BrainType } from "../core/brain-session.js";
import { hasOpenAIProvider, ensureProxy } from "../core/llm-proxy.js";
import { deepSearchEvents } from "../tools/deep-search/events.js";
import { createChecklist, buildActivationMessage } from "../tools/dp-tools.js";
import { loadConfig, reloadConfig } from "../core/config.js";
import { GatewayClient } from "./gateway-client.js";
import { syncMcpFromGateway } from "./mcp-sync.js";

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
async function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Send JSON response
 */
function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const SAFE_ENTRY_NAME_RE = /^[A-Za-z0-9._-]+$/;

function assertSafeEntryName(name: string, label: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty`);
  }
  if (trimmed === "." || trimmed === ".." || !SAFE_ENTRY_NAME_RE.test(trimmed)) {
    throw new Error(`${label} contains invalid characters`);
  }
  return trimmed;
}

function resolveSafeChildPath(baseDir: string, name: string, label: string): string {
  const safeName = assertSafeEntryName(name, label);
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, safeName);
  if (path.dirname(resolved) !== base) {
    throw new Error(`${label} path escapes base directory`);
  }
  return resolved;
}


/**
 * Write a skill bundle to local disk.
 * Clears existing skills and writes each skill's SKILL.md + scripts/.
 */
export async function materializeBundle(
  bundle: { skills: Array<{ dirName: string; specs: string; scripts: Array<{ name: string; content: string }> }> },
  skillsDir: string,
): Promise<void> {
  // Clear existing skill dirs (but not hidden files like .gitkeep)
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir)) {
      if (entry.startsWith(".")) continue;
      fs.rmSync(path.join(skillsDir, entry), { recursive: true });
    }
  } else {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  for (const skill of bundle.skills) {
    const skillDir = resolveSafeChildPath(skillsDir, skill.dirName, "Skill directory name");
    fs.mkdirSync(skillDir, { recursive: true });

    // Write SKILL.md
    if (skill.specs) {
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), skill.specs);
    }

    // Write scripts
    if (skill.scripts.length > 0) {
      const scriptsDir = path.join(skillDir, "scripts");
      fs.mkdirSync(scriptsDir, { recursive: true });
      for (const script of skill.scripts) {
        const scriptPath = resolveSafeChildPath(scriptsDir, script.name, "Script file name");
        fs.writeFileSync(scriptPath, script.content, { mode: 0o755 });
      }
    }
  }
}

/**
 * Create HTTP or HTTPS server (auto-detects certificates)
 */
export function createHttpServer(sessionManager: AgentBoxSessionManager): http.Server | https.Server {
  // Pre-start LLM proxy (fire-and-forget, ready before first prompt)
  if (hasOpenAIProvider()) {
    ensureProxy().catch(err => console.warn("[agentbox] LLM proxy pre-start failed:", err));
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
    const body = (await parseJsonBody(req)) as { sessionId?: string; text?: string; mode?: SessionMode; modelProvider?: string; modelId?: string; brainType?: BrainType; modelConfig?: Record<string, unknown>; credentials?: { manifest: Array<Record<string, unknown>>; files: Array<{ name: string; content: string; mode?: number }> } };

    if (!body.text) {
      sendJson(res, 400, { error: "Missing 'text' field" });
      return;
    }

    const managed = await sessionManager.getOrCreate(body.sessionId, body.mode, body.brainType);

    // Materialize credential files from payload (sent by gateway in prompt body)
    if (body.credentials?.files?.length) {
      const credDir = path.resolve(process.cwd(), loadConfig().paths.credentialsDir);
      fs.mkdirSync(credDir, { recursive: true });
      // Clear existing files
      for (const entry of fs.readdirSync(credDir)) {
        fs.rmSync(path.join(credDir, entry), { recursive: true });
      }
      // Write credential files
      for (const file of body.credentials.files) {
        const filePath = resolveSafeChildPath(credDir, file.name, "Credential file name");
        fs.writeFileSync(filePath, file.content, file.mode ? { mode: file.mode } : undefined);
      }
      // Write manifest
      fs.writeFileSync(path.join(credDir, "manifest.json"), JSON.stringify(body.credentials.manifest, null, 2));
      managed.kubeconfigRef.credentialsDir = credDir;
      console.log(`[agentbox-http] Materialized ${body.credentials.files.length} credential files to ${credDir}`);
    }

    // Dynamically register provider config from gateway DB (before findModel)
    if (body.modelConfig && body.modelProvider && managed.brain.registerProvider) {
      try {
        managed.brain.registerProvider(body.modelProvider, body.modelConfig);
        console.log(`[agentbox-http] Registered provider "${body.modelProvider}" from gateway DB config`);
        // Update LLM config ref so deep_search sub-agents follow the main model
        const mc = body.modelConfig as Record<string, unknown>;
        if (mc.baseUrl && mc.apiKey) {
          managed.llmConfigRef.apiKey = mc.apiKey as string;
          managed.llmConfigRef.baseUrl = mc.baseUrl as string;
          if (mc.api) {
            managed.llmConfigRef.api = mc.api as string;
          }
          // Use the specific modelId from the prompt if available
          if (body.modelId) {
            managed.llmConfigRef.model = body.modelId as string;
          }
          console.log(`[agentbox-http] Updated llmConfigRef: baseUrl=${(mc.baseUrl as string).slice(0, 40)}... model=${managed.llmConfigRef.model}`);
        }
      } catch (err) {
        console.warn(`[agentbox-http] Failed to register provider "${body.modelProvider}":`, err instanceof Error ? err.message : err);
      }
    }

    // Set model if specified in prompt request (ensures model is applied before first prompt)
    if (body.modelProvider && body.modelId) {
      const found = managed.brain.findModel(body.modelProvider, body.modelId);
      if (found) {
        const currentModel = managed.brain.getModel();
        if (!currentModel || currentModel.id !== found.id || currentModel.provider !== found.provider) {
          console.log(`[agentbox-http] Setting model for session ${managed.id}: ${found.provider}/${found.id}`);
          await managed.brain.setModel(found);
        }
      }
    }

    // Reset prompt state and start buffering events before async execution
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

    // Also buffer deep_search progress events (same stream as session events)
    const deepProgressBufHandler = (event: unknown) => {
      if (!managed._promptDone) {
        managed._eventBuffer.push({
          type: "tool_progress",
          toolName: "deep_search",
          progress: event,
        });
      }
    };
    deepSearchEvents.on("progress", deepProgressBufHandler);

    managed._bufferUnsub = () => {
      brainUnsub();
      deepSearchEvents.off("progress", deepProgressBufHandler);
    };

    // --- DP input transformation (SDK brain only — pi-agent uses extension input handlers) ---
    let promptText = body.text;
    if (managed.dpState) {
      const dpState = managed.dpState;
      const DP_MARKER = "[Deep Investigation]\n";
      const EXIT_MARKER = "[DP_EXIT]\n";

      if (promptText.startsWith(DP_MARKER)) {
        const question = promptText.slice(DP_MARKER.length).trim();
        if (question) {
          dpState.checklist = createChecklist(question);
          promptText = buildActivationMessage(question);
          console.log(`[agentbox-http] DP activated for SDK brain, session ${managed.id}`);
        }
      } else if (promptText.startsWith(EXIT_MARKER)) {
        const userText = promptText.slice(EXIT_MARKER.length).trim();
        if (dpState.checklist) {
          for (const item of dpState.checklist.items) {
            if (item.status === "pending" || item.status === "in_progress") {
              item.status = "skipped";
              item.summary = "User exited investigation";
            }
          }
        }
        dpState.checklist = null;
        promptText = `The user has exited deep investigation mode. ${userText}`;
        console.log(`[agentbox-http] DP exited for SDK brain, session ${managed.id}`);
      }
    }

    // Execute prompt asynchronously; notify SSE to close on completion
    console.log(`[agentbox-http] Starting prompt for session ${managed.id}`);
    const actuallyFinish = () => {
      managed._promptDone = true;
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
      onPromptFinish();
    }).catch((err) => {
      console.error(`[agentbox-http] Prompt error for session ${managed.id}:`, err);
      onPromptFinish();
    });

    sendJson(res, 200, { ok: true, sessionId: managed.id, brainType: managed.brainType });
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

    // If prompt already finished before SSE connected, close immediately
    if (managed._promptDone) {
      console.log(`[agentbox-http] Prompt already done for session ${sessionId}, closing SSE after replay (${managed._eventBuffer.length} events)`);
      closeSSE();
      return;
    }

    // Subscribe to Agent events (live, after buffer replay)
    const unsubscribe = managed.brain.subscribe((event) => {
      writeEvent(event);
    });

    // Also forward deep_search progress events as tool_progress SSE events
    const deepProgressSSEHandler = (event: unknown) => {
      writeEvent({
        type: "tool_progress",
        toolName: "deep_search",
        progress: event,
      });
    };
    deepSearchEvents.on("progress", deepProgressSSEHandler);

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
      deepSearchEvents.off("progress", deepProgressSSEHandler);
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
    try {
      await managed.brain.abort();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error(`[agentbox-http] Abort error for session ${sessionId}:`, err);
      sendJson(res, 500, { error: "Abort failed" });
    }
  });

  /**
   * POST /api/reload-skills - hot-reload skills
   *
   * Fetches skill bundle from Gateway via mTLS, writes to local disk, then
   * calls reload() on all active sessions to rescan and rebuild system prompts.
   */
  addRoute("POST", "/api/reload-skills", async (_req, res) => {
    const sessions = sessionManager.list();
    console.log(`[agentbox-http] Reloading skills for ${sessions.length} active sessions`);

    // Fetch fresh bundle from Gateway (mTLS — identity from certificate)
    const gatewayUrl = process.env.SICLAW_GATEWAY_URL;
    if (gatewayUrl) {
      try {
        const client = new GatewayClient({ gatewayUrl });
        const bundle = await client.fetchSkillBundle();
        const config = loadConfig();
        const skillsDir = path.resolve(process.cwd(), config.paths.skillsDir);
        await materializeBundle(bundle, skillsDir);

        // Write disabled builtins list for agent-factory to exclude
        const disabledFile = path.join(skillsDir, ".disabled-builtins.json");
        if (bundle.disabledBuiltins?.length) {
          fs.writeFileSync(disabledFile, JSON.stringify(bundle.disabledBuiltins));
        } else if (fs.existsSync(disabledFile)) {
          fs.unlinkSync(disabledFile);
        }

        console.log(`[agentbox-http] Bundle materialized: ${bundle.skills.length} skills (${bundle.disabledBuiltins?.length || 0} builtins disabled), version=${bundle.version}`);
      } catch (err: any) {
        console.warn(`[agentbox-http] Failed to fetch skill bundle from Gateway: ${err.message}`);
      }
    }

    const errors: string[] = [];
    for (const managed of sessions) {
      try {
        await managed.brain.reload();
        console.log(`[agentbox-http] Skills reloaded for session ${managed.id}`);
      } catch (err: any) {
        console.error(`[agentbox-http] Failed to reload skills for session ${managed.id}:`, err);
        errors.push(`${managed.id}: ${err.message}`);
      }
    }
    sendJson(res, 200, { ok: true, reloaded: sessions.length - errors.length, errors });
  });

  /**
   * POST /api/reload-mcp - hot-reload MCP configuration
   *
   * Fetches merged MCP config from Gateway via mTLS, writes to local disk.
   * New sessions will pick up the updated config.
   */
  let _mcpGatewayClient: GatewayClient | null = null;
  function getMcpGatewayClient(): GatewayClient | null {
    const gatewayUrl = process.env.SICLAW_GATEWAY_URL;
    if (!gatewayUrl) return null;
    if (!_mcpGatewayClient) _mcpGatewayClient = new GatewayClient({ gatewayUrl });
    return _mcpGatewayClient;
  }

  addRoute("POST", "/api/reload-mcp", async (_req, res) => {
    console.log("[agentbox-http] Reloading MCP configuration");

    const client = getMcpGatewayClient();
    if (!client) {
      console.warn("[agentbox-http] No SICLAW_GATEWAY_URL configured, skipping MCP reload");
      sendJson(res, 200, { ok: true, servers: 0 });
      return;
    }

    try {
      const count = await syncMcpFromGateway(client);
      reloadConfig();

      console.log(`[agentbox-http] MCP config reloaded: ${count} servers`);
      sendJson(res, 200, { ok: true, servers: count });
    } catch (err: any) {
      console.error(`[agentbox-http] Failed to reload MCP config: ${err.message}`);
      sendJson(res, 500, { error: `MCP reload failed: ${err.message}` });
    }
  });

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
      brainType: managed.brainType,
    });
  });

  /**
   * POST /api/sessions/:sessionId/model - switch model
   */
  addRoute("POST", "/api/sessions/:sessionId/model", async (req, res, params) => {
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
   * POST /api/sessions/:sessionId/close - close session
   */
  addRoute("POST", "/api/sessions/:sessionId/close", async (_req, res, params) => {
    const { sessionId } = params;
    await sessionManager.close(sessionId);
    sendJson(res, 200, { ok: true });
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
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
      if (peerCert.subject.OU !== "Gateway") {
        console.warn(`[agentbox-http] Rejected request from OU=${peerCert.subject.OU} (expected Gateway)`);
        sendJson(res, 403, { error: "Forbidden: only Gateway can access this API" });
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
