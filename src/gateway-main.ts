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
import { TaskCoordinator } from "./gateway/task-coordinator.js";
import { createCredentialService } from "./gateway/credential-service.js";

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

// Credential service — shared by startRuntime (for mTLS handlers) and
// LocalSpawner (for in-process DirectCallTransport). Must exist before spawner
// accepts any spawn calls.
const credentialService = createCredentialService(config);

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
    : new LocalSpawner(credentialService, 4000);

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
  credentialService,
});

// Boot channel integrations (Lark, etc.) from DB
const channelManager = new ChannelManager(
  agentBoxManager,
  runtime.agentBoxTlsOptions,
  config,
);
await channelManager.bootFromDb();

// Scheduled-task coordinator — owns agent_tasks scheduler + execution.
// Config writes from any source (UI REST, chat manage_schedule tool) land in
// agent_tasks; this coordinator syncs from DB every 60s and fires runs via
// AgentBoxClient directly. Task completion events are forwarded to the
// upstream notification endpoint (Portal stand-in today, upstream eventually)
// via POST to /api/internal/task-notify.
const notifyUrl = config.serverUrl
  ? `${config.serverUrl.replace(/\/$/, "")}/api/internal/task-notify`
  : "";
const portalSecret = config.portalSecret;

const retentionDays = Math.max(0, parseInt(process.env.SICLAW_RUN_RETENTION_DAYS ?? "90", 10) || 0);
const taskCoordinator = new TaskCoordinator({
  agentBoxManager,
  agentBoxTlsOptions: runtime.agentBoxTlsOptions,
  retentionDays,
  // Best-effort fire-and-forget: if Portal is down or rejects, this fire's
  // notification is lost. Acceptable for a low-frequency task-alert channel
  // — the run record is already durable in agent_task_runs so users can
  // still find the result through the UI. If notifications ever become
  // load-bearing (SLA / paging) switch this to a retry queue.
  onTaskCompleted: notifyUrl && portalSecret
    ? (evt) => {
        const displayName = evt.taskName || evt.taskId.slice(0, 8);
        const title = evt.status === "success"
          ? `Task "${displayName}" completed`
          : `Task "${displayName}" failed`;
        const message = evt.error ?? evt.resultText?.slice(0, 500) ?? null;
        fetch(notifyUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Auth-Token": portalSecret },
          body: JSON.stringify({
            userId: evt.userId,
            agentId: evt.agentId,
            taskId: evt.taskId,
            runId: evt.runId,
            status: evt.status,
            title,
            message,
          }),
        }).catch((err) => {
          console.warn(`[runtime] task-notify post failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    : undefined,
});
if (config.databaseUrl) {
  await taskCoordinator.start();
}

// Late-attach the Run-now handler to the REST routes registered inside
// startRuntime. Route handlers read `ctx.fireTaskNow` at request time, so
// assigning it after registerSiclawRoutes has already been called is safe.
runtime.siclawCtx.fireTaskNow = (taskId) => taskCoordinator.fireNow(taskId);

// Graceful shutdown
async function shutdown() {
  console.log("\n[runtime] Shutting down...");
  taskCoordinator.stop();
  await channelManager.stopAll();
  await runtime.close();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
