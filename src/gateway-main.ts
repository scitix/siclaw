/**
 * Siclaw Agent Runtime — Entry point.
 *
 * Stateless process that manages AgentBox lifecycle and proxies
 * between Upstream backend and AgentBox pods.
 */

import { loadRuntimeConfig } from "./gateway/config.js";
import { startRuntime } from "./gateway/server.js";
import { AgentBoxManager, K8sSpawner, ProcessSpawner, LocalSpawner } from "./gateway/agentbox/index.js";
import { initDb, closeDb } from "./gateway/db.js";
import { runMigrations } from "./gateway/migrate.js";
import { syncBuiltinSkills } from "./gateway/skills/builtin-sync.js";
import { ChannelManager } from "./gateway/channel-manager.js";
import { CronCoordinator } from "./gateway/cron-coordinator.js";

// Parse arguments
const args = process.argv.slice(2);
const useK8s = args.includes("--k8s");
const useProcess = args.includes("--process");

// Load config
const config = loadRuntimeConfig();
console.log(`[runtime] Config: port=${config.port} internalPort=${config.internalPort} host=${config.host}`);
console.log(`[runtime] Server URL: ${config.serverUrl}`);

if (!config.runtimeSecret) {
  console.warn("[runtime] WARNING: SICLAW_RUNTIME_SECRET not set — WS connections will be rejected");
}

// Initialize MySQL connection pool
if (config.databaseUrl) {
  initDb(config.databaseUrl);
  await runMigrations();
  // TODO: use config.orgId if available; defaulting to "default" for now
  await syncBuiltinSkills("default");
  console.log("[runtime] Database ready");
}

// Create Spawner
const spawner = useK8s
  ? new K8sSpawner({
      namespace: process.env.SICLAW_K8S_NAMESPACE || "default",
      image: process.env.SICLAW_AGENTBOX_IMAGE || "siclaw-agentbox:latest",
      persistence: process.env.SICLAW_PERSISTENCE_ENABLED === "true"
        ? {
            enabled: true,
            claimName: process.env.SICLAW_PERSISTENCE_CLAIM_NAME || "siclaw-data",
          }
        : undefined,
    })
  : useProcess
    ? new ProcessSpawner()
    : new LocalSpawner(4000);

console.log(`[runtime] Using spawner: ${spawner.name}`);

// Create AgentBox Manager
const agentBoxManager = new AgentBoxManager(spawner, {
  namespace: process.env.SICLAW_K8S_NAMESPACE || "default",
});
agentBoxManager.startHealthCheck();

// Start Runtime
const runtime = await startRuntime({
  config,
  agentBoxManager,
  spawner,
});

// Boot channel integrations (Lark, etc.) from DB
const channelManager = new ChannelManager(
  agentBoxManager,
  runtime.agentBoxTlsOptions,
  config,
);
await channelManager.bootFromDb();

// Boot cron coordinator — schedules active jobs and syncs with DB
const cronCoordinator = new CronCoordinator({
  agentBoxManager,
  agentBoxTlsOptions: runtime.agentBoxTlsOptions,
});
if (config.databaseUrl) {
  await cronCoordinator.start();
}

// Graceful shutdown
async function shutdown() {
  console.log("\n[runtime] Shutting down...");
  cronCoordinator.stop();
  await channelManager.stopAll();
  await runtime.close();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
