/**
 * Portal HTTP server — wires together all Portal routes, the Runtime proxy,
 * and serves the frontend SPA static files.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRestRouter, sendJson } from "../gateway/rest-router.js";
import { registerAuthRoutes } from "./auth.js";
import { registerCliSnapshotRoute } from "./cli-snapshot-api.js";
import { registerAgentRoutes } from "./agent-api.js";
import { registerClusterRoutes } from "./cluster-api.js";
import { registerHostRoutes } from "./host-api.js";
import { registerAdapterRoutes, buildAdapterRpcHandlers } from "./adapter.js";
import { registerChatRoutes } from "./chat-gateway.js";
import { registerChannelRoutes } from "./channel-api.js";
import { registerNotificationRoutes, registerNotificationWs } from "./notification-api.js";
import { registerSiclawRoutes } from "./siclaw-api.js";
import { createRuntimeProxy } from "./proxy.js";
import { registerRuntimeWs } from "./runtime-connection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// Resolve static file directory (production: dist/portal-web/dist, dev fallback)
const WEB_DIR = fs.existsSync(path.join(__dirname, "..", "..", "portal-web", "dist", "index.html"))
  ? path.join(__dirname, "..", "..", "portal-web", "dist")
  : path.join(__dirname, "..", "..", "..", "portal-web", "dist");

export interface PortalConfig {
  port: number;
  jwtSecret: string;
  runtimeUrl: string;
  runtimeWsUrl?: string;   // Optional — Phase 1 backward compat
  runtimeSecret?: string;  // Optional — Phase 1 backward compat
  portalSecret: string;
  /**
   * Enable the `/api/v1/cli-snapshot` endpoint that returns provider/model/MCP
   * config (including provider api_key values) for a local TUI to consume.
   *
   * LOCAL MODE ONLY. Leave undefined / false in K8s/prod Portal deployments:
   * the endpoint bypasses per-tenant scoping and would let any admin-role JWT
   * holder read every tenant's LLM API keys. `siclaw local` opts in via its
   * single-user trust model (same process, same machine, same user).
   */
  enableCliSnapshot?: boolean;
}

export function startPortal(config: PortalConfig): http.Server {
  const router = createRestRouter();
  const runtimeProxy = createRuntimeProxy(config.runtimeUrl);

  // Build phone-home connection map (Runtimes connect to Portal via WS)
  const rpcHandlers = buildAdapterRpcHandlers();

  // Register Portal's own routes
  registerAuthRoutes(router, config.jwtSecret);
  if (config.enableCliSnapshot) {
    registerCliSnapshotRoute(router, config.jwtSecret);
  }
  registerAdapterRoutes(router, config.portalSecret);
  registerChannelRoutes(router, config.jwtSecret);
  registerNotificationRoutes(router, config.jwtSecret, config.portalSecret);

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Auth-Token, X-Cert-Agent-Id, X-Cert-User-Id, X-Cert-Org-Id, X-Cert-Box-Id",
    );
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── API routes ──────────────────────────────────────

    // Health check
    if (url === "/api/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    // Portal's own routes
    if (router.handle(req, res)) return;

    // All /api/v1/siclaw/* routes are now handled by registerSiclawRoutes
    // via router.handle() above. No more proxy to Runtime for CRUD.

    // Adapter API proxy (internal, called by Runtime)
    if (url.startsWith("/api/internal/")) {
      // Already handled by registerAdapterRoutes via router.handle
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    // ── Static file serving (SPA) ───────────────────────

    if (!fs.existsSync(WEB_DIR)) {
      // Dev mode: no built frontend, return hint
      if (url === "/" || !url.startsWith("/api")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="background:#0d1117;color:#c9d1d9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
          <div style="text-align:center">
            <h2>Siclaw Portal</h2>
            <p style="color:#8b949e">Frontend not built. Run: <code>cd portal-web && npm install && npm run dev</code></p>
          </div>
        </body></html>`);
        return;
      }
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    // Serve static file or SPA fallback
    const urlPath = url.split("?")[0];
    const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
    let filePath = path.join(WEB_DIR, safePath === "/" ? "index.html" : safePath);

    if (!filePath.startsWith(WEB_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // SPA fallback: if file not found and no extension, serve index.html
    if (!fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      if (!ext) {
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
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  });

  // Attach WS upgrade handlers before listen
  const connectionMap = registerRuntimeWs(server, config.portalSecret, rpcHandlers);
  registerNotificationWs(server, config.jwtSecret);

  // Register routes that need the connectionMap (requires server to exist for WS)
  registerAgentRoutes(router, config.jwtSecret, connectionMap);
  registerClusterRoutes(router, config.jwtSecret, connectionMap);
  registerHostRoutes(router, config.jwtSecret, connectionMap);
  registerChatRoutes(router, connectionMap, config.jwtSecret);
  registerSiclawRoutes(router, {
    jwtSecret: config.jwtSecret,
    serverUrl: config.runtimeUrl,
    portalSecret: config.portalSecret,
    connectionMap,
  });

  server.listen(config.port, () => {
    console.log(`[portal] Listening on http://0.0.0.0:${config.port}`);
    if (fs.existsSync(WEB_DIR)) {
      console.log(`[portal] Serving frontend from ${WEB_DIR}`);
    } else {
      console.log(`[portal] Frontend not built — run: cd portal-web && npm run build`);
    }
  });

  return server;
}
