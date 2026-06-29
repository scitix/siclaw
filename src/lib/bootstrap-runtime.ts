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

  // FrontendWsClient — persistent WS connection to Portal/Upstream
  const frontendClient = new FrontendWsClient({
    serverUrl: config.serverUrl,
    portalSecret: config.portalSecret,
    agentId: process.env.SICLAW_AGENT_ID || "runtime",
  });
  if (config.serverUrl) {
    try {
      await frontendClient.connect();
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[runtime] Failed to connect to Portal at ${config.serverUrl}: ${cause}. ` +
        `Check that Portal is running and SICLAW_SERVER_URL points at its WS endpoint.`,
      );
    }
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

  runtime.rpcMethods.set("channel.reload", async () => channelManager.reloadFromDb());

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
    // claimName identifies the shared PVC the deployer actually created — its name
    // differs per deployment, so there is NO hardcoded default. It is "available"
    // only when explicitly configured (helm opt or SICLAW_PERSISTENCE_CLAIM_NAME).
    const claimName = opts.k8sPersistenceClaimName ?? process.env.SICLAW_PERSISTENCE_CLAIM_NAME;
    const globalEnabled = process.env.SICLAW_PERSISTENCE_ENABLED === "true";
    // Behaviour change vs the old hardcoded "siclaw-data" default: a raw-env
    // deploy that set only SICLAW_PERSISTENCE_ENABLED=true (no claim name) now
    // silently degrades to emptyDir instead of binding a PVC named "siclaw-data".
    // Warn once at startup so that regression is visible (Helm always injects the
    // claim name when a PVC is available, so chart users never hit this).
    if (globalEnabled && !claimName) {
      console.warn(
        "[runtime] SICLAW_PERSISTENCE_ENABLED=true but SICLAW_PERSISTENCE_CLAIM_NAME is unset — " +
        "persistence falls back to emptyDir (no shared PVC mounted; session/memory will NOT survive pod restarts)",
      );
    }
    // Decouple infrastructure (claimName: is a shared PVC available?) from policy
    // (enabled: the global default for callers that don't specify per-agent).
    // Pass claimName whenever it's configured — so a per-agent opt-in
    // (boxConfig.persistence, e.g. from an external portal) can mount the PVC even
    // when the global flag is off. The spawner gates the actual mount on claimName,
    // so when it's absent persistence simply degrades to emptyDir.
    // Optional node scheduling constraint for spawned AgentBox pods. Passed as a
    // JSON object map via env (Helm renders agentbox.nodeSelector with toJson).
    // Malformed JSON is ignored with a warning rather than crashing startup.
    const nodeSelector = parseNodeSelector(process.env.SICLAW_AGENTBOX_NODE_SELECTOR);

    return new K8sSpawner({
      namespace,
      image,
      persistence: claimName ? { enabled: globalEnabled, claimName } : undefined,
      nodeSelector,
    });
  }
  if (kind === "process") return new ProcessSpawner();
  return new LocalSpawner(certManager, `https://127.0.0.1:${config.internalPort}`, 4000);
}

/**
 * Parse the SICLAW_AGENTBOX_NODE_SELECTOR env var into a label map.
 *
 * Expects a JSON object of string→string labels (e.g. {"disktype":"ssd"}).
 * Returns undefined for empty/unset input or anything that isn't a flat
 * string-valued object, warning once so misconfiguration is visible without
 * crashing runtime startup.
 */
function parseNodeSelector(raw: string | undefined): Record<string, string> | undefined {
  if (!raw || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(
      `[runtime] SICLAW_AGENTBOX_NODE_SELECTOR is not valid JSON — ignoring (got: ${raw})`,
    );
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn(
      "[runtime] SICLAW_AGENTBOX_NODE_SELECTOR must be a JSON object of string labels — ignoring",
    );
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      console.warn(
        `[runtime] SICLAW_AGENTBOX_NODE_SELECTOR label "${key}" is not a string — ignoring that entry`,
      );
      continue;
    }
    result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
