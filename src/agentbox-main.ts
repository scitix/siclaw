/**
 * AgentBox Worker entry point
 *
 * A standalone Agent service exposed via HTTP API.
 * Reuses createSiclawSession() core logic, with the interaction layer changed from terminal to HTTP.
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { createHttpServer } from "./agentbox/http-server.js";
import { AgentBoxSessionManager } from "./agentbox/session.js";
import { loadConfig, reloadConfig, getConfigPath } from "./core/config.js";
import { GatewayClient } from "./agentbox/gateway-client.js";

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

      // Fetch and materialize skill bundle (team + personal only; builtin baked in image)
      try {
        const bundle = await gatewayClient.fetchSkillBundle();
        const skillsDir = path.resolve(process.cwd(), config.paths.skillsDir);
        const { materializeBundle } = await import("./agentbox/http-server.js");
        await materializeBundle(bundle, skillsDir);

        // Write disabled builtins list for agent-factory to exclude
        if (bundle.disabledBuiltins?.length) {
          fs.writeFileSync(
            path.join(skillsDir, ".disabled-builtins.json"),
            JSON.stringify(bundle.disabledBuiltins),
          );
        }

        console.log(`[agentbox] Skill bundle materialized: ${bundle.skills.length} skills (${bundle.disabledBuiltins?.length || 0} builtins disabled), version=${bundle.version}`);
      } catch (bundleErr: any) {
        console.warn(`[agentbox] Failed to fetch skill bundle: ${bundleErr.message}`);
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
