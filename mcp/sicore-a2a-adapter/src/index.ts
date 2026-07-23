#!/usr/bin/env node
import { resolveAgentId, SicoreA2aClient } from "./a2a-client.js";
import { loadConfig, type AdapterConfig, type NamedKey } from "./config.js";
import { AgentRouter, type AgentEntry } from "./router.js";
import { serveStdio } from "./server.js";

async function buildEntry(config: AdapterConfig, key: NamedKey): Promise<AgentEntry> {
  const shared = {
    baseUrl: config.baseUrl,
    apiKey: key.apiKey,
    requestTimeoutMs: config.requestTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
  };
  let agentId: string;
  try {
    agentId = key.agentId ?? await resolveAgentId(shared);
  } catch (error) {
    // Prefix with the alias (never the key) so the operator knows which entry failed.
    throw new Error(`agent "${key.alias}": ${error instanceof Error ? error.message : String(error)}`);
  }
  const client = new SicoreA2aClient({ ...shared, agentId });
  return { alias: key.alias, agentId, api: client };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const entries: AgentEntry[] = [];
  for (const key of config.keys) {
    entries.push(await buildEntry(config, key));
  }
  const router = new AgentRouter(entries);
  const server = await serveStdio(router);

  const agentList = entries.map((entry) => `${entry.alias}=${entry.agentId}`).join(", ");
  const resolvedFromKey = config.keys.some((key) => !key.agentId);
  process.stderr.write(
    `[sicore-a2a-mcp] ready endpoint=${new URL(config.baseUrl).origin} agents=[${agentList}]`
    + `${resolvedFromKey ? " (some agents resolved from key)" : ""}\n`,
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
