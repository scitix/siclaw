/**
 * K8s Pod Spawner
 *
 * Creates and manages AgentBox Pods via the Kubernetes API.
 */

import * as k8s from "@kubernetes/client-node";
import type { BoxSpawner } from "./spawner.js";
import type { AgentBoxConfig, AgentBoxHandle, AgentBoxInfo, AgentBoxStatus } from "./types.js";

export interface K8sSpawnerConfig {
  /** K8s namespace */
  namespace?: string;
  /** AgentBox image */
  image?: string;
  /** Image pull policy */
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  /** Pod label prefix */
  labelPrefix?: string;
}

const DEFAULT_CONFIG: Required<K8sSpawnerConfig> = {
  namespace: "default",
  image: "siclaw-agentbox:latest",
  imagePullPolicy: "Always",
  labelPrefix: "siclaw.io",
};

export class K8sSpawner implements BoxSpawner {
  readonly name = "k8s";

  private kc: k8s.KubeConfig;
  private coreApi: k8s.CoreV1Api;
  private config: Required<K8sSpawnerConfig>;

  constructor(config?: K8sSpawnerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Load kubeconfig
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();

    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
  }

  /** Update the AgentBox image at runtime (takes effect on next spawn) */
  setImage(image: string): void {
    this.config.image = image;
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



    // Environment variables
    const env: k8s.V1EnvVar[] = [
      { name: "USER_ID", value: boxConfig.userId },
      { name: "SICLAW_AGENTBOX_PORT", value: "3000" },
      { name: "PI_CODING_AGENT_DIR", value: ".siclaw/user-data/agent" },
      { name: "SICLAW_SKILLS_DIR", value: ".siclaw/skills" },
      { name: "SICLAW_MCP_DIR", value: ".siclaw/mcp" },
      { name: "SICLAW_USER_DATA_DIR", value: ".siclaw/user-data" },
      { name: "SICLAW_GATEWAY_URL", value: "http://siclaw-gateway.siclaw.svc.cluster.local" },
      { name: "SICLAW_CREDENTIALS_DIR", value: "/home/agentbox/.credentials" },
    ];

    // Pass workspace allowed tools
    if (boxConfig.allowedTools !== undefined) {
      env.push({ name: "SICLAW_WORKSPACE_ALLOWED_TOOLS", value: JSON.stringify(boxConfig.allowedTools) });
    }

    // Add custom environment variables
    if (boxConfig.env) {
      for (const [key, value] of Object.entries(boxConfig.env)) {
        env.push({ name: key, value });
      }
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
        },
      },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        volumes: [
          {
            name: "skills-pv",
            persistentVolumeClaim: { claimName: "siclaw-skills" },
          },
        ],
        containers: [
          {
            name: "agentbox",
            image,
            imagePullPolicy,
            ports: [{ containerPort: 3000, name: "http" }],
            env,
            volumeMounts: [
              {
                name: "skills-pv",
                mountPath: "/app/.siclaw/skills/core",
                subPath: "core",
                readOnly: true,
              },
              {
                name: "skills-pv",
                mountPath: "/app/.siclaw/skills/team",
                subPath: "team",
                readOnly: true,
              },
              {
                name: "skills-pv",
                mountPath: "/app/.siclaw/skills/user",
                subPath: `user/${userId}/.ws-${workspaceId}`,
                readOnly: true,
              },
              {
                name: "skills-pv",
                mountPath: "/app/.siclaw/user-data",
                subPath: `user/${userId}/agent-data`,
              },
              {
                name: "skills-pv",
                mountPath: "/app/.siclaw/mcp",
                subPath: "mcp",
                readOnly: true,
              },
              {
                name: "skills-pv",
                mountPath: "/home/agentbox/.credentials",
                subPath: `user/${userId}/.ws-${workspaceId}/.credentials`,
                readOnly: true,
              },
              {
                name: "skills-pv",
                mountPath: "/home/agentbox/.kube/envs",
                subPath: `user/${userId}/.kube/envs`,
                readOnly: true,
              },
              {
                name: "skills-pv",
                mountPath: "/home/agentbox/.kube/defaults",
                subPath: "_default_kubeconfigs",
                readOnly: true,
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
              httpGet: { path: "/health", port: 3000 as any },
              initialDelaySeconds: 2,
              periodSeconds: 2,
            },
            livenessProbe: {
              httpGet: { path: "/health", port: 3000 as any },
              initialDelaySeconds: 10,
              periodSeconds: 10,
            },
          },
        ],
      },
    };

    // If a kubeconfig is provided, mount it as a Secret
    if (boxConfig.kubeconfigBase64) {
      const secretName = `${podName}-kubeconfig`;

      // Create Secret
      await this.coreApi.createNamespacedSecret({
        namespace,
        body: {
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: secretName },
          data: { config: boxConfig.kubeconfigBase64 },
        },
      });

      // Append kubeconfig volume and mount
      pod.spec!.volumes!.push({
        name: "kubeconfig",
        secret: { secretName },
      });
      pod.spec!.containers[0].volumeMounts!.push({
        name: "kubeconfig",
        mountPath: "/home/agentbox/.kube",
        readOnly: true,
      });
    }

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
   * Ensure per-user PVC exists (idempotent)
   */
  private async ensureUserPvc(userId: string): Promise<void> {
    const { namespace } = this.config;
    const pvcName = `siclaw-user-${userId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50)}`;

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
              accessModes: ["ReadWriteOnce"],
              storageClassName: process.env.SICLAW_STORAGE_CLASS || "nfs-siclaw",
              resources: {
                requests: { storage: "1Gi" },
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
        return `http://${podIP}:3000`;
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

      // Attempt to delete the associated Secret
      const secretName = `${boxId}-kubeconfig`;
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
      const status = this.mapPodStatus(pod);
      const podIP = pod.status?.podIP;

      return {
        boxId,
        userId,
        status,
        endpoint: podIP ? `http://${podIP}:3000` : "",
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
      const status = this.mapPodStatus(pod);
      const podIP = pod.status?.podIP;

      return {
        boxId: pod.metadata?.name || "",
        userId,
        status,
        endpoint: podIP ? `http://${podIP}:3000` : "",
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

    // Delete all kubeconfig Secrets
    await this.coreApi.deleteCollectionNamespacedSecret({
      namespace,
      labelSelector: `${labelPrefix}/app=agentbox`,
    });
  }
}
