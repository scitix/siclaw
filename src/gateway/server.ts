import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { GatewayConfig } from "./config.js";
import type { AgentBoxManager } from "./agentbox/manager.js";
import { AgentBoxClient, type PromptOptions } from "./agentbox/client.js";
import { createBroadcaster, buildEvent, parseFrame, dispatchRpc, MAX_BUFFERED_BYTES, type RpcHandler, type RpcContext } from "./ws-protocol.js";
import { createRpcMethods } from "./rpc-methods.js";
import type { SkillBundle } from "./skills/skill-bundle.js";
import { UserStore, createLoginHandler, createAuthMiddleware, BindCodeStore, signJwt, type AuthContext } from "./auth/index.js";
import { loadOAuth2Config, generateState, consumeState, buildAuthorizeUrl, exchangeCode, fetchUserInfo, type OAuth2Config } from "./auth/oauth2.js";
import { createDb, closeDb, type Database } from "./db/index.js";
import { initSchema } from "./db/init-schema.js";
import { ConfigRepository } from "./db/repositories/config-repo.js";
import { NotificationRepository } from "./db/repositories/notification-repo.js";
import { CronService } from "./cron/cron-service.js";
import { ChatRepository } from "./db/repositories/chat-repo.js";
import { PermissionRepository } from "./db/repositories/permission-repo.js";
import { UserRepository } from "./db/repositories/user-repo.js";
import { ModelConfigRepository } from "./db/repositories/model-config-repo.js";
import { SystemConfigRepository } from "./db/repositories/system-config-repo.js";
import { WorkspaceRepository } from "./db/repositories/workspace-repo.js";
import { McpServerRepository } from "./db/repositories/mcp-server-repo.js";
import { loadConfig } from "../core/config.js";
import { buildMergedMcpConfig } from "./mcp-config-builder.js";
import { CertificateManager } from "./security/cert-manager.js";
import { createMtlsMiddleware } from "./security/mtls-middleware.js";
import { createResourceNotifier } from "./resource-notifier.js";
import { LocalSpawner } from "./agentbox/local-spawner.js";
import { emitDiagnostic } from "../shared/diagnostic-events.js";
import { checkMetricsAuth } from "../shared/metrics.js"; // also registers metrics subscriber (side-effect)
import { MetricsAggregator } from "./metrics-aggregator.js";

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

function serveStatic(res: http.ServerResponse, urlPath: string, frameSrc?: string | null): void {
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
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (frameSrc && contentType.startsWith("text/html")) {
    headers["Content-Security-Policy"] = `frame-src 'self' ${frameSrc}`;
  }
  res.writeHead(200, headers);
  res.end(content);
}

export interface GatewayServer {
  httpServer: http.Server;
  httpsServer: https.Server | null; // HTTPS server for internal mTLS API
  certManager: CertificateManager;
  broadcast: import("./ws-protocol.js").BroadcastFn;
  userStore: UserStore;
  bindCodeStore: BindCodeStore;
  db: Database | null;
  /** Live RPC method map — add methods after startup */
  rpcMethods: Map<string, RpcHandler>;
  /** Callback for webhook dispatch — set by gateway-main.ts */
  onWebhook?: (trigger: any, payload: unknown) => void;
  /** In-process cron scheduler — started by gateway-main after HTTP is ready */
  cronService: import("./cron/cron-service.js").CronService | null;
  /** Build credential payload for a specific workspace (sent in prompt body) */
  buildCredentialPayload: (userId: string, workspaceId: string, isDefault: boolean) => Promise<{ manifest: Array<{ name: string; type: string; description?: string | null; files: string[]; metadata?: Record<string, unknown> }>; files: Array<{ name: string; content: string; mode?: number }> }>;
  /** TLS options for AgentBox mTLS connections (K8s mode only) */
  agentBoxTlsOptions?: import("./agentbox/client.js").AgentBoxTlsOptions;
  close(): Promise<void>;
}

/** Extended WebSocket with auth context */
interface AuthenticatedWebSocket extends WebSocket {
  auth?: AuthContext;
}

