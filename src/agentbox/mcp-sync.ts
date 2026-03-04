import fs from "node:fs";
import path from "node:path";
import type { GatewayClient } from "./gateway-client.js";

/**
 * Fetch MCP config from Gateway, merge with local seed, write to disk.
 * Shared by agentbox-main.ts (startup) and http-server.ts (reload endpoint).
 */
export async function syncMcpFromGateway(gatewayClient: GatewayClient): Promise<number> {
  const remoteMcp = await gatewayClient.fetchMcpServers();
  const { loadMcpServersConfig } = await import("../core/mcp-client.js");
  // Local seed as base — currently empty, but kept for future local-only MCP servers
  const localMcp = loadMcpServersConfig(undefined, { localOnly: true });
  const merged: Record<string, any> = {};
  if (localMcp?.mcpServers) Object.assign(merged, localMcp.mcpServers);
  if (remoteMcp?.mcpServers) Object.assign(merged, remoteMcp.mcpServers);

  let mcpDir = process.env.SICLAW_MCP_DIR;
  if (!mcpDir) {
    mcpDir = path.resolve(process.cwd(), ".siclaw", "mcp");
    process.env.SICLAW_MCP_DIR = mcpDir;
  }
  if (!fs.existsSync(mcpDir)) fs.mkdirSync(mcpDir, { recursive: true });
  fs.writeFileSync(
    path.resolve(mcpDir, "mcp-servers.json"),
    JSON.stringify({ mcpServers: merged }, null, 2),
    "utf-8",
  );
  return Object.keys(merged).length;
}
