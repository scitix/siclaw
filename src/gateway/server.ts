import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { GatewayConfig } from "./config.js";
import type { AgentBoxManager } from "./agentbox/manager.js";
import { AgentBoxClient } from "./agentbox/client.js";
import { createBroadcaster, buildEvent, parseFrame, dispatchRpc, MAX_BUFFERED_BYTES, type RpcHandler, type RpcContext } from "./ws-protocol.js";
import { createRpcMethods } from "./rpc-methods.js";
import { UserStore, createLoginHandler, createAuthMiddleware, BindCodeStore, signJwt, type AuthContext } from "./auth/index.js";
import { loadOAuth2Config, generateState, consumeState, buildAuthorizeUrl, exchangeCode, fetchUserInfo } from "./auth/oauth2.js";
import { createDb, closeDb, type Database } from "./db/index.js";
import { initSchema } from "./db/init-schema.js";
import { ConfigRepository } from "./db/repositories/config-repo.js";
import { NotificationRepository } from "./db/repositories/notification-repo.js";
import { PermissionRepository } from "./db/repositories/permission-repo.js";
import { UserRepository } from "./db/repositories/user-repo.js";
import { ModelConfigRepository } from "./db/repositories/model-config-repo.js";
import { SystemConfigRepository } from "./db/repositories/system-config-repo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Static files: web React build
// Production: dist/gateway/web/dist/  Dev: src/gateway/web/dist/
const WEB_DIR = fs.existsSync(path.join(__dirname, "web", "dist", "index.html"))
  ? path.join(__dirname, "web", "dist")
  : path.join(__dirname, "..", "..", "src", "gateway", "web", "dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  const withoutQuery = urlPath.split("?")[0];
  const safePath = path.normalize(withoutQuery).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = path.join(WEB_DIR, safePath === "/" ? "index.html" : safePath);

  // Prevent path traversal
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  // SPA fallback: if file not found and no extension, serve index.html
  if (!fs.existsSync(filePath)) {
    const ext = path.extname(filePath);
    if (!ext) {
      // Client-side route, serve index.html
      filePath = path.join(WEB_DIR, "index.html");
    }
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}

export interface GatewayServer {
  httpServer: http.Server;
  broadcast: import("./ws-protocol.js").BroadcastFn;
  userStore: UserStore;
  bindCodeStore: BindCodeStore;
  db: Database | null;
  /** Live RPC method map — add methods after startup */
  rpcMethods: Map<string, RpcHandler>;
  /** Callback for webhook dispatch — set by gateway-main.ts */
  onWebhook?: (trigger: any, payload: unknown) => void;
  /** Callback for cron job completion notifications — set by gateway-main.ts */
  onCronNotify?: (data: { userId: string; jobName: string; result: string; resultText: string; error?: string }) => void;
  /** Build credential payload for a specific workspace (sent in prompt body) */
  buildCredentialPayload: (userId: string, workspaceId: string, isDefault: boolean) => Promise<{ manifest: Array<{ name: string; type: string; description?: string | null; files: string[]; metadata?: Record<string, unknown> }>; files: Array<{ name: string; content: string; mode?: number }> }>;
  close(): Promise<void>;
}

/** Extended WebSocket with auth context */
interface AuthenticatedWebSocket extends WebSocket {
  auth?: AuthContext;
}

export interface StartGatewayOptions {
  config: GatewayConfig;
  agentBoxManager: AgentBoxManager;
  extraRpcMethods?: Map<string, RpcHandler>;
  extraHttpHandlers?: Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>;
}

export async function startGateway(opts: StartGatewayOptions): Promise<GatewayServer> {
  const { config, agentBoxManager, extraRpcMethods, extraHttpHandlers } = opts;

  // Track users with active internal API calls (cron, triggers) to prevent WS teardown from killing their pods
  const activeInternalUsers = new Set<string>();

  // Track users with active SSE prompt streams (web UI) to prevent WS teardown from killing mid-execution pods
  const activePromptUsers = new Set<string>();

  const clients = new Set<WebSocket>();
  const broadcast = createBroadcaster(clients);

  // Per-user WS connections (used for targeted pushes like notifications)
  const userConnections = new Map<string, Set<WebSocket>>();

  /** Send an event to a specific user (all their WS connections) */
  const sendToUser = (userId: string, event: string, payload: Record<string, unknown>) => {
    const conns = userConnections.get(userId);
    if (!conns) return;
    const frame = buildEvent(event, payload);
    for (const ws of conns) {
      if (ws.readyState === ws.OPEN) {
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          console.warn(`[ws] Backpressure: skipping sendToUser for userId=${userId} (buffered=${ws.bufferedAmount})`);
          continue;
        }
        ws.send(frame);
      }
    }
  };

  // Initialize database (defaults to SQLite if SICLAW_DATABASE_URL is not set)
  const db = await createDb();
  await initSchema(db);
  console.log("[gateway] Database initialized");

  // Config repo for webhook route
  const configRepo = db ? new ConfigRepository(db) : null;

  // Inject LLM/Embedding provider config from DB into new AgentBox pods
  if (db) {
    const modelConfigRepo = new ModelConfigRepository(db);
    agentBoxManager.setEnvResolver(async () => {
      const env: Record<string, string> = {};

      const llm = await modelConfigRepo.getResolvedDefaultConfig();
      if (llm) {
        if (llm.baseUrl) env.SICLAW_LLM_BASE_URL = llm.baseUrl;
        if (llm.apiKey) env.SICLAW_LLM_API_KEY = resolveApiKey(llm.apiKey);
        if (llm.model) env.SICLAW_LLM_MODEL = llm.model;
      }

      const emb = await modelConfigRepo.getResolvedEmbeddingConfig();
      if (emb) {
        if (emb.baseUrl) env.SICLAW_EMBEDDING_BASE_URL = emb.baseUrl;
        if (emb.apiKey) env.SICLAW_EMBEDDING_API_KEY = resolveApiKey(emb.apiKey);
        if (emb.model) env.SICLAW_EMBEDDING_MODEL = emb.model;
        if (emb.dimensions) env.SICLAW_EMBEDDING_DIMENSIONS = String(emb.dimensions);
      }

      return env;
    });
  }

  // Create RPC methods using AgentBoxManager
  const { methods: rpcMethods, buildCredentialPayload } = createRpcMethods(agentBoxManager, broadcast, db, sendToUser, activePromptUsers);

  // System config repo (used by JWT, SSO, S3, etc.)
  const sysConfigRepo = db ? new SystemConfigRepository(db) : null;

  // Apply DB-stored agentbox image override (takes effect on next pod spawn)
  if (sysConfigRepo) {
    const img = await sysConfigRepo.get("system.agentboxImage");
    if (img) agentBoxManager.setSpawnerImage(img);
  }

  // Auth setup — auto-generate JWT secret on first run if not provided
  const jwtSecret = await resolveJwtSecret(sysConfigRepo);
  const userStore = new UserStore(db);
  await userStore.init();
  const bindCodeStore = new BindCodeStore();
  const { handleLogin } = createLoginHandler(userStore, jwtSecret);
  const authMiddleware = createAuthMiddleware(jwtSecret);

  // OAuth2 / SSO config — DB values take priority over env vars
  let ssoDbConfig: Record<string, string> | undefined;
  if (sysConfigRepo) {
    try { ssoDbConfig = await sysConfigRepo.getAll("sso."); } catch { /* ignore */ }
  }
  const oauth2Config = loadOAuth2Config(ssoDbConfig);
  if (oauth2Config) {
    console.log(`[gateway] SSO enabled: issuer=${oauth2Config.issuer} clientId=${oauth2Config.clientId}`);
  }

  // Binding RPC methods
  rpcMethods.set("binding.list", async (_params, ctx) => {
    if (!ctx?.auth?.userId) throw new Error("Unauthorized");
    const user = userStore.getById(ctx.auth.userId);
    return { bindings: user?.bindings ?? {} };
  });

  rpcMethods.set("binding.generate", async (_params, ctx) => {
    if (!ctx?.auth?.userId) throw new Error("Unauthorized");
    const code = bindCodeStore.generateCode(ctx.auth.userId);
    return { code, expiresIn: 300 };
  });

  rpcMethods.set("binding.remove", async (params, ctx) => {
    if (!ctx?.auth?.userId) throw new Error("Unauthorized");
    const { channel } = params as { channel: "feishu" | "dingtalk" | "discord" };
    if (!channel) throw new Error("channel is required");
    userStore.removeBinding(ctx.auth.userId, channel);
    return { ok: true };
  });

  // Permission management RPCs (admin only)
  const permRepo = db ? new PermissionRepository(db) : null;
  const permUserRepo = db ? new UserRepository(db) : null;

  rpcMethods.set("permission.listUsers", async (_params, ctx) => {
    if (!ctx?.auth?.userId) throw new Error("Unauthorized");
    if (ctx.auth.username !== "admin") throw new Error("Forbidden: admin access required");
    if (!permUserRepo) throw new Error("Database not available");

    const allUsers = await permUserRepo.list();
    const result: Array<{
      id: string; username: string; name: string | null;
      permissions: string[]; isAdmin: boolean;
      testOnly: boolean; ssoUser: boolean;
    }> = [];

    for (const u of allUsers) {
      const profile = await permUserRepo.getProfile(u.id);
      const perms = permRepo ? await permRepo.listForUser(u.id) : [];
      result.push({
        id: u.id,
        username: u.username,
        name: profile?.name ?? null,
        permissions: perms.map(p => p.permission),
        isAdmin: u.username === "admin",
        testOnly: (u as any).testOnly ?? false,
        ssoUser: (u as any).ssoUser ?? false,
      });
    }
    return { users: result };
  });

  rpcMethods.set("permission.grant", async (params, ctx) => {
    if (!ctx?.auth?.userId) throw new Error("Unauthorized");
    if (ctx.auth.username !== "admin") throw new Error("Forbidden: admin access required");
    if (!permRepo) throw new Error("Database not available");

    const userId = params.userId as string;
    const permission = params.permission as string;
    if (!userId || !permission) throw new Error("Missing required params: userId, permission");

    await permRepo.grant(userId, permission, ctx.auth.userId);
    return { status: "granted" };
  });

  rpcMethods.set("permission.revoke", async (params, ctx) => {
    if (!ctx?.auth?.userId) throw new Error("Unauthorized");
    if (ctx.auth.username !== "admin") throw new Error("Forbidden: admin access required");
    if (!permRepo) throw new Error("Database not available");

    const userId = params.userId as string;
    const permission = params.permission as string;
    if (!userId || !permission) throw new Error("Missing required params: userId, permission");

    await permRepo.revoke(userId, permission);
    return { status: "revoked" };
  });

  // ─── User management RPCs ────────────────────────

  rpcMethods.set("user.create", async (params, ctx) => {
    if (!ctx?.auth?.userId) throw new Error("Unauthorized");
    if (ctx.auth.username !== "admin") throw new Error("Forbidden: admin access required");

    const { username, password, testOnly } = params as {
      username: string; password: string; testOnly?: boolean;
    };
    if (!username || !password) throw new Error("Missing required params: username, password");

    const user = await userStore.createAsync({ username, password, testOnly: testOnly ?? false });
    return { id: user.id, username: user.username, testOnly: user.testOnly };
  });

  rpcMethods.set("user.setTestOnly", async (params, ctx) => {
    if (!ctx?.auth?.userId) throw new Error("Unauthorized");
    if (ctx.auth.username !== "admin") throw new Error("Forbidden: admin access required");

    const { userId, testOnly } = params as { userId: string; testOnly: boolean };
    if (!userId || testOnly === undefined) throw new Error("Missing required params: userId, testOnly");

    await userStore.setTestOnly(userId, testOnly);
    return { ok: true };
  });

  rpcMethods.set("user.resetPassword", async (params, ctx) => {
    if (!ctx?.auth?.userId) throw new Error("Unauthorized");
    if (ctx.auth.username !== "admin") throw new Error("Forbidden: admin access required");

    const { userId, password } = params as { userId: string; password: string };
    if (!userId || !password) throw new Error("Missing required params: userId, password");

    await userStore.resetPassword(userId, password);
    return { ok: true };
  });

  rpcMethods.set("user.changePassword", async (params, ctx) => {
    if (!ctx?.auth?.userId) throw new Error("Unauthorized");

    const user = userStore.getById(ctx.auth.userId);
    if (!user) throw new Error("User not found");
    if (user.ssoUser) throw new Error("SSO users cannot change password");

    const { oldPassword, newPassword } = params as { oldPassword: string; newPassword: string };
    if (!oldPassword || !newPassword) throw new Error("Missing required params: oldPassword, newPassword");

    await userStore.changePassword(ctx.auth.userId, oldPassword, newPassword);
    return { ok: true };
  });

  // Merge extra RPC methods (e.g. from plugins)
  if (extraRpcMethods) {
    for (const [name, handler] of extraRpcMethods) {
      rpcMethods.set(name, handler);
    }
  }

  // CORS headers helper
  const setCorsHeaders = (res: http.ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  };

  // HTTP server
  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // Log all non-health HTTP requests for debugging
    if (url !== "/api/health") {
      console.log(`[gateway] HTTP ${method} ${url}`);
    }

    // CORS preflight
    if (method === "OPTIONS") {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    setCorsHeaders(res);

    // API health check
    if (url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Login API
    if (url === "/api/login") {
      handleLogin(req, res);
      return;
    }

    // User info API (requires auth)
    if (url === "/api/me") {
      const auth = authMiddleware.authenticateRequest(req);
      if (!auth) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ userId: auth.userId, username: auth.username }));
      return;
    }

    // SSO config check (frontend uses this to decide whether to show SSO button)
    if (url === "/api/sso/config") {
      (async () => {
        let enabled = false;
        if (oauth2Config && sysConfigRepo) {
          try {
            const val = await sysConfigRepo.get("sso.enabled");
            enabled = val === "true";
          } catch { /* ignore */ }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ enabled }));
      })();
      return;
    }

    // SSO: redirect to IdP authorize URL
    if (url === "/auth/sso" && method === "GET") {
      if (!oauth2Config) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "SSO not configured" }));
        return;
      }
      (async () => {
        // Check explicit SSO toggle
        if (sysConfigRepo) {
          try {
            const val = await sysConfigRepo.get("sso.enabled");
            if (val !== "true") {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "SSO is disabled" }));
              return;
            }
          } catch { /* ignore — allow if DB read fails */ }
        }
        const state = generateState();
        const authorizeUrl = buildAuthorizeUrl(oauth2Config, state);
        console.log(`[gateway] SSO redirect → ${authorizeUrl}`);
        res.writeHead(302, { Location: authorizeUrl });
        res.end();
      })();
      return;
    }

    // SSO: callback from IdP
    if (url.startsWith("/auth/callback") && method === "GET") {
      if (!oauth2Config) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "SSO not configured" }));
        return;
      }

      const fullUrl = new URL(req.url!, `http://${req.headers.host}`);
      const code = fullUrl.searchParams.get("code");
      const state = fullUrl.searchParams.get("state");
      const idpError = fullUrl.searchParams.get("error");

      if (idpError) {
        const desc = fullUrl.searchParams.get("error_description") || idpError;
        console.error(`[gateway] SSO IdP error: ${desc}`);
        res.writeHead(302, { Location: `/login?error=${encodeURIComponent(desc)}` });
        res.end();
        return;
      }

      if (!code || !state) {
        res.writeHead(302, { Location: "/login?error=missing_code_or_state" });
        res.end();
        return;
      }

      // Validate CSRF state
      if (!consumeState(state)) {
        console.warn("[gateway] SSO invalid or expired state");
        res.writeHead(302, { Location: "/login?error=invalid_state" });
        res.end();
        return;
      }

      (async () => {
        try {
          // Exchange code for tokens
          const tokenResp = await exchangeCode(oauth2Config, code);
          console.log("[gateway] SSO token exchange OK");

          // Fetch user info
          const userInfo = await fetchUserInfo(oauth2Config, tokenResp.access_token);
          console.log(`[gateway] SSO userInfo: sub=${userInfo.sub} email=${userInfo.email} name=${userInfo.name}`);

          // Find or create local user
          const user = await userStore.findOrCreateBySso({
            sub: userInfo.sub,
            email: userInfo.email,
            name: userInfo.name,
            preferredUsername: userInfo.preferred_username,
          });

          // Issue our own JWT
          const token = signJwt({ userId: user.id, username: user.username }, jwtSecret);

          // Redirect to frontend callback page with token
          const params = new URLSearchParams({
            token,
            userId: user.id,
            username: user.username,
          });
          res.writeHead(302, { Location: `/login/sso-callback?${params.toString()}` });
          res.end();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[gateway] SSO callback error:", msg);
          res.writeHead(302, { Location: `/login?error=${encodeURIComponent("SSO login failed")}` });
          res.end();
        }
      })();
      return;
    }

    // Internal cron list endpoint: GET /api/internal/cron-list?userId=xxx
    if (url.startsWith("/api/internal/cron-list") && method === "GET") {
      if (!db) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Database not available" }));
        return;
      }
      (async () => {
        try {
          const fullUrl = new URL(req.url!, `http://${req.headers.host}`);
          const userId = fullUrl.searchParams.get("userId");
          if (!userId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "userId required" }));
            return;
          }
          const envId = fullUrl.searchParams.get("envId");
          const configRepo = new ConfigRepository(db);
          const jobs = await configRepo.listCronJobs(userId, envId ?? undefined);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jobs }));
        } catch (err) {
          console.error("[gateway] cron-list error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      })();
      return;
    }

    // ─── Internal cron coordination API (used by cron service) ────────
    // These thin wrappers let cron-main talk to the DB through gateway,
    // so cron never needs its own database connection.

    if (url.startsWith("/api/internal/cron/") && configRepo) {
      const cronPath = url.replace("/api/internal/cron/", "").split("?")[0];
      const fullUrl = new URL(req.url!, `http://${req.headers.host}`);

      // POST endpoints
      if (method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", async () => {
          try {
            const data = body ? JSON.parse(body) : {};

            if (cronPath === "register") {
              await configRepo.registerCronInstance(data.instanceId, data.endpoint);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "ok" }));
              return;
            }

            if (cronPath === "heartbeat") {
              await configRepo.updateHeartbeat(data.instanceId, data.jobCount);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "ok" }));
              return;
            }

            if (cronPath === "delete-instance") {
              await configRepo.deleteInstance(data.instanceId);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "ok" }));
              return;
            }

            if (cronPath === "release-jobs") {
              await configRepo.releaseInstanceJobs(data.instanceId);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "ok" }));
              return;
            }

            if (cronPath === "claim-job") {
              const claimed = await configRepo.claimUnassignedJob(data.jobId, data.instanceId);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ claimed }));
              return;
            }

            if (cronPath === "job-run") {
              await configRepo.updateCronJobRun(data.jobId, data.result);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "ok" }));
              return;
            }

            if (cronPath === "reassign-jobs") {
              await configRepo.reassignOrphanedJobs(data.fromInstanceId, data.toInstanceId);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "ok" }));
              return;
            }

            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown cron POST endpoint" }));
          } catch (err) {
            console.error(`[gateway] cron/${cronPath} error:`, err);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        });
        return;
      }

      // GET endpoints
      if (method === "GET") {
        (async () => {
          try {
            if (cronPath === "jobs") {
              const instanceId = fullUrl.searchParams.get("instanceId");
              const unassigned = fullUrl.searchParams.get("unassigned");

              if (instanceId) {
                const jobs = await configRepo.listCronJobsByInstance(instanceId);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ jobs }));
                return;
              }
              if (unassigned === "1") {
                const jobs = await configRepo.getUnassignedActiveJobs();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ jobs }));
                return;
              }
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "instanceId or unassigned=1 required" }));
              return;
            }

            // GET /api/internal/cron/jobs/:id
            if (cronPath.startsWith("jobs/")) {
              const jobId = cronPath.slice("jobs/".length);
              const job = await configRepo.getCronJobById(jobId);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ job }));
              return;
            }

            if (cronPath === "dead-instances") {
              const thresholdMs = parseInt(fullUrl.searchParams.get("thresholdMs") || "90000", 10);
              const instances = await configRepo.getDeadInstances(thresholdMs);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ instances }));
              return;
            }

            if (cronPath === "least-loaded") {
              const thresholdMs = parseInt(fullUrl.searchParams.get("thresholdMs") || "90000", 10);
              const instance = await configRepo.getLeastLoadedInstance(thresholdMs);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ instance }));
              return;
            }

            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown cron GET endpoint" }));
          } catch (err) {
            console.error(`[gateway] cron/${cronPath} error:`, err);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        })();
        return;
      }
    }

    // Internal cron notification endpoint: POST /api/internal/cron-notify
    if (url === "/api/internal/cron-notify" && method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body) as {
            userId: string; jobId: string; jobName: string;
            result: "success" | "failure"; resultText: string; error?: string;
          };

          // 1. Write notification to DB
          if (db) {
            const notifRepo = new NotificationRepository(db);
            const notifId = await notifRepo.create({
              userId: data.userId,
              type: "cron_result",
              title: data.jobName,
              message: data.result === "success" ? data.resultText : (data.error || "Unknown error"),
              relatedId: data.jobId,
            });

            // 2. Push via WebSocket
            sendToUser(data.userId, "notification", {
              id: notifId,
              type: "cron_result",
              title: data.jobName,
              message: data.result === "success" ? data.resultText : (data.error || "Unknown error"),
              result: data.result,
              relatedId: data.jobId,
            });
          }

          // 3. Delegate to channel push via callback
          if (gatewayServer.onCronNotify) {
            gatewayServer.onCronNotify(data);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
        } catch (err) {
          console.error("[gateway] cron-notify error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // Internal agent-prompt endpoint: POST /api/internal/agent-prompt
    // Synchronous execution — waits for agent to finish and returns result text.
    // Used by cron, triggers, and other internal callers.
    if (url === "/api/internal/agent-prompt" && method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        const startTime = Date.now();
        let userId = "";
        try {
          const data = JSON.parse(body) as {
            userId: string; sessionId: string; text: string;
            timeoutMs?: number; caller?: string; envId?: string;
          };
          userId = data.userId;
          const timeoutMs = data.timeoutMs || 300_000;
          const caller = data.caller || "unknown";

          if (!data.userId || !data.text) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "userId and text are required" }));
            return;
          }

          console.log(`[gateway] agent-prompt from=${caller} user=${userId} session=${data.sessionId}`);

          // Protect from WS teardown while internal call is active
          activeInternalUsers.add(userId);
          try {
            // 1. Get or create user's AgentBox (default workspace for internal API calls)
            const handle = await agentBoxManager.getOrCreate(userId, "default");
            const client = new AgentBoxClient(handle.endpoint);

            // 2. Send prompt
            const promptResult = await client.prompt({ sessionId: data.sessionId, text: data.text });

            // 3. Wait for completion with timeout
            const resultText = await Promise.race([
              waitForAgentCompletion(client, promptResult.sessionId),
              rejectAfterTimeout(timeoutMs, data.sessionId),
            ]);

            const durationMs = Date.now() - startTime;
            console.log(`[gateway] agent-prompt completed user=${userId} duration=${durationMs}ms resultLen=${resultText.length}`);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", resultText, durationMs }));
          } finally {
            activeInternalUsers.delete(userId);
          }
        } catch (err) {
          const durationMs = Date.now() - startTime;
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[gateway] agent-prompt failed user=${userId} duration=${durationMs}ms:`, errMsg);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", error: errMsg, durationMs }));
        }
      });
      return;
    }

    // Internal settings endpoint: GET /api/internal/settings
    // Returns provider/model/embedding config for AgentBox pods to bootstrap settings.json
    if (url === "/api/internal/settings" && method === "GET") {
      if (!db) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Database not available" }));
        return;
      }
      (async () => {
        try {
          const modelConfigRepo = new ModelConfigRepository(db);
          const settings = await modelConfigRepo.exportSettingsConfig();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(settings));
        } catch (err) {
          console.error("[gateway] settings export error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      })();
      return;
    }

    // Internal embedding config endpoint: GET /api/internal/embedding-config
    if (url === "/api/internal/embedding-config" && method === "GET") {
      if (!db) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Database not available" }));
        return;
      }
      (async () => {
        try {
          const modelConfigRepo = new ModelConfigRepository(db);
          const config = await modelConfigRepo.getResolvedEmbeddingConfig();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ config }));
        } catch (err) {
          console.error("[gateway] embedding-config error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      })();
      return;
    }

    // Internal notification purge endpoint: POST /api/internal/notifications/purge
    if (url === "/api/internal/notifications/purge" && method === "POST") {
      if (!db) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Database not available" }));
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { retentionDays = 30 } = body ? JSON.parse(body) : {};
          const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
          const notifRepo = new NotificationRepository(db);
          const deleted = await notifRepo.purgeOlderThan(cutoff);
          console.log(`[gateway] Purged ${deleted} notifications older than ${cutoff.toISOString()}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", deleted, cutoff: cutoff.toISOString() }));
        } catch (err) {
          console.error("[gateway] notifications/purge error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // Webhook endpoint: POST /hooks/v1/:triggerId
    if (url.startsWith("/hooks/v1/") && method === "POST") {
      const triggerId = url.split("/hooks/v1/")[1]?.split("?")[0];
      if (!triggerId || !configRepo) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      // Read request body
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const trigger = await configRepo.getTriggerById(triggerId);
          if (!trigger) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Trigger not found" }));
            return;
          }

          // Verify secret
          const authHeader = req.headers.authorization ?? "";
          const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
          if (!trigger.secret || token !== trigger.secret) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid authorization" }));
            return;
          }

          // Check status
          if (trigger.status !== "active") {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Trigger is inactive" }));
            return;
          }

          // Parse payload
          let payload: unknown = {};
          if (body) {
            try { payload = JSON.parse(body); } catch { payload = body; }
          }

          // Dispatch to callback
          if (gatewayServer.onWebhook) {
            gatewayServer.onWebhook(trigger, payload);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "accepted" }));
        } catch (err) {
          console.error("[gateway] Webhook error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // Plugin HTTP handlers
    if (extraHttpHandlers) {
      for (const [prefix, handler] of extraHttpHandlers) {
        if (url.startsWith(prefix)) {
          handler(req, res);
          return;
        }
      }
    }

    // Serve static web UI
    serveStatic(res, url);
  });

  // WebSocket server
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const urlPath = req.url?.split("?")[0];
    console.log(`[gateway] HTTP Upgrade request: ${req.url} → path=${urlPath}`);
    if (urlPath === "/ws") {
      const auth = authMiddleware.authenticateWebSocket(req);
      console.log(`[gateway] WS auth result: ${auth ? `userId=${auth.userId} username=${auth.username}` : "null (anonymous)"}`);

      wss.handleUpgrade(req, socket, head, (ws) => {
        (ws as AuthenticatedWebSocket).auth = auth ?? undefined;
        wss.emit("connection", ws, auth);
      });
    } else {
      console.log(`[gateway] Upgrade rejected: unknown path ${urlPath}`);
      socket.destroy();
    }
  });

  // Grace period timers for delayed agentbox teardown
  const teardownTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // -- WebSocket keep-alive: ping every 30s, terminate unresponsive clients --
  const PING_INTERVAL = 30_000;
  const aliveClients = new WeakSet<WebSocket>();

  const pingTimer = setInterval(() => {
    for (const ws of clients) {
      if (!aliveClients.has(ws)) {
        console.log("[gateway] WS client unresponsive, terminating");
        ws.terminate();
        continue;
      }
      aliveClients.delete(ws);
      ws.ping();
    }
  }, PING_INTERVAL);
  // Clean up interval when server closes
  wss.on("close", () => clearInterval(pingTimer));

  wss.on("connection", (ws: WebSocket, auth?: AuthContext) => {
    clients.add(ws);
    aliveClients.add(ws);
    ws.on("pong", () => aliveClients.add(ws));

    const authWs = ws as AuthenticatedWebSocket;
    const authInfo = auth ? `user=${auth.username}` : "anonymous";
    console.log(`[gateway] WS client connected (${authInfo}, total: ${clients.size})`);

    // Track per-user connections and manage AgentBox lifecycle
    if (auth?.userId) {
      let conns = userConnections.get(auth.userId);
      if (!conns) {
        conns = new Set();
        userConnections.set(auth.userId, conns);
      }
      conns.add(ws);

      // Cancel pending teardown if user reconnected within grace period
      const pendingTeardown = teardownTimers.get(auth.userId);
      if (pendingTeardown) {
        clearTimeout(pendingTeardown);
        teardownTimers.delete(auth.userId);
        console.log(`[gateway] Cancelled AgentBox teardown for ${auth.username} (reconnected)`);
      }

      // Create AgentBox on first connection for this user
      if (conns.size === 1) {
        agentBoxManager.getOrCreate(auth.userId).then((handle) => {
          console.log(`[gateway] AgentBox ready for ${auth.username}: ${handle.boxId}`);
        }).catch((err) => {
          console.error(`[gateway] AgentBox create failed for ${auth.username}:`, err.message);
        });
      }
    }

    ws.on("message", async (data) => {
      const raw = String(data);
      console.log(`[gateway] WS recv: ${raw.slice(0, 200)}`);
      const frame = parseFrame(raw);
      if (!frame) {
        console.warn("[gateway] WS frame parse failed, ignoring");
        return;
      }
      console.log(`[gateway] RPC: ${frame.method} id=${frame.id} user=${authWs.auth?.username || "anonymous"}`);

      // Keep agentbox alive while user is active
      if (authWs.auth?.userId) {
        agentBoxManager.touch(authWs.auth.userId);
      }

      // Build RPC context with auth info and event sender
      const context: RpcContext = {
        auth: authWs.auth,
        sendEvent: (event, payload) => {
          if (ws.readyState === ws.OPEN) {
            if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
              console.warn(`[ws] Backpressure: skipping sendEvent ${event} for userId=${authWs.auth?.userId ?? "unknown"} (buffered=${ws.bufferedAmount})`);
              return;
            }
            ws.send(buildEvent(event, payload));
          } else {
            console.warn(`[gateway] WS not open, dropping event: ${event} for userId=${authWs.auth?.userId ?? "unknown"}`);
          }
        },
      };

      await dispatchRpc(rpcMethods, frame, ws, context);
    });

    ws.on("close", () => {
      clients.delete(ws);

      // Remove from per-user tracking and stop AgentBox when last connection closes
      if (auth?.userId) {
        const conns = userConnections.get(auth.userId);
        if (conns) {
          conns.delete(ws);
          if (conns.size === 0) {
            userConnections.delete(auth.userId);
            // Grace period: wait 30s before stopping (in case user refreshes the page)
            console.log(`[gateway] Last WS for ${auth.username} closed, will stop AgentBox in 30s`);
            const timer = setTimeout(() => {
              teardownTimers.delete(auth.userId);
              // Skip teardown if the agent is still running (internal API or web prompt)
              if (activeInternalUsers.has(auth.userId) || activePromptUsers.has(auth.userId)) {
                console.log(`[gateway] Skipping AgentBox teardown for ${auth.username} (active prompt/internal API)`);
                return;
              }
              console.log(`[gateway] Stopping all AgentBoxes for ${auth.username} (no reconnect)`);
              agentBoxManager.stopAll(auth.userId).catch((err) => {
                console.error(`[gateway] AgentBox stopAll failed for ${auth.username}:`, err.message);
              });
            }, 30_000);
            teardownTimers.set(auth.userId, timer);
          }
        }
      }

      console.log(`[gateway] WS client disconnected (total: ${clients.size})`);
    });

    ws.on("error", (err) => {
      console.error("[gateway] WS error:", err.message);
      clients.delete(ws);
    });
  });

  // Keep AgentBox alive for all users with active WebSocket connections
  setInterval(() => {
    for (const userId of userConnections.keys()) {
      agentBoxManager.touch(userId);
    }
  }, 60_000);

  // Short keep-alive so idle HTTP connections free up quickly.
  // Browsers limit per-host connections (Chrome: 6). Page assets can fill all
  // slots, blocking the WebSocket upgrade until a slot opens.
  httpServer.keepAliveTimeout = 500;

  httpServer.listen(config.port, config.host, () => {
    console.log(`[gateway] Listening on http://${config.host}:${config.port}`);
    console.log(`[gateway] Web UI: http://${config.host}:${config.port}/`);
    console.log(`[gateway] WebSocket: ws://${config.host}:${config.port}/ws`);
  });

  const gatewayServer: GatewayServer = {
    httpServer,
    broadcast,
    userStore,
    bindCodeStore,
    db,
    rpcMethods,
    buildCredentialPayload,
    async close() {
      bindCodeStore.dispose();
      await agentBoxManager.cleanup();
      for (const ws of clients) {
        ws.close();
      }
      clients.clear();
      wss.close();
      httpServer.close();
      await closeDb();
    },
  };

  return gatewayServer;
}