export interface StartGatewayOptions {
  config: GatewayConfig;
  agentBoxManager: AgentBoxManager;
  /** Pass the spawner so server can wire local-mode resource sync */
  spawner?: import("./agentbox/spawner.js").BoxSpawner;
  extraRpcMethods?: Map<string, RpcHandler>;
  extraHttpHandlers?: Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>;
}

export async function startGateway(opts: StartGatewayOptions): Promise<GatewayServer> {
  const { config, agentBoxManager, spawner, extraRpcMethods, extraHttpHandlers } = opts;

  // Track users with active SSE prompt streams (web UI)
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

  // Config repo for webhook route + cron service
  const configRepo = db ? new ConfigRepository(db) : null;
  const notifRepo = db ? new NotificationRepository(db) : null;

  // In-process cron service (replaces standalone cron process)
  const cronService = (configRepo && notifRepo)
    ? new CronService({ configRepo, notifRepo, sendToUser, gatewayPort: config.port })
    : null;

  // System config repo (used by JWT, SSO, cert-manager, metrics cache, etc.)
  const sysConfigRepo = db ? new SystemConfigRepository(db) : null;

  // Clean orphan model entries on startup
  if (db) {
    const modelConfigRepo = new ModelConfigRepository(db);
    await modelConfigRepo.cleanOrphanModels();
  }

  // Workspace repo (used by internal API to resolve default workspace)
  const internalWorkspaceRepo = db ? new WorkspaceRepository(db) : null;

  // Initialize Certificate Manager for mTLS (CA persisted in DB)
  const certManager = await CertificateManager.create(sysConfigRepo);
  agentBoxManager.setCertManager(certManager);
  const gatewayHostname = process.env.SICLAW_GATEWAY_HOSTNAME || "siclaw-gateway.siclaw.svc.cluster.local";
  const serverCert = certManager.issueServerCertificate(gatewayHostname);

  // Gateway cert as mTLS client credentials for AgentBox calls
  const agentBoxTlsOptions = {
    cert: serverCert.cert,
    key: serverCert.key,
    ca: certManager.getCACertificate(),
  };

  // Wire local-mode resource sync: inject DB repo + localReloader
  // For LocalSpawner, resources are synced in-process (no HTTP + mTLS round-trip).
  const localSpawner = spawner instanceof LocalSpawner ? spawner : null;

  if (localSpawner && db) {
    localSpawner.setMcpRepo(new McpServerRepository(db));
  }

  // Create resource notifier — pass localReloader for local-mode in-process reload
  const localReloader = localSpawner
    ? (type: import("../shared/resource-sync.js").ResourceType, userId?: string) =>
        localSpawner.reloadResource(type, userId)
    : undefined;
  const resourceNotifier = createResourceNotifier(agentBoxManager, agentBoxTlsOptions, localReloader);

  // Create MetricsAggregator (Local mode: proxy LocalCollector; K8s mode: pull loop)
  const isK8sMode = !(spawner instanceof LocalSpawner);
  let metricsAggregator: MetricsAggregator;
  if (isK8sMode) {
    metricsAggregator = new MetricsAggregator("k8s", undefined, agentBoxManager, {
      async fetch(endpoint: string): Promise<import("../shared/metrics-types.js").MetricsSnapshot | null> {
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
  if (db) metricsAggregator.setDb(db);

  // CSP frame-src cache for Grafana iframe embedding
  let cachedFrameSrc: string | null = null;
  const refreshCspCache = async () => {
    if (!sysConfigRepo) return;
    try {
      const url = await sysConfigRepo.get("system.grafanaUrl");
      cachedFrameSrc = url ? new URL(url).origin : null;
    } catch {
      cachedFrameSrc = null;
    }
  };
  await refreshCspCache();

  // Metrics config cache — Gateway reads from DB, falls back to env var
  let cachedMetricsToken: string | undefined;
  const refreshMetricsConfig = async () => {
    if (!sysConfigRepo) return;
    try {
      cachedMetricsToken = (await sysConfigRepo.get("metrics.token")) ?? undefined;
    } catch { /* keep previous cachedMetricsToken */ }
    try {
      const userIdVal = await sysConfigRepo.get("metrics.includeUserId");
      if (userIdVal !== null) {
        const { setIncludeUserId } = await import("../shared/metrics.js");
        setIncludeUserId(userIdVal !== "false");
      }
    } catch { /* keep previous includeUserId */ }
  };
  await refreshMetricsConfig();

  // Create RPC methods using AgentBoxManager
  const { methods: rpcMethods, buildCredentialPayload, getSkillBundle, cleanupForWs } = createRpcMethods(agentBoxManager, broadcast, db, sendToUser, activePromptUsers, agentBoxTlsOptions, resourceNotifier, metricsAggregator, cronService);

  // Wrap system.saveSection to refresh caches when settings change
  const origSaveSection = rpcMethods.get("system.saveSection");
  if (origSaveSection) {
    rpcMethods.set("system.saveSection", async (params, context) => {
      const result = await origSaveSection(params, context);
      const section = (params as { section?: string }).section;
      if (section === "system") await refreshCspCache();
      if (section === "metrics") await refreshMetricsConfig();
      if (section === "sso") await refreshSsoCache();
      return result;
    });
  }

  // Wire skill bundle provider into LocalSpawner (getSkillBundle comes from createRpcMethods)
  if (localSpawner) {
    localSpawner.setSkillBundleProvider(getSkillBundle);
  }

  // Auth setup — auto-generate JWT secret on first run if not provided
  const jwtSecret = await resolveJwtSecret(sysConfigRepo);
  const userStore = new UserStore(db);
  await userStore.init();
  const bindCodeStore = new BindCodeStore();
  const { handleLogin } = createLoginHandler(userStore, jwtSecret);
  const authMiddleware = createAuthMiddleware(jwtSecret);

  // OAuth2 / SSO config — loaded into memory at startup and refreshed only
  // when admin saves settings via system.saveSection RPC. Zero DB queries on
  // the unauthenticated /api/sso/config endpoint.
  let cachedOAuth2Config: OAuth2Config | null = null;
  let cachedSsoEnabled = false;

  async function refreshSsoCache() {
    let dbOverrides: Record<string, string> | undefined;
    if (sysConfigRepo) {
      try { dbOverrides = await sysConfigRepo.getAll("sso."); } catch { /* ignore */ }
    }
    cachedOAuth2Config = loadOAuth2Config(dbOverrides);
    cachedSsoEnabled = cachedOAuth2Config !== null
      && dbOverrides?.["sso.enabled"] === "true";
  }

  await refreshSsoCache();
  if (cachedOAuth2Config) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- TS can't narrow let vars captured by closures
    const cfg = cachedOAuth2Config as OAuth2Config;
    console.log(`[gateway] SSO configured: issuer=${cfg.issuer} clientId=${cfg.clientId}`);
  }

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

  // Create mTLS middleware for internal API (certManager + serverCert initialized earlier)
  const mtlsMiddleware = createMtlsMiddleware({
    certManager,
    protectedPaths: ["/api/internal/"],
  });

  // HTTP server (Public API)
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

    // Prometheus metrics endpoint
    if (url === "/metrics" && method === "GET") {
      if (!checkMetricsAuth(req, res, cachedMetricsToken)) return;
      (async () => {
        try {
          const { metricsRegistry } = await import("../shared/metrics.js");
          const metricsBody = await metricsRegistry.metrics();
          res.writeHead(200, { "Content-Type": metricsRegistry.contentType });
          res.end(metricsBody);
        } catch (err) {
          console.error("[gateway] /metrics error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      })();
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

    // SSO config check (frontend uses this to decide whether to show SSO button).
    // Pure memory read — no DB query. Cache is refreshed via system.saveSection RPC.
    if (url === "/api/sso/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ enabled: cachedSsoEnabled }));
      return;
    }

    // SSO: redirect to IdP authorize URL
    if (url === "/auth/sso" && method === "GET") {
      if (!cachedSsoEnabled || !cachedOAuth2Config) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: cachedOAuth2Config ? "SSO is disabled" : "SSO not configured" }));
        return;
      }
      const state = generateState();
      const authorizeUrl = buildAuthorizeUrl(cachedOAuth2Config, state);
      console.log(`[gateway] SSO redirect → ${authorizeUrl}`);
      res.writeHead(302, { Location: authorizeUrl });
      res.end();
      return;
    }

    // SSO: callback from IdP
    if (url.startsWith("/auth/callback") && method === "GET") {
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
          if (!cachedOAuth2Config) {
            res.writeHead(302, { Location: "/login?error=SSO+not+configured" });
            res.end();
            return;
          }

          // Exchange code for tokens
          const tokenResp = await exchangeCode(cachedOAuth2Config, code);
          console.log("[gateway] SSO token exchange OK");

          // Fetch user info
          const userInfo = await fetchUserInfo(cachedOAuth2Config, tokenResp.access_token);
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

    // NOTE: /api/internal/cron-list has been moved to HTTPS server (port 3002)
    // with mTLS authentication for AgentBox access only.

    // Internal agent-prompt endpoint: POST /api/internal/agent-prompt
    // Synchronous execution — waits for agent to finish and returns result text.
    // Used by cron, triggers, and other internal callers.
    if (url === "/api/internal/agent-prompt" && method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        const startTime = Date.now();
        let userId = "";
        let client: AgentBoxClient | null = null;
        let sessionId: string | undefined;
        try {
          const data = JSON.parse(body) as {
            userId: string; sessionId: string; text: string;
            timeoutMs?: number; caller?: string;
            workspaceId?: string;
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

          // 1. Get or create user's AgentBox (resolve real workspace ID from DB)
          if (!data.workspaceId && !internalWorkspaceRepo) throw new Error("Database not available");
          const workspace = data.workspaceId
            ? await internalWorkspaceRepo?.getById(data.workspaceId) ?? null
            : await internalWorkspaceRepo!.getOrCreateDefault(userId);
          const wsId = workspace?.id || data.workspaceId!;
          const isDefaultWs = workspace?.isDefault ?? true;
          const handle = await agentBoxManager.getOrCreate(userId, wsId);
          client = new AgentBoxClient(handle.endpoint, 30000, agentBoxTlsOptions);

          // 2. Build credential payload so AgentBox has kubeconfig etc.
          const credentials = await buildCredentialPayload(userId, wsId, isDefaultWs).catch((err) => {
            console.warn(`[gateway] agent-prompt credential build failed:`, err instanceof Error ? err.message : err);
            return undefined;
          });

          // 3. Resolve model config (workspace default → global default)
          let modelProvider: string | undefined;
          let modelId: string | undefined;
          let modelConfig: PromptOptions["modelConfig"];
          if (db) {
            const mcRepo = new ModelConfigRepository(db);
            // Try workspace default model first, then global default
            const wsDefault = workspace?.configJson?.defaultModel;
            const defaultModel = wsDefault?.provider && wsDefault?.modelId
              ? { provider: wsDefault.provider, modelId: wsDefault.modelId }
              : await mcRepo.getDefault();
            if (defaultModel) {
              modelProvider = defaultModel.provider;
              modelId = defaultModel.modelId;
              try {
                const providerConfig = await mcRepo.getProviderWithModels(modelProvider);
                if (providerConfig) modelConfig = providerConfig;
              } catch (err) {
                console.warn(`[gateway] agent-prompt provider config resolve failed:`, err instanceof Error ? err.message : err);
              }
            }
          }

          // 4. Send prompt with credentials and model config
          const promptResult = await client.prompt({ sessionId: data.sessionId, text: data.text, credentials, modelProvider, modelId, modelConfig });
          sessionId = promptResult.sessionId;

          // 4. Wait for completion with cancellable timeout
          const timeout = rejectAfterTimeout(timeoutMs, data.sessionId);
          try {
            const resultText = await Promise.race([
              waitForAgentCompletion(client, promptResult.sessionId),
              timeout.promise,
            ]);

            timeout.cancel();
            const durationMs = Date.now() - startTime;
            console.log(`[gateway] agent-prompt completed user=${userId} duration=${durationMs}ms resultLen=${resultText.length}`);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", resultText, durationMs }));
          } catch (innerErr) {
            timeout.cancel();
            // On timeout, attempt to abort + close the orphaned agent session
            if (client && sessionId && innerErr instanceof ExecutionTimeoutError) {
              try { await client.abortSession(sessionId); } catch { /* best-effort */ }
              try { await client.closeSession(sessionId); } catch { /* best-effort */ }
              console.log(`[gateway] agent-prompt session=${sessionId} aborted after timeout`);
            }
            throw innerErr;
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

    // NOTE: /api/internal/settings and /api/internal/cron-list have been moved to
    // HTTPS server (port 3002) with mTLS authentication. These endpoints are no longer
    // available on the HTTP server to enforce zero-trust security for AgentBox communication.

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

    // Internal session/stats purge endpoint: POST /api/internal/sessions/purge
    if (url === "/api/internal/sessions/purge" && method === "POST") {
      if (!db) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Database not available" }));
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const {
            softDeleteInactiveDays = 180,
            statsRetentionDays = 90,
            hardDeleteAfterDays = 30,
          } = body ? JSON.parse(body) : {};
          if (softDeleteInactiveDays < 1 || statsRetentionDays < 1 || hardDeleteAfterDays < 1) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Retention days must be >= 1" }));
            return;
          }
          const chatRepo = new ChatRepository(db);

          // Step 1: soft-delete inactive sessions
          const softDeleted = await chatRepo.softDeleteInactiveSessions(softDeleteInactiveDays);
          // Step 2: hard-delete old session_stats
          const statsPurged = await chatRepo.purgeOldSessionStats(statsRetentionDays);
          // Step 3: hard-delete soft-deleted sessions (messages cascade)
          const sessionsPurged = await chatRepo.purgeDeletedSessions(hardDeleteAfterDays);

          console.log(
            `[gateway] Session purge: softDeleted=${softDeleted}, statsPurged=${statsPurged}, sessionsPurged=${sessionsPurged}`,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", softDeleted, statsPurged, sessionsPurged }));
        } catch (err) {
          console.error("[gateway] sessions/purge error:", err);
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
    serveStatic(res, url, cachedFrameSrc);
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
    emitDiagnostic({ type: "ws_connected" });
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
        ws,
      };

      await dispatchRpc(rpcMethods, frame, ws, context);
    });

    ws.on("close", () => {
      clients.delete(ws);

      // Abort SSE streams associated with this WS connection
      cleanupForWs(ws);

      // Remove from per-user tracking
      if (auth?.userId) {
        const conns = userConnections.get(auth.userId);
        if (conns) {
          conns.delete(ws);
          if (conns.size === 0) {
            userConnections.delete(auth.userId);
          }
        }
      }

      emitDiagnostic({ type: "ws_disconnected" });
      console.log(`[gateway] WS client disconnected (total: ${clients.size})`);
    });

    ws.on("error", (err) => {
      console.error("[gateway] WS error:", err.message);
      // Note: do NOT emit ws_disconnected here — the "close" event always
      // fires after "error" and handles the decrement + cleanup.
      clients.delete(ws);
    });
  });

  // Short keep-alive so idle HTTP connections free up quickly.
  // Browsers limit per-host connections (Chrome: 6). Page assets can fill all
  // slots, blocking the WebSocket upgrade until a slot opens.
  httpServer.keepAliveTimeout = 500;

  httpServer.listen(config.port, config.host, () => {
    console.log(`[gateway] Listening on http://${config.host}:${config.port}`);
    console.log(`[gateway] Web UI: http://${config.host}:${config.port}/`);
    console.log(`[gateway] WebSocket: ws://${config.host}:${config.port}/ws`);
    if (!cachedMetricsToken && !process.env.SICLAW_METRICS_TOKEN) {
      console.warn(`[gateway] WARNING: metrics token is not configured — /metrics endpoint is unauthenticated`);
    }
  });

  // HTTPS server for internal mTLS API (AgentBox connections)
  const internalPort = config.internalPort || 3002;
  let httpsServer: https.Server | null = null;

  try {
    httpsServer = https.createServer(
      {
        cert: serverCert.cert,
        key: serverCert.key,
        ca: certManager.getCACertificate(),
        requestCert: true,         // Request client certificate
        rejectUnauthorized: true,  // Reject connections without valid certificate
      },
      (req, res) => {
        const url = req.url ?? "/";
        const method = req.method ?? "GET";

        console.log(`[gateway] HTTPS ${method} ${url}`);

        // Apply mTLS middleware (validates certificate and attaches identity)
        mtlsMiddleware(req, res, () => {
          // All /api/internal/* endpoints from HTTP server should be duplicated here
          // For now, handle the key endpoints we've implemented

          // Internal settings endpoint: GET /api/internal/settings
          if (url === "/api/internal/settings" && method === "GET") {
            if (!db) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Database not available" }));
              return;
            }
            (async () => {
              try {
                const modelConfigRepo = new ModelConfigRepository(db);
                const settings: Record<string, unknown> = await modelConfigRepo.exportSettingsConfig();
                // Append debugImage if configured via env
                if (process.env.SICLAW_DEBUG_IMAGE) {
                  settings.debugImage = process.env.SICLAW_DEBUG_IMAGE;
                }
                // Append metrics config from system_config table
                if (sysConfigRepo) {
                  const metricsPort = await sysConfigRepo.get("metrics.port");
                  const metricsToken = await sysConfigRepo.get("metrics.token");
                  const includeUserId = await sysConfigRepo.get("metrics.includeUserId");
                  if (metricsPort || metricsToken || includeUserId) {
                    settings.metrics = {
                      ...(metricsPort ? { port: parseInt(metricsPort, 10) } : {}),
                      ...(metricsToken ? { token: metricsToken } : {}),
                      ...(includeUserId ? { includeUserId: includeUserId === "true" } : {}),
                    };
                  }
                }
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

          // Internal cron jobs list endpoint: GET /api/internal/cron-list?userId=xxx
          if (url.startsWith("/api/internal/cron-list") && method === "GET") {
            if (!db) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Database not available" }));
              return;
            }
            (async () => {
              try {
                // Verify mTLS certificate identity (set by middleware)
                const identity = (req as any).certIdentity;
                if (!identity) {
                  res.writeHead(401, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "Client certificate required" }));
                  return;
                }

                // Use userId from mTLS certificate identity (authoritative)
                const urlObj = new URL(url, `https://${req.headers.host}`);
                const userId = identity.userId;

                // Query cron jobs using ConfigRepository
                const configRepo = new ConfigRepository(db);
                const workspaceId = urlObj.searchParams.get("workspaceId") || identity.workspaceId;
                const jobs = await configRepo.listCronJobs(userId, workspaceId ? { workspaceId } : undefined);

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ jobs }));
                console.log(`[gateway] Listed ${jobs.length} cron jobs for userId=${userId}${workspaceId ? ` workspaceId=${workspaceId}` : ""}`);
              } catch (err) {
                console.error("[gateway] cron-list error:", err);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Internal server error" }));
              }
            })();
            return;
          }

          // Skill Bundle endpoint: GET /api/internal/skills/bundle
          // AgentBox pulls its skill bundle via mTLS — identity comes from certificate
          if (url === "/api/internal/skills/bundle" && method === "GET") {
            (async () => {
              try {
                const identity = (req as any).certIdentity;
                if (!identity) {
                  res.writeHead(401, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "Client certificate required" }));
                  return;
                }

                const bundle = await getSkillBundle(identity.userId, identity.env);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(bundle));
                console.log(`[gateway] Skill bundle served for userId=${identity.userId} env=${identity.env} skills=${bundle.skills.length}`);
              } catch (err) {
                console.error("[gateway] skills/bundle error:", err);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Internal server error" }));
              }
            })();
            return;
          }

          // Internal MCP servers endpoint: GET /api/internal/mcp-servers
          // Returns merged MCP config (local seed + DB overlay) for AgentBox consumption
          if (url === "/api/internal/mcp-servers" && method === "GET") {
            (async () => {
              try {
                const config = loadConfig();
                const localConfig = Object.keys(config.mcpServers).length > 0
                  ? { mcpServers: config.mcpServers }
                  : null;
                const mcpRepo = db ? new McpServerRepository(db) : null;
                const merged = await buildMergedMcpConfig(localConfig, mcpRepo);

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ mcpServers: merged }));
                console.log(`[gateway] MCP servers served: ${Object.keys(merged).length} servers [${Object.keys(merged).join(", ")}]`);
              } catch (err) {
                console.error("[gateway] mcp-servers error:", err);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Internal server error" }));
              }
            })();
            return;
          }

          // Default: 404 for unknown internal API paths
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        });
      }
    );

    httpsServer.listen(internalPort, config.host, () => {
      console.log(`[gateway] Internal API (mTLS) listening on https://${config.host}:${internalPort}`);
      console.log(`[gateway] Certificate CN: ${gatewayHostname}`);
    });
  } catch (err) {
    console.error("[gateway] Failed to start HTTPS server for internal API:", err);
    console.warn("[gateway] Internal API will not be available");
  }

  const gatewayServer: GatewayServer = {
    httpServer,
    httpsServer,
    certManager,
    broadcast,
    userStore,
    bindCodeStore,
    db,
    rpcMethods,
    cronService,
    buildCredentialPayload,
    agentBoxTlsOptions,
    async close() {
      cronService?.stop();
      bindCodeStore.dispose();
      await agentBoxManager.cleanup();
      for (const ws of clients) {
        ws.close();
      }
      clients.clear();
      wss.close();
      httpServer.close();
      if (httpsServer) {
        httpsServer.close();
      }
      await closeDb();
    },
  };

  return gatewayServer;
}

