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
import { ErrorCodes, wrapError } from "../lib/error-envelope.js";
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

  // ── Session Registry resolver ────────────────────────────
  // Cache misses (e.g. async AgentBox callbacks arriving after a Runtime
  // restart, before the next chat.send refills the LRU) fall back to Portal,
  // where chat_sessions.user_id is the source of truth.
  //
  // Wrapped in a 5s timeout so a slow / unresponsive Portal can't stall every
  // internal-api callback for the full FrontendWsClient default (30s). On
  // timeout we degrade to "" userId, which matches the pre-fallback behaviour.
  const RESOLVE_SESSION_TIMEOUT_MS = 5000;
  sessionRegistry.setResolver(async (sessionId) => {
    try {
      const rpc = frontendClient.request("chat.resolveSession", { session_id: sessionId });
      const data = await Promise.race([
        rpc,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`chat.resolveSession timed out after ${RESOLVE_SESSION_TIMEOUT_MS}ms`)), RESOLVE_SESSION_TIMEOUT_MS),
        ),
      ]) as
        | { found: false }
        | { found: true; user_id: string; agent_id: string };
      if (!data.found) return null;
      return { userId: data.user_id, agentId: data.agent_id };
    } catch (err) {
      console.error("[session-registry] resolveSession RPC failed:", err);
      return null;
    }
  });

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

    if (!agentId || !userId || !text) {
      throw new Error("agentId, userId, and text are required");
    }

    // Pre-generate a UUID so AgentBox doesn't fall back to the literal
    // "default" session id (LocalSpawner behaviour), which would merge
    // every caller's trace into one chat_sessions row.
    const sessionId = incomingSessionId ?? crypto.randomUUID();
    sessionRegistry.remember(sessionId, userId, agentId);

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

    // Async-ack protocol: return { ok, sessionId } within milliseconds; do
    // every slow step (agentbox spawn, prompt() roundtrip, SSE consume) in
    // the background and stream events back to Portal via the chat.event
    // WS channel.
    //
    // Why: sicore's WS RPC carries a fixed 30s timeout. Coupling the ack
    // to "agentbox is ready and prompt() returned" forced that timeout to
    // cover worst-case cold-start (image pull, container start, ready
    // probe), which routinely exceeds 30s and produced spurious
    // CONNECTION_TIMEOUT bubbles even when the runtime was healthy. Once
    // the bubble fires, sicore tears down the SSE response and the
    // delayed reply (which still arrives later) is dropped — leaving a
    // ghost session in DB and a confused user.
    //
    // After the ack, the existing chat.event stream (agent_start /
    // agent_end / agent_message / stream_error / prompt_done) carries
    // every observable progress signal the frontend needs.
    (async () => {
      try {
        // Persist user message + ensure session row before any agent events
        // could land. consumeAgentSse writes assistant/tool rows with FK
        // referencing chat_sessions, so the row has to exist first.
        await ensureChatSession(sessionId, agentId, userId, text);
        await appendMessage({ sessionId, role: "user", content: text });
        await incrementMessageCount(sessionId);

        const handle = await agentBoxManager.getOrCreate(agentId);
        const client = new AgentBoxClient(handle.endpoint, 30000, agentBoxTlsOptions);

        let promptResult: Awaited<ReturnType<typeof client.prompt>>;
        try {
          promptResult = await client.prompt(promptOpts);
        } catch (err) {
          // Concurrent send: agentbox returns 409 "Session is already
          // running. Use the steer endpoint to add input to the active
          // prompt." when the user double-taps send before the previous
          // prompt's pi-agent retries settle. Per agentbox's own hint,
          // inject as steer — the message rides on the still-running
          // prompt's stream. Don't emit prompt_done here: the running
          // prompt will fire its own when it actually finishes, and an
          // extra one would close the frontend stream prematurely.
          if (err instanceof Error && err.message.includes("Session is already running")) {
            await client.steerSession(sessionId, text);
            return;
          }
          throw err;
        }

        const redactionConfig = buildRedactionConfigForModelConfig(modelConfig);
        const abortCtrl = new AbortController();

        try {
          await consumeAgentSse({
            client,
            sessionId: promptResult.sessionId,
            userId,
            persistMessages: true,
            redactionConfig,
            signal: abortCtrl.signal,
            onEvent: (evt, _eventType, extras) => {
              context.sendEvent("chat.event", {
                sessionId: promptResult.sessionId,
                event: extras.dbMessageId ? { ...evt, dbMessageId: extras.dbMessageId } : evt,
              });
            },
          });
          context.sendEvent("chat.event", { sessionId: promptResult.sessionId, event: { type: "prompt_done" } });
        } catch (err) {
          if (!abortCtrl.signal.aborted) {
            console.error(`[runtime] SSE stream error for session=${promptResult.sessionId}:`, err);
            const detail = wrapError(err, {
              code: ErrorCodes.STREAM_INTERRUPTED,
              retriable: true,
            });
            context.sendEvent("chat.event", {
              sessionId: promptResult.sessionId,
              event: { type: "stream_error", error: detail },
            });
          }
          context.sendEvent("chat.event", { sessionId: promptResult.sessionId, event: { type: "prompt_done" } });
        }
      } catch (err) {
        // Failure before/during agentbox spawn or prompt() — surface as a
        // stream_error so the frontend renders an inline bubble instead of
        // hanging on the spawning state forever.
        console.error(`[runtime] chat.send background failure for session=${sessionId}:`, err);
        const detail = wrapError(err, {
          code: ErrorCodes.INTERNAL,
          retriable: true,
        });
        context.sendEvent("chat.event", {
          sessionId,
          event: { type: "stream_error", error: detail },
        });
        context.sendEvent("chat.event", { sessionId, event: { type: "prompt_done" } });
      }
    })();

    return { ok: true, sessionId };
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
