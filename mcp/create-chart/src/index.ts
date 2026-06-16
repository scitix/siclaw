#!/usr/bin/env node
/**
 * create-chart MCP server — stdio transport, exposes a single `render_chart`
 * tool that emits a JSON chart spec wrapped in a ```chart fenced markdown
 * code block. The Portal frontend detects that block and renders an SVG
 * client-side via React (theme-aware, dark-mode-aware).
 *
 * Packaged as a standalone npm package; Dockerfile.agentbox builds it via
 * mcp/MCP_LIST.txt and symlinks dist/index.js to /usr/local/bin/mcp-create-chart.
 * Portal MCP config:
 *
 *   "mcpServers": {
 *     "create-chart": {
 *       "transport": "stdio",
 *       "command": "mcp-create-chart"
 *     }
 *   }
 *
 * CREATE_CHART_ARTIFACT_DIR (optional) controls where the JSON spec is
 * persisted as a best-effort debugging artifact.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  RENDER_CHART_DESCRIPTION,
  RENDER_CHART_INPUT_SCHEMA,
  handleRenderChart,
} from "./handler.js";

async function main(): Promise<void> {
  const server = new Server(
    { name: "mcp-create-chart", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "render_chart",
        description: RENDER_CHART_DESCRIPTION,
        inputSchema: RENDER_CHART_INPUT_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      if (req.params.name === "render_chart") {
        return await handleRenderChart(req.params.arguments ?? {}) as any;
      }
      throw new Error(`Unknown tool: ${req.params.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: msg }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-create-chart] ready\n");
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((err) => {
  process.stderr.write(
    `[mcp-create-chart] fatal: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