/** Consume SSE stream from AgentBox and extract final assistant text */
async function waitForAgentCompletion(client: AgentBoxClient, sessionId: string): Promise<string> {
  let resultText = "";
  // Accumulate text deltas per message (claude-sdk brain emits text via
  // message_update/text_delta and sends empty content in message_end)
  let currentMsgText = "";
  for await (const event of client.streamEvents(sessionId)) {
    const evt = event as Record<string, unknown>;

    // Accumulate streaming text deltas
    if (evt.type === "message_update") {
      const ame = evt.assistantMessageEvent as Record<string, unknown> | undefined;
      if (ame?.type === "text_delta" && typeof ame.delta === "string") {
        currentMsgText += ame.delta;
      }
    }

    if (evt.type === "message_start") {
      // New message — reset accumulated text
      currentMsgText = "";
    }

    if (evt.type === "message_end" || evt.type === "turn_end") {
      const message = evt.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant") {
        // Try to extract from message.content first (pi-agent brain)
        let extracted = "";
        const content = message.content;
        if (typeof content === "string" && content) {
          extracted = content;
        } else if (Array.isArray(content)) {
          extracted = (content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("");
        }
        // Use extracted content, or fall back to accumulated text deltas
        // (claude-sdk brain sends empty content in message_end)
        resultText = extracted || currentMsgText || resultText;
      }
      currentMsgText = "";
    }
    if (evt.type === "agent_end") break;
  }
  // Final fallback: if no message_end was captured but we have accumulated text
  if (!resultText && currentMsgText) {
    resultText = currentMsgText;
  }
  return resultText;
}

class ExecutionTimeoutError extends Error {
  constructor(sessionId: string, ms: number) {
    super(`agent-prompt session=${sessionId} timed out after ${ms / 1000}s`);
    this.name = "ExecutionTimeoutError";
  }
}

/** Returns a cancellable promise that rejects after the given timeout */
function rejectAfterTimeout(ms: number, sessionId: string): { promise: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExecutionTimeoutError(sessionId, ms)), ms);
    timer.unref();
  });
  return {
    promise,
    cancel: () => { if (timer) clearTimeout(timer); },
  };
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

