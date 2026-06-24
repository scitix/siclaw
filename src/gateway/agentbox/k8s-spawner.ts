/**
 * K8s Pod Spawner
 *
 * Creates and manages AgentBox Pods via the Kubernetes API.
 */

import * as k8s from "@kubernetes/client-node";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BoxSpawner } from "./spawner.js";
import type { AgentBoxConfig, AgentBoxHandle, AgentBoxInfo, AgentBoxStatus } from "./types.js";
import { CertificateManager } from "../security/cert-manager.js";

export interface K8sSpawnerConfig {
  /** K8s namespace */
  namespace?: string;
  /** AgentBox image */
  image?: string;
  /** Image pull policy */
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  /** Pod label prefix */
  labelPrefix?: string;
  /** Shared PVC for user data persistence (memory, sessions).
   *  Gateway creates per-user subdirectories; AgentBox pods mount via subPath. */
  persistence?: {
    enabled: boolean;
    /** Name of the pre-existing shared PVC (e.g. "siclaw-data") */
    claimName: string;
  };
}

const DEFAULT_CONFIG: Required<Omit<K8sSpawnerConfig, "persistence">> = {
  namespace: "default",
  image: "siclaw-agentbox:latest",
  imagePullPolicy: "Always",
  labelPrefix: "siclaw.io",
};

export class K8sSpawner implements BoxSpawner {
  readonly name = "k8s";

  private kc: k8s.KubeConfig;
  private coreApi: k8s.CoreV1Api;
  private config: Required<Omit<K8sSpawnerConfig, "persistence">> & Pick<K8sSpawnerConfig, "persistence">;
  private certManager: CertificateManager | null = null;

  constructor(config?: K8sSpawnerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Load kubeconfig
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();

    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
  }

  /** Inject CertificateManager after DB initialization */
  setCertManager(cm: CertificateManager): void {
    this.certManager = cm;
  }

  /**
   * Generate Pod name — keyed on agentId only (one pod per agent, shared
   * across callers). Sanitized to the K8s name charset and capped so the
   * full name stays under 63 chars.
   */
  private podName(agentId: string): string {
    const sanitized = agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
    return `agentbox-${sanitized}`;
  }

  private gatewayUrl(namespace: string): string {
    if (process.env.SICLAW_GATEWAY_INTERNAL_URL) {
      return process.env.SICLAW_GATEWAY_INTERNAL_URL;
    }

    if (process.env.SICLAW_GATEWAY_HOSTNAME) {
      const port = process.env.SICLAW_INTERNAL_PORT || "3002";
      return `https://${process.env.SICLAW_GATEWAY_HOSTNAME}:${port}`;
    }

    return `https://siclaw-runtime.${namespace}.svc.cluster.local:3002`;
  }

