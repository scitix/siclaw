/**
 * AgentBox Worker entry point
 *
 * A standalone Agent service exposed via HTTP API.
 * Reuses createSiclawSession() core logic, with the interaction layer changed from terminal to HTTP.
 */

import fs from "node:fs";
import path from "node:path";
import { createHttpServer } from "./agentbox/http-server.js";
import { AgentBoxSessionManager } from "./agentbox/session.js";
import { loadConfig, reloadConfig } from "./core/config.js";

const config = loadConfig();
const PORT = config.server.port;

async function main() {
  // If gatewayUrl is configured, fetch the latest settings.json from Gateway
  if (config.server.gatewayUrl) {
    try {
      const resp = await fetch(`${config.server.gatewayUrl}/api/internal/settings`, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const remoteConfig = await resp.json();
        const configPath = path.resolve(process.cwd(), ".siclaw", "config", "settings.json");
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(remoteConfig, null, 2) + "\n");
        reloadConfig();
        console.log(`[agentbox] Fetched settings from Gateway: ${config.server.gatewayUrl}`);
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
  for (const tier of ["core", "team", "extension", "user", "platform"]) {
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

  server.listen(PORT, () => {
    console.log(`[agentbox] HTTP server listening on port ${PORT}`);
    console.log(`[agentbox] Health check: http://localhost:${PORT}/health`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[agentbox] Shutting down...");
    await sessionManager.closeAll();
    server.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[agentbox] Fatal error:", err);
  process.exit(1);
});
