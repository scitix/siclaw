/**
 * Siclaw Agent Runtime — stateless execution engine (DB-free).
 *
 * All data access goes through Portal/Upstream adapter API.
 *
 * Port 3001 (HTTP):
 *   GET  /api/health              — K8s liveness/readiness
 *   GET  /metrics                 — Prometheus
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
import type { RuntimeConfig } from "./config.js";
import type { AgentBoxManager } from "./agentbox/manager.js";
import { AgentBoxClient, type PromptOptions } from "./agentbox/client.js";
import {
  type RpcHandler,
  type RpcContext,
} from "./ws-protocol.js";
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
  handleDelegationEvents,
} from "./internal-api.js";
// siclaw-api.ts routes moved to Portal — Runtime no longer registers CRUD routes.
import { appendMessage, incrementMessageCount, ensureChatSession } from "./chat-repo.js";
import { consumeAgentSse } from "./sse-consumer.js";
import { buildRedactionConfigForModelConfig } from "./output-redactor.js";
import { MetricsAggregator } from "./metrics-aggregator.js";
import { LocalSpawner } from "./agentbox/local-spawner.js";
import { sessionRegistry } from "./session-registry.js";

export interface RuntimeServer {
  httpServer: http.Server;
  httpsServer: https.Server | null;
  certManager: CertificateManager;
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

  rpcMethods.set("chat.send", async (params, context: RpcContext) => {
    const agentId = params.agentId as string;
    const userId = params.userId as string;
    const orgId = params.orgId as string | undefined;
    const text = params.text as string;
    const incomingSessionId = params.sessionId as string | undefined;
    // Portal stamps turnStartMs at POST receipt — closer to user click than
    // the runtime's loop start. Use it as the canonical turn anchor when
    // present; fall back gracefully so direct callers (tests, /run path)
    // still work without it.
    const turnStartMs = typeof params.turnStartMs === "number" ? params.turnStartMs : undefined;

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

    // Stream + persist events back to Portal via sendEvent (FrontendWsClient).
    {
      const abortCtrl = new AbortController();

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
            turnStartTime: turnStartMs,
            onEvent: (evt, _eventType, extras) => {
              context.sendEvent("chat.event", {
                sessionId: promptResult.sessionId,
                event: extras.dbMessageId ? { ...evt, dbMessageId: extras.dbMessageId } : evt,
              });
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
    // Only "running" boxes are reachable — Pending/Terminating/Succeeded/Failed
    // pods either have no podIP yet or a stale one, and RPCs to them would
    // ETIMEDOUT and slow the whole fan-out. See bug report
    // "siclaw-agent-reload-stale-pods-and-serial-blocking".
    const targets = boxes.filter((b) => b.agentId === agentId && b.status === "running");

    if (targets.length === 0) {
      console.log(`[rpc] agent.reload: no active boxes for agent=${agentId}, skipping`);
      return { ok: true, reloaded: [], skipped: resourceTypes, boxes: 0 };
    }

    // Fan out across boxes AND resource types concurrently so one slow box
    // (network hiccup, etc.) cannot serially block the reload on others.
    const reloadedSet = new Set<string>();
    const failedSet = new Set<string>();

    await Promise.all(
      targets.map(async (box) => {
        const client = new AgentBoxClient(box.endpoint, 15_000, agentBoxTlsOptions);
        await Promise.all(
          resourceTypes.map(async (rt) => {
            try {
              await client.reloadResource(rt as import("../shared/gateway-sync.js").GatewaySyncType);
              reloadedSet.add(rt);
            } catch (err: any) {
              console.warn(`[rpc] agent.reload: ${rt} failed for box=${box.boxId}: ${err.message}`);
              failedSet.add(rt);
            }
          }),
        );
      }),
    );

    const reloaded = Array.from(reloadedSet);
    const failed = Array.from(failedSet);
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

    // Everything else → 404
    // Siclaw CRUD routes live in Portal; Runtime only exposes health, WS,
    // and internal mTLS endpoints above.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // Runtime no longer accepts inbound WS connections — Portal/SiCore drive
  // RPCs over the phone-home WS owned by FrontendWsClient. The HTTP server
  // here serves only /api/health and the internal mTLS endpoints.
  httpServer.keepAliveTimeout = 500;
  httpServer.listen(config.port, config.host, () => {
    console.log(`[runtime] HTTP listening on http://${config.host}:${config.port}`);
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

          // Background delegation persistence/audit callback from AgentBox.
          if (url === "/api/internal/delegation-events" && method === "POST") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleDelegationEvents(req, res, identity, frontendClient);
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
    rpcMethods,
    agentBoxTlsOptions,
    credentialService,
    async close() {
      metricsAggregator.destroy();
      frontendClient.close();
      await agentBoxManager.cleanup();
      httpServer.close();
      httpsServer?.close();
    },
  };

  return runtimeServer;
}