  /**
   * Create an AgentBox Pod
   */
  async spawn(boxConfig: AgentBoxConfig): Promise<AgentBoxHandle> {
    const { namespace, image, imagePullPolicy, labelPrefix } = this.config;
    const agentId = boxConfig.agentId;
    if (!agentId) throw new Error("K8sSpawner.spawn requires a non-empty agentId");
    const podName = this.podName(agentId);
    const orgId = boxConfig.orgId || "";

    console.log(`[k8s-spawner] Creating pod: ${podName} for agent: ${agentId}`);

    // Stamp the pod + its cert Secret with the CA fingerprint. The runtime uses
    // it to detect pods whose mTLS cert was signed by a rotated CA (those can no
    // longer complete mTLS in either direction) and recycle them — see the reuse
    // branch below and AgentBoxManager.getOrCreateK8s.
    if (!this.certManager) throw new Error("CertificateManager not initialized — call setCertManager() first");
    const caFp = this.certManager.caFingerprint();
    const caFpLabel = `${labelPrefix}/ca-fp`;

    // Clean up any existing pod in non-running state (Failed, Succeeded, Error)
    // so we can recreate with the same name
    try {
      const existing = await this.coreApi.readNamespacedPod({ name: podName, namespace });
      const phase = existing.status?.phase;
      if (phase === "Failed" || phase === "Succeeded" || phase === "Unknown") {
        console.log(`[k8s-spawner] Removing stale pod ${podName} (phase: ${phase})`);
        await this.coreApi.deleteNamespacedPod({ name: podName, namespace });
        // Wait for pod to be fully deleted
        await this.waitForPodDeleted(podName, namespace);
      } else if (phase === "Running" || phase === "Pending") {
        const podFp = existing.metadata?.labels?.[caFpLabel];
        if (podFp === caFp) {
          console.log(`[k8s-spawner] Pod ${podName} already exists (phase: ${phase}), reusing`);
          const endpoint = await this.waitForPodReady(podName, namespace);
          return { boxId: podName, agentId, endpoint };
        }
        // CA fingerprint mismatch (or an unlabeled legacy pod): the pod's mTLS
        // cert was signed by a different/rotated CA, so the runtime can no
        // longer talk to it. Recycle it instead of returning a dead endpoint.
        console.log(`[k8s-spawner] Pod ${podName} has stale CA (pod=${podFp ?? "none"}, current=${caFp}); recreating`);
        await this.coreApi.deleteNamespacedPod({ name: podName, namespace });
        await this.waitForPodDeleted(podName, namespace);
      }
    } catch (err: any) {
      if (err.code !== 404 && err.statusCode !== 404) {
        throw err;
      }
      // Pod doesn't exist, proceed to create
    }

    // Issue client certificate for mTLS authentication.
    const certBundle = this.certManager.issueAgentBoxCertificate(agentId, orgId, podName);
    const certSecretName = `${podName}-cert`;

    // Create certificate Secret
    const secretLabels = {
      [`${labelPrefix}/app`]: "agentbox",
      [`${labelPrefix}/agent`]: agentId,
      [caFpLabel]: caFp,
    };
    try {
      await this.coreApi.createNamespacedSecret({
        namespace,
        body: {
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: certSecretName, labels: secretLabels },
          type: "kubernetes.io/tls",
          data: {
            "tls.crt": Buffer.from(certBundle.cert).toString("base64"),
            "tls.key": Buffer.from(certBundle.key).toString("base64"),
            "ca.crt": Buffer.from(certBundle.ca).toString("base64"),
          },
        },
      });
      console.log(`[k8s-spawner] Created certificate Secret ${certSecretName}`);
    } catch (err: any) {
      if (err.code === 409 || err.statusCode === 409) {
        // Secret exists with stale cert — replace it
        await this.coreApi.deleteNamespacedSecret({ name: certSecretName, namespace });
        await this.coreApi.createNamespacedSecret({
          namespace,
          body: {
            apiVersion: "v1",
            kind: "Secret",
            metadata: { name: certSecretName, labels: secretLabels },
            type: "kubernetes.io/tls",
            data: {
              "tls.crt": Buffer.from(certBundle.cert).toString("base64"),
              "tls.key": Buffer.from(certBundle.key).toString("base64"),
              "ca.crt": Buffer.from(certBundle.ca).toString("base64"),
            },
          },
        });
        console.log(`[k8s-spawner] Replaced certificate Secret ${certSecretName}`);
      } else {
        throw err;
      }
    }

    // Environment variables — only bootstrap deps that cannot come from settings.json
    const env: k8s.V1EnvVar[] = [
      { name: "PI_CODING_AGENT_DIR", value: ".siclaw/user-data/agent" },
      { name: "SICLAW_GATEWAY_URL", value: this.gatewayUrl(namespace) },
      { name: "SICLAW_AGENT_ID", value: agentId },
    ];
    if (process.env.SICLAW_MEMORY_ENABLED !== undefined) {
      env.push({ name: "SICLAW_MEMORY_ENABLED", value: process.env.SICLAW_MEMORY_ENABLED });
    }

    // Forward agentbox-relevant runtime knobs into the agentbox pod. The agentbox
    // runs in its own pod and does NOT inherit the runtime process env, yet this
    // flag is read inside the agentbox (sub-agent fan-out limiter, design §3).
    // Curated allowlist only — never forward arbitrary env. Set the value on the
    // runtime deployment to control every agentbox it spawns.
    const AGENTBOX_FORWARDED_ENV = [
      "SICLAW_SUBAGENT_CONCURRENCY",
      // Embedding endpoint for the memory indexer. The agentbox reads these via
      // loadConfig() env overrides (config.ts); set on the runtime deployment to
      // configure every agentbox it spawns. API key is optional (TEI-style
      // self-hosted endpoints are usually unauthenticated).
      "SICLAW_EMBEDDING_BASE_URL",
      "SICLAW_EMBEDDING_MODEL",
      "SICLAW_EMBEDDING_DIMENSIONS",
      "SICLAW_EMBEDDING_API_KEY",
    ];
    for (const name of AGENTBOX_FORWARDED_ENV) {
      const value = process.env[name];
      if (value !== undefined && value !== "") {
        env.push({ name, value });
      }
    }

