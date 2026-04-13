/**
 * Siclaw Agent Runtime — Agent service with shared MySQL.
 *
 * Port 3001 (HTTP):
 *   GET  /api/health              — K8s liveness/readiness
 *   GET  /metrics                 — Prometheus
 *   WS   /ws                      — Upstream WS RPC (Trusted Proxy auth)
 *   /api/v1/siclaw/*              — REST API (JWT auth, skills/mcp/chat/cron/etc.)
 *
 * Port 3002 (HTTPS mTLS):
 *   POST /api/internal/credential-request  — proxy to Upstream Adapter
 *   GET  /api/internal/settings            — model providers (from DB)
 *   GET  /api/internal/mcp-servers         — MCP config (from DB + Upstream binding)
 *   GET  /api/internal/skills/bundle       — skill bundle (from DB + Upstream binding)
 *   GET  /api/internal/cron-list           — cron jobs (from DB)
 *   POST /api/internal/feedback            — AgentBox feedback
 */

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
import { handleCredentialRequest } from "./credential-proxy.js";
import { CertificateManager, type CertificateIdentity } from "./security/cert-manager.js";
import { createMtlsMiddleware } from "./security/mtls-middleware.js";
import type { BoxSpawner } from "./agentbox/spawner.js";
import { checkMetricsAuth } from "../shared/metrics.js";
import { handleSettings, handleMcpServers, handleSkillsBundle, handleCronList } from "./internal-api.js";
import { createRestRouter } from "./rest-router.js";
import { registerSiclawRoutes } from "./siclaw-api.js";

export interface RuntimeServer {
  httpServer: http.Server;
  httpsServer: https.Server | null;
  certManager: CertificateManager;
  broadcast: BroadcastFn;
  rpcMethods: Map<string, RpcHandler>;
  agentBoxTlsOptions?: { cert: string; key: string; ca: string };
  close(): Promise<void>;
}

export interface StartRuntimeOptions {
  config: RuntimeConfig;
  agentBoxManager: AgentBoxManager;
  spawner?: BoxSpawner;
}

export async function startRuntime(opts: StartRuntimeOptions): Promise<RuntimeServer> {
  const { config, agentBoxManager } = opts;

  const clients = new Set<WebSocket>();
  const broadcast = createBroadcaster(clients);

  // ── Certificate Manager ──────────────────────────────────
  const certManager = await CertificateManager.create();
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
    const sessionId = params.sessionId as string | undefined;

    if (!agentId || !userId || !text) {
      throw new Error("agentId, userId, and text are required");
    }

    // Get or create AgentBox for this user+agent
    const handle = await agentBoxManager.getOrCreate(userId, agentId);
    const client = new AgentBoxClient(handle.endpoint, 30000, agentBoxTlsOptions);

    // Build prompt options from params (Upstream sends full context)
    const promptOpts: PromptOptions = {
      sessionId,
      text,
      agentId,
      modelProvider: params.modelProvider as string | undefined,
      modelId: params.modelId as string | undefined,
      brainType: params.brainType as string | undefined,
      systemPromptTemplate: params.systemPrompt as string | undefined,
      mode: params.mode as string | undefined,
      modelConfig: params.modelConfig as PromptOptions["modelConfig"],
    };

    const promptResult = await client.prompt(promptOpts);

    // Stream SSE events back to Upstream via WS events
    if (context.ws) {
      const abortCtrl = new AbortController();
      activeStreams.set(context.ws, abortCtrl);

      // Non-blocking: stream events in background
      (async () => {
        try {
          for await (const event of client.streamEvents(promptResult.sessionId)) {
            if (abortCtrl.signal.aborted) break;
            if (context.ws && context.ws.readyState === WebSocket.OPEN) {
              if (context.ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
              context.ws.send(buildEvent("chat.event", { sessionId: promptResult.sessionId, event }));
            }
          }
        } catch (err) {
          if (!abortCtrl.signal.aborted) {
            console.error(`[runtime] SSE stream error for session=${promptResult.sessionId}:`, err);
          }
        } finally {
          activeStreams.delete(context.ws!);
        }
      })();
    }

    return { ok: true, sessionId: promptResult.sessionId };
  });

  rpcMethods.set("chat.abort", async (params) => {
    const userId = params.userId as string;
    const agentId = params.agentId as string;
    const sessionId = params.sessionId as string;
    if (!userId || !agentId || !sessionId) throw new Error("userId, agentId, sessionId required");

    const handle = await agentBoxManager.getOrCreate(userId, agentId);
    const client = new AgentBoxClient(handle.endpoint, 10000, agentBoxTlsOptions);
    await client.abortSession(sessionId);
    return { ok: true };
  });

  rpcMethods.set("chat.steer", async (params) => {
    const userId = params.userId as string;
    const agentId = params.agentId as string;
    const sessionId = params.sessionId as string;
    const text = params.text as string;
    if (!userId || !agentId || !sessionId || !text) throw new Error("userId, agentId, sessionId, text required");

    const handle = await agentBoxManager.getOrCreate(userId, agentId);
    const client = new AgentBoxClient(handle.endpoint, 10000, agentBoxTlsOptions);
    await client.steerSession(sessionId, text);
    return { ok: true };
  });

  // ── REST API Router (Siclaw CRUD) ────────────────────────
  const restRouter = createRestRouter();
  registerSiclawRoutes(restRouter, config);

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
      const ctrl = activeStreams.get(ws);
      if (ctrl) { ctrl.abort(); activeStreams.delete(ws); }
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

          // Credential request proxy → Upstream Adapter
          if (url === "/api/internal/credential-request" && method === "POST") {
            if (!identity) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Client certificate required" }));
              return;
            }
            handleCredentialRequest(req, res, identity, config);
            return;
          }

          // Settings (model providers + entries) — from Runtime DB
          if (url === "/api/internal/settings" && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleSettings(req, res, identity);
            return;
          }

          // MCP servers — from Runtime DB, filtered by agent binding (via Upstream Adapter)
          if (url === "/api/internal/mcp-servers" && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleMcpServers(req, res, identity, config);
            return;
          }

          // Skills bundle — from Runtime DB, filtered by agent binding (via Upstream Adapter)
          if (url === "/api/internal/skills/bundle" && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleSkillsBundle(req, res, identity, config);
            return;
          }

          // Cron job list — from Runtime DB, filtered by agent
          if ((url.startsWith("/api/internal/cron-list")) && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleCronList(req, res, identity);
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
    async close() {
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
