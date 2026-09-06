#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createProductSupportResultServer } from "./server.js";

async function main(): Promise<void> {
  const server = createProductSupportResultServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-product-support-result] ready\n");
}

main().catch((error) => {
  process.stderr.write(
    `[mcp-product-support-result] fatal: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