    // Add custom environment variables
    if (boxConfig.env) {
      for (const [key, value] of Object.entries(boxConfig.env)) {
        env.push({ name: key, value });
      }
    }

    // Shared PVC is now scoped per-agent only — all users of the agent share
    // this subdirectory (memory is agent-shared per the 2026-04-18 spec).
    const safeAgentId = this.sanitizePathSegment(agentId);

    // Persistence decision is per-agent: boxConfig.persistence overrides the
    // spawner's global config (undefined → fall back to global). Mounting the
    // PVC requires a claimName, so an agent that requests persistence on a
    // runtime with no shared PVC configured falls back to emptyDir (with a
    // warning) rather than spawning a pod that can never mount.
    const persistenceClaimName = this.config.persistence?.claimName;
    const wantsPersistence = boxConfig.persistence ?? !!this.config.persistence?.enabled;
    const persistenceEnabled = wantsPersistence && !!persistenceClaimName;
    if (wantsPersistence && !persistenceClaimName) {
      console.warn(
        `[k8s-spawner] Agent ${agentId} requests persistence but no shared PVC claimName is configured; ` +
        `falling back to emptyDir (session/memory will NOT survive pod restarts)`,
      );
    }
    if (persistenceEnabled) {
      const subDir = `agents/${safeAgentId}`;
      console.log(`[k8s-spawner] Persistence enabled for agent ${agentId}: shared PVC "${persistenceClaimName}", subPath "${subDir}"`);
      this.ensureAgentDir(safeAgentId);
    }

    // user-data volume: shared PVC when persistence resolved on (claimName is
    // narrowed to string by the && below), otherwise an ephemeral emptyDir.
    const userDataVolume: k8s.V1Volume = persistenceEnabled && persistenceClaimName
      ? { name: "user-data", persistentVolumeClaim: { claimName: persistenceClaimName } }
      : { name: "user-data", emptyDir: {} };

