/**
 * K8s Pod Spawner
 *
 * Creates and manages AgentBox Pods via the Kubernetes API.
 */

import * as k8s from "@kubernetes/client-node";
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
  /** User data persistence (memory, sessions) */
  persistence?: {
    enabled: boolean;
    storageClass: string;
    accessMode: string;  // e.g. "ReadWriteMany"
    size: string;        // e.g. "1Gi"
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
   * Generate Pod name
   */
  private podName(userId: string, workspaceId?: string): string {
    // Sanitize userId — keep only lowercase letters, digits, and hyphens
    const sanitizedUser = userId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
    const wsSuffix = workspaceId
      ? workspaceId.replace(/[^a-z0-9]/g, "").slice(0, 8)
      : "default";
    return `agentbox-${sanitizedUser}-${wsSuffix}`;
  }

  /**
   * Create an AgentBox Pod
   */
  async spawn(boxConfig: AgentBoxConfig): Promise<AgentBoxHandle> {
    const { namespace, image, imagePullPolicy, labelPrefix } = this.config;
    const podName = this.podName(boxConfig.userId, boxConfig.workspaceId);
    const userId = boxConfig.userId;
    const workspaceId = boxConfig.workspaceId || "default";

    console.log(`[k8s-spawner] Creating pod: ${podName} for user: ${userId}`);

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
        console.log(`[k8s-spawner] Pod ${podName} already exists (phase: ${phase}), reusing`);
        const endpoint = await this.waitForPodReady(podName, namespace);
        return { boxId: podName, userId: boxConfig.userId, endpoint };
      }
    } catch (err: any) {
      if (err.code !== 404 && err.statusCode !== 404) {
        throw err;
      }
      // Pod doesn't exist, proceed to create
    }



    // Issue client certificate for mTLS authentication (env encoded in cert)
    if (!this.certManager) throw new Error("CertificateManager not initialized — call setCertManager() first");
    const podEnv: "prod" | "dev" | "test" = boxConfig.podEnv ?? "prod";
    const certBundle = this.certManager.issueAgentBoxCertificate(userId, workspaceId, podName, podEnv);
    const certSecretName = `${podName}-cert`;

    // Create certificate Secret
    try {
      await this.coreApi.createNamespacedSecret({
        namespace,
        body: {
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name: certSecretName,
            labels: {
              [`${labelPrefix}/app`]: "agentbox",
              [`${labelPrefix}/user`]: userId,
            },
          },
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
            metadata: {
              name: certSecretName,
              labels: {
                [`${labelPrefix}/app`]: "agentbox",
                [`${labelPrefix}/user`]: userId,
              },
            },
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
      { name: "SICLAW_GATEWAY_URL", value: process.env.SICLAW_GATEWAY_INTERNAL_URL || `https://siclaw-gateway.${namespace}.svc.cluster.local:3002` },
    ];

    // Add custom environment variables
    if (boxConfig.env) {
      for (const [key, value] of Object.entries(boxConfig.env)) {
        env.push({ name: key, value });
      }
    }

    // Ensure per-user PVC if persistence is enabled
    if (this.config.persistence?.enabled) {
      await this.ensureUserPvc(userId);
    }

    // Pod definition
    const pod: k8s.V1Pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName,
        namespace,
        labels: {
          [`${labelPrefix}/app`]: "agentbox",
          [`${labelPrefix}/user`]: boxConfig.userId,
          [`${labelPrefix}/workspace`]: boxConfig.workspaceId || "default",
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
          this.config.persistence?.enabled
            ? {
                name: "user-data",
                persistentVolumeClaim: { claimName: this.userPvcName(userId) },
              }
            : {
                name: "user-data",
                emptyDir: {},
              },
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
                add: ["SETUID", "SETGID", "CHOWN", "FOWNER"],
              },
              readOnlyRootFilesystem: true,
            },
            ports: [
              { containerPort: 3000, name: "https" },
              { containerPort: 9090, name: "metrics" },
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
                name: "user-data",
                mountPath: "/app/.siclaw/user-data",
                subPath: this.config.persistence?.enabled ? workspaceId : `user/${userId}/agent-data`,
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
                cpu: boxConfig.resources?.cpu || "1000m",
                memory: boxConfig.resources?.memory || "1Gi",
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
      userId: boxConfig.userId,
      endpoint,
    };
  }

  /**
   * Generate PVC name for a user
   */
  private userPvcName(userId: string): string {
    return `siclaw-user-${userId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50)}`;
  }

  /**
   * Ensure per-user PVC exists (idempotent)
   */
  private async ensureUserPvc(userId: string): Promise<void> {
    const { namespace } = this.config;
    const pvcName = this.userPvcName(userId);

    try {
      await this.coreApi.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
      // PVC already exists
    } catch (err: any) {
      if (err.code === 404 || err.statusCode === 404) {
        console.log(`[k8s-spawner] Creating User PVC: ${pvcName}`);
        await this.coreApi.createNamespacedPersistentVolumeClaim({
          namespace,
          body: {
            apiVersion: "v1",
            kind: "PersistentVolumeClaim",
            metadata: {
              name: pvcName,
              namespace,
              labels: {
                [`${this.config.labelPrefix}/app`]: "agentbox",
                [`${this.config.labelPrefix}/user`]: userId,
                [`${this.config.labelPrefix}/type`]: "user-data",
              },
            },
            spec: {
              accessModes: [this.config.persistence!.accessMode],
              storageClassName: this.config.persistence!.storageClass,
              resources: {
                requests: { storage: this.config.persistence!.size },
              },
            },
          },
        });
      } else {
        throw err;
      }
    }
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
  async get(boxId: string): Promise<AgentBoxInfo | null> {
    const { namespace, labelPrefix } = this.config;

    try {
      const pod = await this.coreApi.readNamespacedPod({ name: boxId, namespace });

      const userId = pod.metadata?.labels?.[`${labelPrefix}/user`] || "unknown";
      const workspaceId = pod.metadata?.labels?.[`${labelPrefix}/workspace`];
      const status = this.mapPodStatus(pod);
      const podIP = pod.status?.podIP;

      return {
        boxId,
        userId,
        workspaceId,
        status,
        endpoint: podIP ? `https://${podIP}:3000` : "",
        createdAt: pod.metadata?.creationTimestamp
          ? new Date(pod.metadata.creationTimestamp)
          : new Date(),
        lastActiveAt: new Date(),
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
      const userId = pod.metadata?.labels?.[`${labelPrefix}/user`] || "unknown";
      const workspaceId = pod.metadata?.labels?.[`${labelPrefix}/workspace`];
      const status = this.mapPodStatus(pod);
      const podIP = pod.status?.podIP;

      return {
        boxId: pod.metadata?.name || "",
        userId,
        workspaceId,
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
