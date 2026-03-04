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
import { loadConfig, reloadConfig, getConfigPath } from "./core/config.js";

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
  // If gatewayUrl is configured, fetch the latest settings.json from Gateway
  if (config.server.gatewayUrl) {
    try {
      const resp = await fetch(`${config.server.gatewayUrl}/api/internal/settings`, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const remoteConfig = await resp.json();
        const configPath = getConfigPath();
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

  // Merge MCP servers: local config as base, Gateway DB entries overlay (same name → Gateway wins)
  {
    // 1. Local config as base layer
    const localConfigPath = path.resolve(process.cwd(), "config", "mcp-servers.json");
    const merged: Record<string, unknown> = {};
    try {
      if (fs.existsSync(localConfigPath)) {
        const local = JSON.parse(fs.readFileSync(localConfigPath, "utf-8"));
        if (local?.mcpServers) {
          Object.assign(merged, local.mcpServers);
          console.log(`[agentbox] Local MCP config: ${Object.keys(local.mcpServers).length} servers`);
        }
      }
    } catch (err) {
      console.warn(`[agentbox] Failed to read local MCP config:`, err);
    }

    // 2. Gateway overlay (same name overwrites local)
    if (config.server.gatewayUrl) {
      try {
        const resp = await fetch(`${config.server.gatewayUrl}/api/internal/mcp-servers`, {
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          const remote = await resp.json() as { mcpServers?: Record<string, unknown> };
          if (remote?.mcpServers) {
            Object.assign(merged, remote.mcpServers);
            console.log(`[agentbox] Gateway MCP config: ${Object.keys(remote.mcpServers).length} servers`);
          }
        }
      } catch (err) {
        console.warn(`[agentbox] Failed to fetch MCP config from Gateway:`, err);
      }
    }

    // 3. Write merged result for loadMcpServersConfig to pick up
    const mcpDir = process.env.SICLAW_MCP_DIR || path.resolve(process.cwd(), ".siclaw", "mcp");
    if (!fs.existsSync(mcpDir)) fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(path.join(mcpDir, "mcp-servers.json"), JSON.stringify({ mcpServers: merged }, null, 2) + "\n");
    if (!process.env.SICLAW_MCP_DIR) process.env.SICLAW_MCP_DIR = mcpDir;
    // Clear config cache so loadConfig() picks up the new MCP servers
    reloadConfig();
    console.log(`[agentbox] Merged MCP config: ${Object.keys(merged).length} servers [${Object.keys(merged).join(", ")}]`);
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
