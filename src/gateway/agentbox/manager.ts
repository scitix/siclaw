/**
 * AgentBox Manager
 *
 * Manages the lifecycle of AgentBoxes keyed on `agentId`. One AgentBox pod
 * per agent serves every user who addresses that agent; per-user state is
 * threaded in request-scoped `sessionId`, not in the pod identity.
 *
 * - K8s: stateless, queries K8s API each time (no in-memory cache)
 * - Local dev: in-memory cache for fast lookups
 */

import type { BoxSpawner } from "./spawner.js";
import type { AgentBoxConfig, AgentBoxHandle, AgentBoxInfo } from "./types.js";

export interface AgentBoxManagerConfig {
  /** Health check interval (ms) — local dev only */
  healthCheckIntervalMs?: number;
  /** Maximum number of retries */
  maxRetries?: number;
  /** K8s namespace */
  namespace?: string;
}

const DEFAULT_CONFIG: Required<AgentBoxManagerConfig> = {
  healthCheckIntervalMs: 60 * 1000,
  maxRetries: 3,
  namespace: "default",
};

interface ManagedBox {
  handle: AgentBoxHandle;
  lastActiveAt: Date;
  createdAt: Date;
}

export class AgentBoxManager {
  private spawner: BoxSpawner;
  private config: Required<AgentBoxManagerConfig>;
  private boxes = new Map<string, ManagedBox>();
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private readonly isK8s: boolean;

  constructor(spawner: BoxSpawner, config?: AgentBoxManagerConfig) {
    this.spawner = spawner;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.isK8s = spawner.name === "k8s";
    console.log(`[agentbox-manager] Initialized with spawner: ${spawner.name}${this.isK8s ? " (stateless, K8s API discovery)" : " (in-memory cache)"}`);
  }

  setCertManager(cm: unknown): void {
    if ('setCertManager' in this.spawner) {
      (this.spawner as any).setCertManager(cm);
    }
  }

  startHealthCheck(): void {
    if (this.isK8s || this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(() => { this.runHealthCheck(); }, this.config.healthCheckIntervalMs);
    console.log(`[agentbox-manager] Health check started (interval: ${this.config.healthCheckIntervalMs}ms)`);
  }

  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /**
   * Pod / box name. One pod per agent — we trim agentId to keep under the 63-char
   * K8s name limit and only sanitize forbidden characters.
   */
  private podName(agentId: string): string {
    const sanitized = agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
    return `agentbox-${sanitized}`;
  }

  private async runHealthCheck(): Promise<void> {
    for (const [key, managed] of this.boxes.entries()) {
      const info = await this.spawner.get(managed.handle.boxId);
      if (!info || info.status === "stopped" || info.status === "error") {
        console.log(`[agentbox-manager] Box ${key} is gone, removing from cache`);
        this.boxes.delete(key);
      }
    }
  }

  async getOrCreate(agentId: string, config?: Partial<AgentBoxConfig>): Promise<AgentBoxHandle> {
    if (!agentId) throw new Error("AgentBoxManager.getOrCreate requires an agentId");
    if (this.isK8s) {
      return this.getOrCreateK8s(agentId, config);
    }
    return this.getOrCreateLocal(agentId, config);
  }

  private async getOrCreateK8s(agentId: string, config?: Partial<AgentBoxConfig>): Promise<AgentBoxHandle> {
    const name = this.podName(agentId);

    const info = await this.spawner.get(name);
    if (info && info.status === "running" && info.endpoint) {
      return { boxId: name, endpoint: info.endpoint, agentId };
    }

    console.log(`[agentbox-manager] Creating new AgentBox for agent=${agentId}`);

    const resolvedEnv = this.resolveEnv(config?.env);
    const handle = await this.spawner.spawn({
      ...config,
      agentId,
      env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
    });

    handle.agentId = agentId;
    return handle;
  }

  private async getOrCreateLocal(agentId: string, config?: Partial<AgentBoxConfig>): Promise<AgentBoxHandle> {
    const existing = this.boxes.get(agentId);
    if (existing) {
      existing.lastActiveAt = new Date();
      const info = await this.spawner.get(existing.handle.boxId);
      if (info && info.status === "running") {
        return existing.handle;
      }
      this.boxes.delete(agentId);
    }

    console.log(`[agentbox-manager] Creating new AgentBox for agent=${agentId}`);

    const resolvedEnv = this.resolveEnv(config?.env);
    const handle = await this.spawner.spawn({
      ...config,
      agentId,
      env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
    });

    this.boxes.set(agentId, { handle, lastActiveAt: new Date(), createdAt: new Date() });
    return handle;
  }

  private resolveEnv(configEnv?: Record<string, string>): Record<string, string> {
    return configEnv ?? {};
  }

  get(agentId: string): AgentBoxHandle | undefined {
    if (this.isK8s) return undefined;
    const managed = this.boxes.get(agentId);
    if (managed) {
      managed.lastActiveAt = new Date();
      return managed.handle;
    }
    return undefined;
  }

  async getAsync(agentId: string): Promise<AgentBoxHandle | undefined> {
    if (this.isK8s) {
      const name = this.podName(agentId);
      const info = await this.spawner.get(name);
      if (info && info.status === "running" && info.endpoint) {
        return { boxId: name, endpoint: info.endpoint, agentId };
      }
      return undefined;
    }
    return this.get(agentId);
  }

  async stop(agentId: string): Promise<void> {
    if (this.isK8s) {
      const name = this.podName(agentId);
      console.log(`[agentbox-manager] Stopping AgentBox ${name}`);
      await this.spawner.stop(name);
      return;
    }
    const managed = this.boxes.get(agentId);
    if (!managed) return;
    console.log(`[agentbox-manager] Stopping AgentBox for agent=${agentId}`);
    await this.spawner.stop(managed.handle.boxId);
    this.boxes.delete(agentId);
  }

  activeAgentIds(): string[] {
    if (this.isK8s) return [];
    return Array.from(this.boxes.keys());
  }

  async list(): Promise<AgentBoxInfo[]> {
    return this.spawner.list();
  }

  touch(agentId: string): void {
    if (this.isK8s) return;
    const managed = this.boxes.get(agentId);
    if (managed) managed.lastActiveAt = new Date();
  }

  stats(): { total: number; agentIds: string[] } {
    return { total: this.boxes.size, agentIds: Array.from(this.boxes.keys()) };
  }

  async cleanup(): Promise<void> {
    this.stopHealthCheck();
    for (const [, managed] of this.boxes) {
      await this.spawner.stop(managed.handle.boxId);
    }
    this.boxes.clear();
    await this.spawner.cleanup();
  }
}
