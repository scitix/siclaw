import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseTicketReviewResult, resultSchema } from "./result.js";

export const TOOL_NAME = "submit_ticket_review_result";

export function createTicketReviewResultServer(): Server {
  const server = new Server(
    { name: "mcp-ticket-review-result", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: TOOL_NAME,
      description: "Validate and return one post-closure ticket review draft. First classify the ticket, then summarize its evidence-based cause or actual disposition. Submit exactly one successful result per task; correct rejected arguments and retry. Maximum serialized result: 24576 UTF-8 bytes. This tool neither reads nor writes tickets and cannot verify the cited content.",
      inputSchema: resultSchema,
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    }],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== TOOL_NAME) {
      return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
    }
    try {
      const result = parseTicketReviewResult(request.params.arguments);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      // MCP request boundary: expose validation failures so the agent can correct them.
      return {
        content: [{ type: "text", text: `Invalid ticket review result: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });
  return server;
}
