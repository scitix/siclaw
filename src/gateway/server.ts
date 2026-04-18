/**
 * Siclaw Agent Runtime — stateless execution engine (DB-free).
 *
 * All data access goes through Portal/Upstream adapter API.
 *
 * Port 3001 (HTTP):
 *   GET  /api/health              — K8s liveness/readiness
 *   GET  /metrics                 — Prometheus
 *   WS   /ws                      — Upstream WS RPC (Trusted Proxy auth)
 *   /api/v1/siclaw/metrics/*      — Metrics (proxied to adapter for summary/audit)
 *   /api/v1/siclaw/system/*       — System config (proxied to adapter)
 *
 * Port 3002 (HTTPS mTLS):
 *   POST /api/internal/credential-request  — proxy to adapter
 *   GET  /api/internal/settings            — proxy to adapter
 *   GET  /api/internal/mcp-servers         — proxy to adapter
 *   GET  /api/internal/skills/bundle       — proxy to adapter
 *   *    /api/internal/agent-tasks[/:id]   — proxy to adapter
 *   POST /api/internal/feedback            — AgentBox feedback
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { WebSocketServer, WebSocket } from "ws";
import type { RuntimeConfig } from "./config.js";
import type { AgentBoxManager } from "./agentbox/manager.js";
import { AgentBoxClient, type PromptOptions } from "./agentbox/client.js";
import {
  createBroadcaster,
  buildEvent,
  parseFrame,
  dispatchRpc,
  MAX_BUFFERED_BYTES,
  type RpcHandler,
  type RpcContext,
  type BroadcastFn,
} from "./ws-protocol.js";
import { authenticateProxy, type ProxyIdentity } from "./trusted-proxy.js";
import { handleCredentialRequest, handleCredentialList } from "./credential-proxy.js";
import { type CredentialService } from "./credential-service.js";
import { CertificateManager, type CertificateIdentity } from "./security/cert-manager.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import { createMtlsMiddleware } from "./security/mtls-middleware.js";
import type { BoxSpawner } from "./agentbox/spawner.js";
import { checkMetricsAuth } from "../shared/metrics.js";
import {
  handleSettings,
  handleMcpServers,
  handleSkillsBundle,
  handleKnowledgeBundle,
  handleAgentTasksList,
  handleAgentTasksCreate,
  handleAgentTasksUpdate,
  handleAgentTasksDelete,
} from "./internal-api.js";
import { createRestRouter } from "./rest-router.js";
// siclaw-api.ts routes moved to Portal — Runtime no longer registers CRUD routes.
import { appendMessage, incrementMessageCount, ensureChatSession } from "./chat-repo.js";
import { consumeAgentSse } from "./sse-consumer.js";
import { buildRedactionConfigForModelConfig } from "./output-redactor.js";
import { registerMetricsRoutes } from "./metrics-api.js";
import { registerSystemRoutes } from "./system-api.js";
import { MetricsAggregator } from "./metrics-aggregator.js";
import { LocalSpawner } from "./agentbox/local-spawner.js";
import { sessionRegistry } from "./session-registry.js";

export interface RuntimeServer {
  httpServer: http.Server;
  httpsServer: https.Server | null;
  certManager: CertificateManager;
  broadcast: BroadcastFn;
  rpcMethods: Map<string, RpcHandler>;
  agentBoxTlsOptions?: { cert: string; key: string; ca: string };
  credentialService: CredentialService;
  close(): Promise<void>;
}

export interface StartRuntimeOptions {
  config: RuntimeConfig;
  agentBoxManager: AgentBoxManager;
  spawner?: BoxSpawner;
  /** FrontendWsClient for Portal RPC communication. */
  frontendClient: FrontendWsClient;
  /** Optional pre-constructed credential service. When omitted, builds from config. */
  credentialService?: CredentialService;
  /** Optional pre-constructed CertificateManager. When omitted, creates a new one. */
  certManager?: CertificateManager;
}

