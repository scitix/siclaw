/**
 * AgentBox Worker entry point
 *
 * A standalone Agent service exposed via HTTP API.
 * Reuses createSiclawSession() core logic, with the interaction layer changed from terminal to HTTP.
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { createHttpServer } from "./agentbox/http-server.js";
import { AgentBoxSessionManager } from "./agentbox/session.js";
import { loadConfig, reloadConfig, getConfigPath } from "./core/config.js";
import { GatewayClient } from "./agentbox/gateway-client.js";
import { syncAllResources } from "./agentbox/resource-sync.js";
// Side-effect: register metrics subscriber. Also imported in http-server.ts,
// but ESM guarantees single module evaluation — the subscriber registers only once.
import "./shared/metrics.js";

// Use /tmp for config in containers where cwd may be read-only
if (!process.env.SICLAW_CONFIG_DIR) {
  const cwdConfigDir = path.resolve(process.cwd(), ".siclaw", "config");
  try {
    fs.mkdirSync(cwdConfigDir, { recursive: true });
  } catch {
    process.env.SICLAW_CONFIG_DIR = "/tmp/.siclaw/config";
  }
}

const config = loadConfig();
const PORT = config.server.port;

async function main() {
  // If gatewayUrl is configured, fetch the latest settings.json from Gateway (with mTLS)
  if (config.server.gatewayUrl) {
    try {
      const gatewayClient = new GatewayClient({
        gatewayUrl: config.server.gatewayUrl,
      });

      const remoteConfig = await gatewayClient.fetchSettings();
      const configPath = getConfigPath();
      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(remoteConfig, null, 2) + "\n");
      reloadConfig();
      console.log(`[agentbox] Fetched settings from Gateway via mTLS: ${config.server.gatewayUrl}`);

      // Sync all resources (MCP, skills) from Gateway with retry
      const { failed } = await syncAllResources(gatewayClient.toClientLike());
      if (failed.length > 0) {
        console.warn(`[agentbox] Resource sync partial failure: [${failed.join(", ")}]`);
      }
    } catch (err) {
      console.warn(`[agentbox] Failed to fetch settings from Gateway, using local config:`, err);
    }
  }

  const skillsDir = path.resolve(process.cwd(), config.paths.skillsDir);
  const userDataDir = path.resolve(process.cwd(), config.paths.userDataDir);
  console.log(`[agentbox] cwd: ${process.cwd()}`);
  console.log(`[agentbox] userDataDir=${userDataDir}`);
  console.log(`[agentbox] skillsDir=${skillsDir}`);
  for (const tier of ["core"]) {
    const dir = path.join(skillsDir, tier);
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir).filter(e => !e.startsWith("."));
      console.log(`[agentbox] skills/${tier}: ${entries.length} entries${entries.length ? ` (${entries.join(", ")})` : ""}`);
    } else {
      console.warn(`[agentbox] WARNING: skills/${tier} NOT found at ${dir}`);
    }
  }

  // Create session manager
  const sessionManager = new AgentBoxSessionManager();

  // Start HTTP server
  const server = createHttpServer(sessionManager);

  const protocol = server instanceof https.Server ? "https" : "http";
  server.listen(PORT, () => {
    console.log(`[agentbox] ${protocol.toUpperCase()} server listening on port ${PORT}`);
    console.log(`[agentbox] Health check: ${protocol}://localhost:${PORT}/health`);
  });

  // In K8s mode (HTTPS / mTLS), the main port requires Gateway client certs.
  // Prometheus cannot present those certs, so we start a separate plain HTTP
  // server on port 9090 that serves only /metrics.
  let metricsServer: http.Server | null = null;
  if (server instanceof https.Server) {
    const metricsPort = parseInt(process.env.SICLAW_METRICS_PORT || "9090", 10);
    const { checkMetricsAuth } = await import("./shared/metrics.js");

    metricsServer = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/metrics") {
        if (!checkMetricsAuth(req, res)) return;
        try {
          const { metricsRegistry } = await import("./shared/metrics.js");
          const body = await metricsRegistry.metrics();
          res.writeHead(200, { "Content-Type": metricsRegistry.contentType });
          res.end(body);
        } catch (err) {
          console.error("[agentbox] /metrics error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    metricsServer.on("error", (err) => {
      console.error("[agentbox] Metrics server error:", err);
    });

    metricsServer.listen(metricsPort, () => {
      console.log(`[agentbox] Metrics HTTP server listening on port ${metricsPort} (Prometheus scrape target)`);
      if (!process.env.SICLAW_METRICS_TOKEN) {
        console.warn("[agentbox] WARNING: SICLAW_METRICS_TOKEN is not set — /metrics endpoint is unauthenticated");
      }
    });
  }

  // Graceful shutdown — close metrics server last so Prometheus can scrape
  // the final state before the pod terminates.
  const shutdown = async () => {
    console.log("[agentbox] Shutting down...");
    await sessionManager.closeAll();
    server.close();
    if (metricsServer) metricsServer.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[agentbox] Fatal error:", err);
  process.exit(1);
});
