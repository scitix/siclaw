#!/usr/bin/env node
import { SicoreA2aClient } from "./a2a-client.js";
import { loadConfig } from "./config.js";
import { serveStdio } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = await serveStdio(new SicoreA2aClient(config));
  process.stderr.write(
    `[sicore-a2a-mcp] ready agent=${config.agentId} endpoint=${new URL(config.baseUrl).origin}\n`,
  );

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  process.stderr.write(
    `[sicore-a2a-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