export async function startRuntime(opts: StartRuntimeOptions): Promise<RuntimeServer> {
  const { config, agentBoxManager, spawner, frontendClient } = opts;

  const clients = new Set<WebSocket>();
  const broadcast = createBroadcaster(clients);

  // ── Credential Service ───────────────────────────────────
  if (!opts.credentialService) throw new Error("credentialService is required in StartRuntimeOptions");
  const credentialService = opts.credentialService;

  // ── Certificate Manager ──────────────────────────────────
  const certManager = opts.certManager ?? await CertificateManager.create();
  agentBoxManager.setCertManager(certManager);
  const gatewayHostname = process.env.SICLAW_GATEWAY_HOSTNAME || "siclaw-runtime.siclaw.svc.cluster.local";
  const serverCert = certManager.issueServerCertificate(gatewayHostname);

  const agentBoxTlsOptions = {
    cert: serverCert.cert,
    key: serverCert.key,
    ca: certManager.getCACertificate(),
  };

  // ── RPC Methods (chat only) ──────────────────────────────
  const rpcMethods = new Map<string, RpcHandler>();

  // Map of per-WS abort controllers for SSE streaming
  const activeStreams = new Map<WebSocket, AbortController>();

  rpcMethods.set("chat.send", async (params, context: RpcContext) => {
    const agentId = (params.agentId as string) || context.proxy?.agentId;
    const userId = params.userId as string;
    const orgId = params.orgId as string | undefined;
    const text = params.text as string;
    const incomingSessionId = params.sessionId as string | undefined;

    if (!agentId || !userId || !text) {
      throw new Error("agentId, userId, and text are required");
    }

    // Get or create AgentBox for this agent — one pod per agent, shared by
    // all callers. Caller identity travels as sessionId.
    const handle = await agentBoxManager.getOrCreate(agentId);
    const client = new AgentBoxClient(handle.endpoint, 30000, agentBoxTlsOptions);

    // Pre-generate a UUID so the AgentBox doesn't fall back to the literal
    // "default" session id (LocalSpawner behaviour), which would merge every
    // caller's trace into one chat_sessions row.
    const sessionId = incomingSessionId ?? crypto.randomUUID();
    // Record sessionId → userId so AgentBox → Runtime internal-api callbacks
    // can recover user attribution for Upstream audit.
    sessionRegistry.remember(sessionId, userId, agentId);

    // Build prompt options from params (Upstream sends full context)
    const modelConfig = params.modelConfig as PromptOptions["modelConfig"];
    const promptOpts: PromptOptions = {
      sessionId,
      text,
      agentId,
      modelProvider: params.modelProvider as string | undefined,
      modelId: params.modelId as string | undefined,
      systemPromptTemplate: params.systemPrompt as string | undefined,
      mode: params.mode as string | undefined,
      modelConfig,
    };

    const promptResult = await client.prompt(promptOpts);

    // Ensure chat_sessions exists + persist the user message BEFORE the SSE
    // consumer starts writing assistant/tool rows (FK on chat_messages).
    await ensureChatSession(promptResult.sessionId, agentId, userId, text);
    await appendMessage({ sessionId: promptResult.sessionId, role: "user", content: text });
    await incrementMessageCount(promptResult.sessionId);

    // Minimal redaction: scrub the apiKey + baseUrl from any captured tool
    // output. Credential-manifest redaction is follow-up work.
    const redactionConfig = buildRedactionConfigForModelConfig(modelConfig);

    // Stream + persist events back to the caller via sendEvent().
    // - Direct WS mode: sendEvent writes to the originating WS connection
    // - Phone-home mode: sendEvent emits via FrontendWsClient to Portal
    {
      const abortCtrl = new AbortController();
      if (context.ws) activeStreams.set(context.ws, abortCtrl);

      // Non-blocking: consume events in background
      (async () => {
        try {
          await consumeAgentSse({
            client,
            sessionId: promptResult.sessionId,
            userId,
            persistMessages: true,
            redactionConfig,
            signal: abortCtrl.signal,
            onEvent: (evt) => {
              context.sendEvent("chat.event", { sessionId: promptResult.sessionId, event: evt });
            },
          });
          // Signal Portal that the prompt is fully complete (all agent turns done).
          // agent_end fires after each turn — prompt_done fires once at the very end.
          context.sendEvent("chat.event", { sessionId: promptResult.sessionId, event: { type: "prompt_done" } });
        } catch (err) {
          if (!abortCtrl.signal.aborted) {
            console.error(`[runtime] SSE stream error for session=${promptResult.sessionId}:`, err);
          }
          // Ensure prompt_done is sent even on error so Portal SSE doesn't hang
          context.sendEvent("chat.event", { sessionId: promptResult.sessionId, event: { type: "prompt_done" } });
        } finally {
          if (context.ws) activeStreams.delete(context.ws);
        }
      })();
    }

    return { ok: true, sessionId: promptResult.sessionId };
  });

  rpcMethods.set("chat.abort", async (params) => {
    const agentId = params.agentId as string;
    const sessionId = params.sessionId as string;
    if (!agentId || !sessionId) throw new Error("agentId, sessionId required");

    const handle = await agentBoxManager.getOrCreate(agentId);
    const client = new AgentBoxClient(handle.endpoint, 10000, agentBoxTlsOptions);
    await client.abortSession(sessionId);
    return { ok: true };
  });

  rpcMethods.set("chat.steer", async (params) => {
    const agentId = params.agentId as string;
    const sessionId = params.sessionId as string;
    const text = params.text as string;
    if (!agentId || !sessionId || !text) throw new Error("agentId, sessionId, text required");

    const handle = await agentBoxManager.getOrCreate(agentId);
    const client = new AgentBoxClient(handle.endpoint, 10000, agentBoxTlsOptions);
    await client.steerSession(sessionId, text);
    return { ok: true };
  });

  rpcMethods.set("chat.clearQueue", async (params) => {
    const agentId = params.agentId as string;
    const sessionId = params.sessionId as string;
    if (!agentId || !sessionId) throw new Error("agentId, sessionId required");

    const handle = await agentBoxManager.getOrCreate(agentId);
    const client = new AgentBoxClient(handle.endpoint, 10000, agentBoxTlsOptions);
    const cleared = await client.clearQueue(sessionId);
    return { ok: true, ...cleared };
  });

  rpcMethods.set("agent.clearMemory", async (params) => {
    const agentId = params.agentId as string;
    if (!agentId) throw new Error("agentId required");

    // Memory is agent-scoped (one pod per agent). Path mirrors the k8s-spawner
    // subPath layout: `/app/.siclaw/user-data/agents/{agentId}/memory`.
    const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 63);
    const userDataBase = "/app/.siclaw/user-data";
    const memoryDir = path.resolve(userDataBase, "agents", sanitize(agentId), "memory");

    // Delete memory files
    let deletedFiles = 0;
    if (fs.existsSync(memoryDir)) {
      const investigationsDir = path.join(memoryDir, "investigations");
      if (fs.existsSync(investigationsDir)) {
        const invFiles = fs.readdirSync(investigationsDir).filter((f: string) => f.endsWith(".md"));
        deletedFiles += invFiles.length;
        fs.rmSync(investigationsDir, { recursive: true });
      }
      for (const entry of fs.readdirSync(memoryDir)) {
        if (entry === "PROFILE.md") continue;
        const fullPath = path.join(memoryDir, entry);
        if (fs.statSync(fullPath).isFile() && !entry.startsWith(".memory.db")) {
          fs.unlinkSync(fullPath);
          if (entry.endsWith(".md")) deletedFiles++;
        }
      }
    }

    console.log(`[rpc] agent.clearMemory: deleted ${deletedFiles} files in ${memoryDir}`);

    // Notify AgentBox to reset indexer
    try {
      const handle = await agentBoxManager.getAsync(agentId);
      if (handle) {
        const client = new AgentBoxClient(handle.endpoint, 10000, agentBoxTlsOptions);
        await client.resetMemory();
        console.log("[rpc] agent.clearMemory: AgentBox notified to reset indexer");
      }
    } catch (err: any) {
      console.warn(`[rpc] agent.clearMemory: AgentBox notify failed: ${err.message}`);
    }

    return { ok: true, deletedFiles };
  });

  rpcMethods.set("agent.terminate", async (params) => {
    const agentId = params.agentId as string;
    if (!agentId) throw new Error("agentId required");

    const boxes = await agentBoxManager.list();
    const targets = boxes.filter((b) => b.agentId === agentId);

    // Stop all matching boxes in parallel; each error is contained so one
    // failure doesn't block the rest.
    const results = await Promise.all(
      targets.map(async (box) => {
        try {
          await agentBoxManager.stop(box.agentId);
          return { ok: true, boxId: box.boxId };
        } catch (err: any) {
          console.warn(`[rpc] agent.terminate: failed to stop ${box.boxId}: ${err.message}`);
          return { ok: false, boxId: box.boxId, error: err.message as string };
        }
      }),
    );

    const stopped = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);

    console.log(`[rpc] agent.terminate: stopped ${stopped}/${targets.length} boxes for agent=${agentId}`);
    return { ok: true, stopped, total: targets.length, failed };
  });

  rpcMethods.set("agent.reload", async (params) => {
    const agentId = params.agentId as string;
    if (!agentId) throw new Error("agentId required");

    // All types route through GATEWAY_SYNC_DESCRIPTORS — the legacy
    // "credentials" umbrella type is replaced by the more granular
    // "cluster" + "host" so CRUD events can notify only what changed.
    const resourceTypes = (params.resources as string[] | undefined) ?? ["skills", "mcp", "cluster", "host", "knowledge"];

    const boxes = await agentBoxManager.list();
    const targets = boxes.filter((b) => b.agentId === agentId);

    if (targets.length === 0) {
      console.log(`[rpc] agent.reload: no active boxes for agent=${agentId}, skipping`);
      return { ok: true, reloaded: [], skipped: resourceTypes, boxes: 0 };
    }

    const reloaded: string[] = [];
    const failed: string[] = [];

    for (const box of targets) {
      const client = new AgentBoxClient(box.endpoint, 15_000, agentBoxTlsOptions);
      for (const rt of resourceTypes) {
        try {
          await client.reloadResource(rt as import("../shared/gateway-sync.js").GatewaySyncType);
          if (!reloaded.includes(rt)) reloaded.push(rt);
        } catch (err: any) {
          console.warn(`[rpc] agent.reload: ${rt} failed for box=${box.boxId}: ${err.message}`);
          if (!failed.includes(rt)) failed.push(rt);
        }
      }
    }

    console.log(`[rpc] agent.reload: agent=${agentId} boxes=${targets.length} reloaded=[${reloaded}] failed=[${failed}]`);
    return { ok: true, reloaded, failed, boxes: targets.length };
  });

  // metrics.live — delayed ref to metricsAggregator (created after rpcMethods)
  let metricsAggregatorRef: MetricsAggregator | null = null;
  rpcMethods.set("metrics.live", async (params) => {
    if (!metricsAggregatorRef) throw new Error("MetricsAggregator not ready");
    const userId = (params as any)?.userId || undefined;
    return {
      snapshot: metricsAggregatorRef.snapshot(),
      topTools: metricsAggregatorRef.topTools(10, userId),
      topSkills: metricsAggregatorRef.topSkills(10, userId),
    };
  });

  // ── Phone-home: register inbound commands from Portal via FrontendWsClient ──
  // Portal sends commands (e.g. chat.send, agent.reload, task.fireNow) to
  // Runtime over the persistent WS connection. We route them through the
  // same rpcMethods map used by the WS server.
  frontendClient.onCommand(async (method, params) => {
    const handler = rpcMethods.get(method);
    if (!handler) throw new Error(`Unknown RPC method: ${method}`);
    // Build a context that emits events back to Portal via the WS connection.
    // chat.send uses context.sendEvent + context.ws to stream SSE events;
    // in phone-home mode we use frontendClient.emitEvent() instead of a WS ref.
    const context: RpcContext = {
      sendEvent: (event, payload) => {
        frontendClient.emitEvent(event, payload);
      },
    };
    return handler(params, context);
  });

  // ── REST API Router ──────────────────────────────────────
  // Siclaw CRUD routes are now handled by Portal (portal/siclaw-api.ts).
  // Runtime only serves health, WS, and internal mTLS endpoints.
  const restRouter = createRestRouter();

  // ── MetricsAggregator (K8s: pull loop; Local: proxy to in-process localCollector) ──
  const isK8sMode = !(spawner instanceof LocalSpawner);
  let metricsAggregator: MetricsAggregator;
  if (isK8sMode) {
    metricsAggregator = new MetricsAggregator("k8s", undefined, agentBoxManager, {
      async fetch(endpoint: string) {
        try {
          const client = new AgentBoxClient(endpoint, 3000, agentBoxTlsOptions);
          return await client.getJson("/api/internal/metrics-snapshot");
        } catch {
          return null;
        }
      },
    });
  } else {
    const { localCollector } = await import("../shared/local-collector.js");
    metricsAggregator = new MetricsAggregator("local", localCollector);
  }

  metricsAggregatorRef = metricsAggregator;
  registerMetricsRoutes(restRouter, config, metricsAggregator, frontendClient);
  registerSystemRoutes(restRouter, config, frontendClient);

  // ── Metrics config ───────────────────────────────────────
  const cachedMetricsToken = process.env.SICLAW_METRICS_TOKEN;

  // ── HTTP Server (Port 3001) ──────────────────────────────
  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // CORS
    if (method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Auth-Token, X-Agent-Id");
      res.writeHead(204);
      res.end();
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");

    // Health check
    if (url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Prometheus metrics
    if (url === "/metrics" && method === "GET") {
      if (!checkMetricsAuth(req, res, cachedMetricsToken)) return;
      (async () => {
        try {
          const { metricsRegistry } = await import("../shared/metrics.js");
          res.writeHead(200, { "Content-Type": metricsRegistry.contentType });
          res.end(await metricsRegistry.metrics());
        } catch (err) {
          console.error("[runtime] /metrics error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      })();
      return;
    }

    // Siclaw REST API routes
    if (restRouter.handle(req, res)) return;

    // Everything else → 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // ── WebSocket Server ─────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const urlPath = req.url?.split("?")[0];
    if (urlPath !== "/ws") {
      socket.destroy();
      return;
    }

    // Trusted Proxy authentication
    const proxy = authenticateProxy(req, config.runtimeSecret);
    if (!proxy) {
      console.warn(`[runtime] WS upgrade rejected: invalid proxy credentials`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any).proxy = proxy;
      wss.emit("connection", ws, proxy);
    });
  });

  // Keep-alive: ping every 30s
  const aliveClients = new WeakSet<WebSocket>();
  const pingTimer = setInterval(() => {
    for (const ws of clients) {
      if (!aliveClients.has(ws)) { ws.terminate(); continue; }
      aliveClients.delete(ws);
      ws.ping();
    }
  }, 30_000);
  wss.on("close", () => clearInterval(pingTimer));

  wss.on("connection", (ws: WebSocket, proxy: ProxyIdentity) => {
    clients.add(ws);
    aliveClients.add(ws);
    ws.on("pong", () => aliveClients.add(ws));
    console.log(`[runtime] WS connected agentId=${proxy.agentId} (total: ${clients.size})`);

    ws.on("message", async (data) => {
      const raw = String(data);
      const frame = parseFrame(raw);
      if (!frame) return;

      const context: RpcContext = {
        proxy,
        sendEvent: (event, payload) => {
          if (ws.readyState === ws.OPEN && ws.bufferedAmount <= MAX_BUFFERED_BYTES) {
            ws.send(buildEvent(event, payload));
          }
        },
        ws,
      };

      await dispatchRpc(rpcMethods, frame, ws, context);
    });

    ws.on("close", () => {
      clients.delete(ws);
      // Do NOT abort in-flight SSE consumers on WS close. A prompt is the
      // minimal unit of work: once submitted, let it run to completion so
      // the agent's full output — including empty-response retries and the
      // post-deep_search synthesis turn — is persisted to DB via
      // persistMessages. On reconnect the frontend fetches history and
      // sees messages produced after the disconnect. Explicit cancellation
      // still flows through chat.abort → agentbox abortSession.
      activeStreams.delete(ws);
      console.log(`[runtime] WS disconnected (total: ${clients.size})`);
    });

    ws.on("error", (err) => {
      console.error("[runtime] WS error:", err.message);
      clients.delete(ws);
    });
  });

  httpServer.keepAliveTimeout = 500;
  httpServer.listen(config.port, config.host, () => {
    console.log(`[runtime] HTTP listening on http://${config.host}:${config.port}`);
    console.log(`[runtime] WebSocket: ws://${config.host}:${config.port}/ws`);
  });

  // ── HTTPS Server (Port 3002 — mTLS for AgentBox) ────────
  const internalPort = config.internalPort;
  let httpsServer: https.Server | null = null;

  const mtlsMiddleware = createMtlsMiddleware({
    certManager,
    protectedPaths: ["/api/internal/"],
  });

  try {
    httpsServer = https.createServer(
      {
        cert: serverCert.cert,
        key: serverCert.key,
        ca: certManager.getCACertificate(),
        requestCert: true,
        rejectUnauthorized: true,
      },
      (req, res) => {
        const url = req.url ?? "/";
        const method = req.method ?? "GET";

        mtlsMiddleware(req, res, () => {
          const identity = (req as any).certIdentity as CertificateIdentity | undefined;

          // Credential request — resolve via CredentialService (local DB or external)
          if (url === "/api/internal/credential-request" && method === "POST") {
            if (!identity) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Client certificate required" }));
              return;
            }
            void handleCredentialRequest(req, res, identity, credentialService);
            return;
          }

          // Credential list — metadata for all clusters bound to this agent
          if (url === "/api/internal/credential-list" && method === "POST") {
            if (!identity) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Client certificate required" }));
              return;
            }
            void handleCredentialList(req, res, identity, credentialService);
            return;
          }

          // Settings (model providers + entries) — via RPC
          if (url === "/api/internal/settings" && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleSettings(req, res, identity, frontendClient);
            return;
          }

          // MCP servers — filtered by agent binding (via RPC)
          if (url === "/api/internal/mcp-servers" && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleMcpServers(req, res, identity, frontendClient);
            return;
          }

          // Skills bundle — filtered by agent binding (via RPC)
          if (url === "/api/internal/skills/bundle" && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleSkillsBundle(req, res, identity, frontendClient);
            return;
          }

          // Knowledge bundle — filtered by agent binding (via RPC)
          if (url === "/api/internal/knowledge/bundle" && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleKnowledgeBundle(req, res, identity, frontendClient);
            return;
          }

          // Agent tasks — CRUD scoped by mTLS identity.agentId (via RPC)
          if (url.startsWith("/api/internal/agent-tasks")) {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            const pathOnly = url.split("?")[0];
            const idMatch = pathOnly.match(/^\/api\/internal\/agent-tasks\/([^/]+)$/);
            if (pathOnly === "/api/internal/agent-tasks" && method === "GET") {
              handleAgentTasksList(req, res, identity, frontendClient);
              return;
            }
            if (pathOnly === "/api/internal/agent-tasks" && method === "POST") {
              handleAgentTasksCreate(req, res, identity, frontendClient);
              return;
            }
            if (idMatch && method === "PUT") {
              handleAgentTasksUpdate(req, res, identity, idMatch[1], frontendClient);
              return;
            }
            if (idMatch && method === "DELETE") {
              handleAgentTasksDelete(req, res, identity, idMatch[1], frontendClient);
              return;
            }
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          // Feedback endpoint
          if (url === "/api/internal/feedback" && method === "POST") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          // Default 404
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        });
      },
    );

    httpsServer.listen(internalPort, config.host, () => {
      console.log(`[runtime] Internal mTLS API on https://${config.host}:${internalPort}`);
    });
  } catch (err) {
    console.error("[runtime] Failed to start HTTPS server:", err);
  }

  // ── Server handle ────────────────────────────────────────
  const runtimeServer: RuntimeServer = {
    httpServer,
    httpsServer,
    certManager,
    broadcast,
    rpcMethods,
    agentBoxTlsOptions,
    credentialService,
    async close() {
      metricsAggregator.destroy();
      frontendClient.close();
      await agentBoxManager.cleanup();
      for (const ws of clients) ws.close();
      clients.clear();
      wss.close();
      httpServer.close();
      httpsServer?.close();
    },
  };

  return runtimeServer;
}

