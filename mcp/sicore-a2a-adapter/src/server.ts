import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentRouter } from "./router.js";
import { buildToolDefinitions, createToolHandler } from "./tools.js";

const BASE_INSTRUCTIONS = [
  "Use siclaw_investigate for operational questions that require the configured Siclaw SRE agent.",
  "When it returns a non-terminal task, keep the current turn open and call siclaw_wait_task with the same task_id until terminal, unless the user requests fire-and-forget, asks to stop, or the overall investigation deadline is exhausted.",
  "Never resubmit the same question merely because a task is still working.",
  "Use siclaw_list_tasks to recover server-side tasks after a client restart.",
];

export function buildInstructions(router: AgentRouter): string {
  const lines = [...BASE_INSTRUCTIONS];
  if (!router.isSingle) {
    lines.push(
      `Multiple Siclaw agents are configured; pass the "agent" argument (an alias, never a key) to choose one: ${router.describeAgents()}.`,
      "Task waits, snapshots, and cancels auto-route to the agent that created the task, so you usually only need \"agent\" on siclaw_investigate.",
    );
  }
  return lines.join(" ");
}

export function createMcpServer(router: AgentRouter): Server {
  const server = new Server(
    { name: "sicore-a2a-mcp-adapter", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: buildInstructions(router) },
  );
  const handleTool = createToolHandler(router);
  const tools = buildToolDefinitions(router);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => (
    await handleTool(request.params.name, request.params.arguments ?? {}) as any
  ));
  return server;
}

export async function serveStdio(router: AgentRouter): Promise<Server> {
  const server = createMcpServer(router);
  await server.connect(new StdioServerTransport());
  return server;
}
