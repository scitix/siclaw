#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTicketReviewResultServer } from "./server.js";

async function main(): Promise<void> {
  await createTicketReviewResultServer().connect(new StdioServerTransport());
  process.stderr.write("[mcp-ticket-review-result] ready\n");
}

main().catch((error) => {
  process.stderr.write(`[mcp-ticket-review-result] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
