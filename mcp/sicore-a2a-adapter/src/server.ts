import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { SiclawA2aApi } from "./a2a-client.js";
import { createToolHandler, TOOL_DEFINITIONS } from "./tools.js";

export const SERVER_INSTRUCTIONS = [
  "Use siclaw_investigate for operational questions that require the configured Siclaw SRE agent.",
  "When it returns a non-terminal task, keep the current turn open and call siclaw_wait_task with the same task_id until terminal, unless the user requests fire-and-forget, asks to stop, or the overall investigation deadline is exhausted.",
  "Never resubmit the same question merely because a task is still working.",
  "Use siclaw_list_tasks to recover server-side tasks after a client restart.",
].join(" ");

export function createMcpServer(api: SiclawA2aApi): Server {
  const server = new Server(
    { name: "sicore-a2a-mcp-adapter", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const handleTool = createToolHandler(api);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOL_DEFINITIONS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => (
    await handleTool(request.params.name, request.params.arguments ?? {}) as any
  ));
  return server;
}

export async function serveStdio(api: SiclawA2aApi): Promise<Server> {
  const server = createMcpServer(api);
  await server.connect(new StdioServerTransport());
  return server;
}
