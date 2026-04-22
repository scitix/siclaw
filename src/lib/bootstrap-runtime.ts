/**
 * Runtime bootstrap — assembles spawner, AgentBoxManager, FrontendWsClient,
 * credential service, cert manager, Runtime HTTP server, ChannelManager,
 * and TaskCoordinator. Shared by `gateway-main.ts` (prod) and
 * `cli-local.ts` (local single-process).
 */

import type { RuntimeConfig } from "../gateway/config.js";
import { startRuntime, type RuntimeServer } from "../gateway/server.js";
import {
  AgentBoxManager,
  K8sSpawner,
  ProcessSpawner,
  LocalSpawner,
} from "../gateway/agentbox/index.js";
import { ChannelManager } from "../gateway/channel-manager.js";
import { TaskCoordinator } from "../gateway/task-coordinator.js";
import { createCredentialService } from "../gateway/credential-service.js";
import { FrontendWsClient } from "../gateway/frontend-ws-client.js";
import { initChatRepo } from "../gateway/chat-repo.js";
import { CertificateManager } from "../gateway/security/cert-manager.js";

export type SpawnerKind = "local" | "process" | "k8s";

export interface BootstrapRuntimeOptions {
  config: RuntimeConfig;
  spawnerKind: SpawnerKind;
  /** Retention window for agent_task_runs rows. 0 = keep forever. */
  retentionDays?: number;
  /** K8s-only: namespace for AgentBox pods. */
  k8sNamespace?: string;
  /** K8s-only: container image for AgentBox pods. */
  k8sImage?: string;
  /** K8s-only: persistent volume claim for shared agent data. */
  k8sPersistenceClaimName?: string;
}

export interface RuntimeHandle {
  runtime: RuntimeServer;
  close(): Promise<void>;
}

export async function bootstrapRuntime(opts: BootstrapRuntimeOptions): Promise<RuntimeHandle> {
  const { config, spawnerKind } = opts;
  console.log(`[runtime] Config: port=${config.port} internalPort=${config.internalPort} host=${config.host}`);
  console.log(`[runtime] Server URL: ${config.serverUrl}`);

  if (!config.runtimeSecret) {
    console.warn("[runtime] WARNING: SICLAW_RUNTIME_SECRET not set — WS connections will be rejected");
  }

  // FrontendWsClient — persistent WS connection to Portal/Upstream
  const frontendClient = new FrontendWsClient({
    serverUrl: config.serverUrl,
    portalSecret: config.portalSecret,
    agentId: process.env.SICLAW_AGENT_ID || "runtime",
  });
  if (config.serverUrl) {
    await frontendClient.connect();
  }

  initChatRepo(frontendClient);
  const credentialService = createCredentialService(frontendClient);

  // CertManager shared with LocalSpawner (in K8s mode, startRuntime()
  // would build its own, but sharing avoids duplicate CA state).
  const certManager = await CertificateManager.create();

  // Create Spawner
  const spawner = createSpawner(spawnerKind, certManager, config, opts);
  console.log(`[runtime] Using spawner: ${spawner.name}`);

  const k8sNamespace = opts.k8sNamespace ?? process.env.SICLAW_K8S_NAMESPACE ?? "default";
  const agentBoxManager = new AgentBoxManager(spawner, { namespace: k8sNamespace });
  agentBoxManager.startHealthCheck();

  const runtime = await startRuntime({
    config,
    agentBoxManager,
    spawner,
    frontendClient,
    credentialService,
    certManager,
  });

  const channelManager = new ChannelManager(
    agentBoxManager,
    runtime.agentBoxTlsOptions,
    frontendClient,
  );
  await channelManager.bootFromDb();

  const retentionDays = Math.max(
    0,
    opts.retentionDays ?? (parseInt(process.env.SICLAW_RUN_RETENTION_DAYS ?? "90", 10) || 0),
  );
  const taskCoordinator = new TaskCoordinator({
    config,
    frontendClient,
    agentBoxManager,
    agentBoxTlsOptions: runtime.agentBoxTlsOptions,
    retentionDays,
    onTaskCompleted: config.serverUrl
      ? (evt) => {
          const displayName = evt.taskName || evt.taskId.slice(0, 8);
          const title =
            evt.status === "success"
              ? `Task "${displayName}" completed`
              : `Task "${displayName}" failed`;
          const message = evt.error ?? evt.resultText?.slice(0, 500) ?? null;
          frontendClient
            .request("task.notify", {
              userId: evt.userId,
              agentId: evt.agentId,
              taskId: evt.taskId,
              runId: evt.runId,
              status: evt.status,
              title,
              message,
              durationMs: evt.durationMs,
            })
            .catch((err) => {
              console.warn(
                `[runtime] task-notify RPC failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
      : undefined,
  });
  if (config.serverUrl) {
    await taskCoordinator.start();
  }

  runtime.rpcMethods.set("task.fireNow", async (params) => {
    const taskId = params.taskId as string;
    if (!taskId) throw new Error("taskId required");
    return taskCoordinator.fireNow(taskId);
  });

  return {
    runtime,
    async close() {
      taskCoordinator.stop();
      await channelManager.stopAll();
      await runtime.close();
    },
  };
}

function createSpawner(
  kind: SpawnerKind,
  certManager: CertificateManager,
  config: RuntimeConfig,
  opts: BootstrapRuntimeOptions,
) {
  if (kind === "k8s") {
    const image = opts.k8sImage ?? process.env.SICLAW_AGENTBOX_IMAGE ?? "siclaw-agentbox:latest";
    const namespace = opts.k8sNamespace ?? process.env.SICLAW_K8S_NAMESPACE ?? "default";
    const claimName =
      opts.k8sPersistenceClaimName ?? process.env.SICLAW_PERSISTENCE_CLAIM_NAME ?? "siclaw-data";
    return new K8sSpawner({
      namespace,
      image,
      persistence:
        process.env.SICLAW_PERSISTENCE_ENABLED === "true"
          ? { enabled: true, claimName }
          : undefined,
    });
  }
  if (kind === "process") return new ProcessSpawner();
  return new LocalSpawner(certManager, `https://127.0.0.1:${config.internalPort}`, 4000);
}
