import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createTicketReviewResultServer, TOOL_NAME } from "./server.js";
import { drafts } from "../test/fixtures.js";

async function withClient(run: (client: Client) => Promise<void>): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createTicketReviewResultServer();
  const client = new Client({ name: "ticket-review-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { await run(client); }
  finally { await client.close(); await server.close(); }
}

describe("ticket review MCP", () => {
  it("advertises one independent tool and roundtrips all six drafts", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([TOOL_NAME]);
      expect(tools[0].outputSchema).toEqual(tools[0].inputSchema);
      for (const draft of drafts) {
        const response = await client.callTool({ name: TOOL_NAME, arguments: draft }, CallToolResultSchema);
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toEqual(draft);
        expect(response.content).toEqual([{ type: "text", text: JSON.stringify(draft) }]);
      }
    });
  });

  it("rejects invalid and unknown calls without a result, then accepts a correction", async () => {
    await withClient(async (client) => {
      await client.listTools();
      for (const call of [
        { name: TOOL_NAME, arguments: { ...drafts[0], evidence: [] } },
        { name: TOOL_NAME, arguments: { ...drafts[0], result: "x".repeat(25000) } },
        { name: TOOL_NAME, arguments: {} },
        { name: "submit_product_support_result", arguments: { label: true, info: {} } },
      ]) {
        const response = await client.callTool(call, CallToolResultSchema);
        expect(response.isError).toBe(true);
        expect(response.structuredContent).toBeUndefined();
      }
      const corrected = await client.callTool({ name: TOOL_NAME, arguments: drafts[5] }, CallToolResultSchema);
      expect(corrected.structuredContent).toEqual(drafts[5]);
    });
  });
});