/** Consume SSE stream from AgentBox and extract final assistant text */
async function waitForAgentCompletion(client: AgentBoxClient, sessionId: string): Promise<string> {
  let resultText = "";
  for await (const event of client.streamEvents(sessionId)) {
    const evt = event as Record<string, unknown>;
    if (evt.type === "message_end" || evt.type === "turn_end") {
      const message = evt.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant") {
        const content = message.content;
        if (typeof content === "string") {
          resultText = content;
        } else if (Array.isArray(content)) {
          const text = (content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("");
          if (text) resultText = text;
        }
      }
    }
    if (evt.type === "agent_end") break;
  }
  return resultText;
}

/** Returns a promise that rejects after the given timeout */
function rejectAfterTimeout(ms: number, sessionId: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`agent-prompt session=${sessionId} timed out after ${ms / 1000}s`)), ms),
  );
}

/**
 * Resolve JWT secret: env var > DB > generate new and persist to DB.
 */
async function resolveJwtSecret(sysConfigRepo: SystemConfigRepository | null): Promise<string> {
  if (process.env.SICLAW_JWT_SECRET) {
    return process.env.SICLAW_JWT_SECRET;
  }

  if (sysConfigRepo) {
    const existing = await sysConfigRepo.get("jwt.secret");
    if (existing) {
      console.log("[gateway] JWT secret loaded from database");
      return existing;
    }
  }

  const { randomBytes } = await import("node:crypto");
  const generated = randomBytes(32).toString("hex");

  if (sysConfigRepo) {
    await sysConfigRepo.set("jwt.secret", generated);
    console.log("[gateway] Generated new JWT secret → database");
  } else {
    console.warn("[gateway] Generated JWT secret but no DB to persist — tokens will invalidate on restart");
  }

  return generated;
}

/**
 * Resolve an API key value — if it looks like an env var name (no slashes,
 * no dots, all uppercase/underscores), resolve it from process.env.
 */
function resolveApiKey(value: string): string {
  if (/^[A-Z_][A-Z0-9_]*$/.test(value)) {
    return process.env[value] ?? value;
  }
  return value;
}
