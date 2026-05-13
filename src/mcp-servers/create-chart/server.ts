/**
 * create-chart MCP server — stdio transport, exposes a single `render_chart`
 * tool that emits a JSON chart spec wrapped in a ```chart fenced markdown
 * code block. The Portal frontend detects that block and renders an SVG
 * client-side via React (theme-aware, dark-mode-aware).
 *
 * Configure in .siclaw/config/settings.json:
 *
 *   "mcpServers": {
 *     "create-chart": {
 *       "transport": "stdio",
 *       "command": "node",
 *       "args": ["./dist/mcp-servers/create-chart/server.js"],
 *       "env": {
 *         "CREATE_CHART_ARTIFACT_DIR": ".siclaw/user-data/tool-results/create-chart"
 *       }
 *     }
 *   }
 *
 * The CREATE_CHART_ARTIFACT_DIR env var is optional; the spec is also saved
 * to disk as a best-effort artifact for debugging.
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
        return await handleRenderChart(req.params.arguments ?? {});
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
