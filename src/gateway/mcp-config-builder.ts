import type { McpServerRepository } from "./db/repositories/mcp-server-repo.js";

/**
 * Build merged MCP config: local seed as base, DB overlay on top.
 * Disabled DB entries remove the corresponding local entry.
 */
export async function buildMergedMcpConfig(
  localConfig: { mcpServers?: Record<string, any> } | null | undefined,
  mcpRepo: McpServerRepository | null,
): Promise<Record<string, any>> {
  const merged: Record<string, any> = {};

  // 1. Local config as base
  if (localConfig?.mcpServers) {
    for (const [name, cfg] of Object.entries(localConfig.mcpServers)) {
      merged[name] = cfg;
    }
  }

  // 2. DB overlay (same name overwrites local; disabled removes)
  if (mcpRepo) {
    const rows = await mcpRepo.list();
    for (const row of rows) {
      if (!row.enabled) {
        delete merged[row.name];
        continue;
      }
      const cfg: Record<string, any> = {};
      if (row.transport) cfg.transport = row.transport;
      if (row.url) cfg.url = row.url;
      if (row.command) cfg.command = row.command;
      if (row.argsJson) cfg.args = row.argsJson;
      if (row.envJson) cfg.env = row.envJson;
      if (row.headersJson) cfg.headers = row.headersJson;
      merged[row.name] = cfg;
    }
  }

  return merged;
}