    // Pod definition
    const pod: k8s.V1Pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName,
        namespace,
        labels: {
          [`${labelPrefix}/app`]: "agentbox",
          [`${labelPrefix}/agent`]: agentId,
          [caFpLabel]: caFp,
        },
      },
      spec: {
        hostname: podName,
        subdomain: "agentbox-hs",
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        // ── Security: dual-user isolation (ADR-010) ─────────────────
        // Container starts as root (entrypoint fixes volume permissions,
        // then drops to agentbox via runuser). Child processes run as
        // sandbox user via sudo. CHOWN/FOWNER are needed for the
        // entrypoint to fix volume permissions; SETUID/SETGID for user
        // switching. All capabilities drop after runuser.
        securityContext: {
          seccompProfile: { type: "RuntimeDefault" },
        },
        volumes: [
          {
            name: "credentials",
            emptyDir: {},
          },
          {
            name: "config",
            emptyDir: {},
          },
          {
            name: "skills-local",
            emptyDir: {},
          },
          {
            name: "knowledge-local",
            emptyDir: {},
          },
          userDataVolume,
          {
            name: "client-cert",
            secret: { secretName: certSecretName },
          },
          {
            name: "tmp",
            emptyDir: { sizeLimit: "100Mi" },
          },
        ],
        containers: [
          {
            name: "agentbox",
            image,
            imagePullPolicy,
            securityContext: {
              capabilities: {
                drop: ["ALL"],
                add: ["SETUID", "SETGID", "CHOWN", "FOWNER", "AUDIT_WRITE"],
              },
              readOnlyRootFilesystem: true,
            },
            ports: [
              { containerPort: 3000, name: "https" },
            ],
            env,
            volumeMounts: [
              {
                name: "credentials",
                mountPath: "/app/.siclaw/credentials",
              },
              {
                name: "config",
                mountPath: "/app/.siclaw/config",
              },
              {
                name: "skills-local",
                mountPath: "/app/.siclaw/skills",
              },
              {
                name: "knowledge-local",
                mountPath: "/app/.siclaw/knowledge",
              },
              {
                name: "user-data",
                mountPath: "/app/.siclaw/user-data",
                ...(persistenceEnabled
                  ? { subPath: `agents/${safeAgentId}` }
                  : {}),
              },
              {
                name: "client-cert",
                mountPath: "/etc/siclaw/certs",
                readOnly: true,
              },
              {
                name: "tmp",
                mountPath: "/tmp",
              },
            ],
            resources: {
              requests: {
                cpu: boxConfig.resources?.cpu || "100m",
                memory: boxConfig.resources?.memory || "256Mi",
              },
              limits: {
                cpu: boxConfig.resources?.cpu || "2000m",
                memory: boxConfig.resources?.memory || "4Gi",
              },
            },
            readinessProbe: {
              httpGet: { path: "/health", port: 3000 as any, scheme: "HTTPS" },
              initialDelaySeconds: 2,
              periodSeconds: 2,
            },
            livenessProbe: {
              httpGet: { path: "/health", port: 3000 as any, scheme: "HTTPS" },
              initialDelaySeconds: 10,
              periodSeconds: 10,
            },
          },
        ],
      },
    };

    // Create Pod (handle 409 Conflict if another process created it concurrently)
    try {
      await this.coreApi.createNamespacedPod({ namespace, body: pod });
    } catch (err: any) {
      if (err.code === 409 || err.statusCode === 409) {
        console.log(`[k8s-spawner] Pod ${podName} already exists (concurrent create), reusing`);
      } else {
        throw err;
      }
    }

    // Wait for Pod to obtain an IP
    const endpoint = await this.waitForPodReady(podName, namespace);

    return {
      boxId: podName,
      agentId,
      endpoint,
    };
  }

  /** Sanitize a path segment — keep only safe characters for directory names and K8s subPath. */
  private sanitizePathSegment(segment: string): string {
    return segment.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 63);
  }

  /**
   * Ensure per-agent subdirectory exists on the shared PVC (synchronous, idempotent).
   * Expects already-sanitized path segments.
   * Directory layout: `/app/.siclaw/user-data/agents/{safeAgentId}/`
   */
  private ensureAgentDir(safeAgentId: string): void {
    const base = path.resolve("/app/.siclaw/user-data");
    const dir = path.join(base, "agents", safeAgentId);
    if (!dir.startsWith(base)) {
      throw new Error(`[k8s-spawner] Path traversal detected: ${dir}`);
    }
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Wait for Pod to be Ready and obtain its IP
   */
  private async waitForPodReady(
    podName: string,
    namespace: string,
    timeoutMs = 60000,
  ): Promise<string> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const pod = await this.coreApi.readNamespacedPod({ name: podName, namespace });

      const podIP = pod.status?.podIP;
      const phase = pod.status?.phase;
      const ready =
        pod.status?.conditions?.find((c: k8s.V1PodCondition) => c.type === "Ready")?.status ===
        "True";

      if (phase === "Running" && ready && podIP) {
        return `https://${podIP}:3000`;
      }

      if (phase === "Failed" || phase === "Unknown") {
        throw new Error(`Pod ${podName} failed to start: ${phase}`);
      }

      // Wait 1 second before retrying
      await new Promise((r) => setTimeout(r, 1000));
    }

    throw new Error(`Pod ${podName} did not become ready within ${timeoutMs}ms`);
  }

  /**
   * Wait for a pod to be fully deleted
   */
  private async waitForPodDeleted(
    podName: string,
    namespace: string,
    timeoutMs = 30000,
  ): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        await this.coreApi.readNamespacedPod({ name: podName, namespace });
        // Still exists, wait
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err: any) {
        if (err.code === 404 || err.statusCode === 404) {
          return; // Pod is gone
        }
        throw err;
      }
    }
    console.warn(`[k8s-spawner] Pod ${podName} not fully deleted within ${timeoutMs}ms, proceeding anyway`);
  }

  /**
   * Stop an AgentBox
   */
  async stop(boxId: string): Promise<void> {
    const { namespace } = this.config;

    console.log(`[k8s-spawner] Stopping pod: ${boxId}`);

    try {
      // Delete Pod
      await this.coreApi.deleteNamespacedPod({ name: boxId, namespace });

      // Attempt to delete the associated cert Secret
      const secretName = `${boxId}-cert`;
      try {
        await this.coreApi.deleteNamespacedSecret({ name: secretName, namespace });
      } catch {
        // Secret may not exist, ignore
      }
    } catch (err: any) {
      if (err.code !== 404 && err.statusCode !== 404) {
        throw err;
      }
      // Pod does not exist, ignore
    }
  }

  /**
   * Get AgentBox information
   */
  /**
   * Fingerprint of the CA this spawner currently signs AgentBox certs with.
   * Undefined before setCertManager() runs. The manager compares it to a pod's
   * stamped `ca-fp` label to decide whether the pod is still reachable over mTLS.
   */
  caFingerprint(): string | undefined {
    return this.certManager?.caFingerprint();
  }

  async get(boxId: string): Promise<AgentBoxInfo | null> {
    const { namespace, labelPrefix } = this.config;

    try {
      const pod = await this.coreApi.readNamespacedPod({ name: boxId, namespace });

      const agentId = pod.metadata?.labels?.[`${labelPrefix}/agent`] || "";
      const status = this.mapPodStatus(pod);
      const podIP = pod.status?.podIP;

      return {
        boxId,
        agentId,
        status,
        endpoint: podIP ? `https://${podIP}:3000` : "",
        createdAt: pod.metadata?.creationTimestamp
          ? new Date(pod.metadata.creationTimestamp)
          : new Date(),
        lastActiveAt: new Date(),
        caFingerprint: pod.metadata?.labels?.[`${labelPrefix}/ca-fp`],
      };
    } catch (err: any) {
      if (err.code === 404 || err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  /**
   * List all AgentBoxes
   */
  async list(): Promise<AgentBoxInfo[]> {
    const { namespace, labelPrefix } = this.config;

    const podList = await this.coreApi.listNamespacedPod({
      namespace,
      labelSelector: `${labelPrefix}/app=agentbox`,
    });

    return podList.items.map((pod: k8s.V1Pod) => {
      const agentId = pod.metadata?.labels?.[`${labelPrefix}/agent`] || "";
      const status = this.mapPodStatus(pod);
      const podIP = pod.status?.podIP;

      return {
        boxId: pod.metadata?.name || "",
        agentId,
        status,
        endpoint: podIP ? `https://${podIP}:3000` : "",
        createdAt: pod.metadata?.creationTimestamp
          ? new Date(pod.metadata.creationTimestamp)
          : new Date(),
        lastActiveAt: new Date(),
      };
    });
  }

  /**
   * Map Pod phase to AgentBoxStatus
   */
  private mapPodStatus(pod: k8s.V1Pod): AgentBoxStatus {
    // Terminating pods (deletionTimestamp set) may still report
    // phase=Running and Ready=True during the grace period, but their
    // podIP is on its way out — treat them as stopped so callers that
    // filter on status="running" (e.g. agent.reload) skip them.
    if (pod.metadata?.deletionTimestamp) return "stopped";

    const phase = pod.status?.phase;
    const ready = pod.status?.conditions?.find((c) => c.type === "Ready")?.status === "True";

    switch (phase) {
      case "Pending":
        return "starting";
      case "Running":
        return ready ? "running" : "starting";
      case "Succeeded":
      case "Failed":
        return "stopped";
      default:
        return "error";
    }
  }

  /**
   * Clean up all AgentBoxes
   */
  async cleanup(): Promise<void> {
    const { namespace, labelPrefix } = this.config;

    console.log(`[k8s-spawner] Cleaning up all agentbox pods in namespace: ${namespace}`);

    // Delete all AgentBox Pods
    await this.coreApi.deleteCollectionNamespacedPod({
      namespace,
      labelSelector: `${labelPrefix}/app=agentbox`,
    });

    // Delete all cert Secrets
    await this.coreApi.deleteCollectionNamespacedSecret({
      namespace,
      labelSelector: `${labelPrefix}/app=agentbox`,
    });
  }
}
