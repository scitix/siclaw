import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { McpClientManager, type McpServersConfig } from "./mcp-client.js";

/** A sandbox-only selection must also gate dynamic tools outside the registry. */
export async function resolveSessionMcpTools(options: {
  enabled?: boolean;
  allowedTools?: string[] | null;
  mcpServers?: Record<string, unknown>;
  mcpManager?: McpClientManager;
  mcpTools?: ToolDefinition[];
}): Promise<{ mcpManager?: McpClientManager; mcpTools: ToolDefinition[] }> {
  const { allowedTools, mcpServers } = options;
  if (options.enabled === false || (allowedTools?.length && allowedTools.every(name => name === "run_script"))) {
    // Do not connect even for discovery: bindings authorize the sandbox broker,
    // whose operator-reviewed operation/argument policy must remain in charge.
    return { mcpTools: [] };
  }
  // Other agents retain the existing independent MCP-binding authorization.
  if (options.mcpManager) return { mcpManager: options.mcpManager, mcpTools: options.mcpTools ?? options.mcpManager.getTools() };
  if (!mcpServers || !Object.keys(mcpServers).length) return { mcpTools: [] };
  const mcpManager = new McpClientManager({ mcpServers } as McpServersConfig);
  try {
    await mcpManager.initialize();
    return { mcpManager, mcpTools: mcpManager.getTools() };
  } catch {
    await mcpManager.shutdown().catch(() => {});
    console.warn("[agent-factory] MCP initialization failed");
    return { mcpTools: [] };
  }
}
