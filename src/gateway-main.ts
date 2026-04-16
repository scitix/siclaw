/**
 * Siclaw Agent Runtime — Entry point.
 *
 * Stateless process that manages AgentBox lifecycle and proxies
 * between Upstream backend and AgentBox pods.
 */

import { loadRuntimeConfig } from "./gateway/config.js";
import { startRuntime } from "./gateway/server.js";
import { AgentBoxManager, K8sSpawner, ProcessSpawner, LocalSpawner } from "./gateway/agentbox/index.js";
import { ChannelManager } from "./gateway/channel-manager.js";
import { TaskCoordinator } from "./gateway/task-coordinator.js";
import { createCredentialService } from "./gateway/credential-service.js";
import { FrontendWsClient } from "./gateway/frontend-ws-client.js";
import { initChatRepo } from "./gateway/chat-repo.js";

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

// Runtime no longer accesses the database directly — all persistence
// goes through Portal via FrontendWsClient RPC.

// ── FrontendWsClient — persistent WS connection to Portal ───
const frontendClient = new FrontendWsClient({
  serverUrl: config.serverUrl,
  portalSecret: config.portalSecret,
  agentId: process.env.SICLAW_AGENT_ID || "runtime",
});

if (config.serverUrl) {
  await frontendClient.connect();
}

// Initialize chat-repo module with WS client
initChatRepo(frontendClient);

// Credential service — used by mTLS credential-proxy on port 3002.
const credentialService = createCredentialService(frontendClient);

// CertManager — needed early for LocalSpawner to sign agentbox certs.
// In K8s mode, startRuntime() creates its own; here we create it once and share.
import { CertificateManager } from "./gateway/security/cert-manager.js";
const certManager = await CertificateManager.create();

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
    : new LocalSpawner(certManager, `https://127.0.0.1:${config.internalPort}`, 4000);

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
  frontendClient,
  credentialService,
  certManager,
});

// Boot channel integrations (Lark, etc.) via RPC
const channelManager = new ChannelManager(
  agentBoxManager,
  runtime.agentBoxTlsOptions,
  frontendClient,
);
await channelManager.bootFromDb();

// Scheduled-task coordinator — owns agent_tasks scheduler + execution.
// Config writes from any source (UI REST, chat manage_schedule tool) land in
// agent_tasks; this coordinator syncs via RPC every 15s and fires runs via
// AgentBoxClient directly. Task completion events are forwarded via
// FrontendWsClient RPC.
const retentionDays = Math.max(0, parseInt(process.env.SICLAW_RUN_RETENTION_DAYS ?? "90", 10) || 0);
const taskCoordinator = new TaskCoordinator({
  config,
  frontendClient,
  agentBoxManager,
  agentBoxTlsOptions: runtime.agentBoxTlsOptions,
  retentionDays,
  // Best-effort fire-and-forget: if Portal is down or rejects, this fire's
  // notification is lost. Acceptable for a low-frequency task-alert channel
  // — the run record is already durable in agent_task_runs so users can
  // still find the result through the UI.
  onTaskCompleted: config.serverUrl
    ? (evt) => {
        const displayName = evt.taskName || evt.taskId.slice(0, 8);
        const title = evt.status === "success"
          ? `Task "${displayName}" completed`
          : `Task "${displayName}" failed`;
        const message = evt.error ?? evt.resultText?.slice(0, 500) ?? null;
        frontendClient.request("task.notify", {
          userId: evt.userId,
          agentId: evt.agentId,
          taskId: evt.taskId,
          runId: evt.runId,
          status: evt.status,
          title,
          message,
        }).catch((err) => {
          console.warn(`[runtime] task-notify RPC failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    : undefined,
});
if (config.serverUrl) {
  await taskCoordinator.start();
}

// Register task.fireNow RPC — called by Portal/Upstream to trigger manual task execution
runtime.rpcMethods.set("task.fireNow", async (params) => {
  const taskId = params.taskId as string;
  if (!taskId) throw new Error("taskId required");
  return taskCoordinator.fireNow(taskId);
});

// Graceful shutdown
async function shutdown() {
  console.log("\n[runtime] Shutting down...");
  taskCoordinator.stop();
  await channelManager.stopAll();
  await runtime.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
