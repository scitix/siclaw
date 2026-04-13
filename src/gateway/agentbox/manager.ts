/**
 * AgentBox Manager
 *
 * Manages the lifecycle of AgentBoxes and provides a high-level API:
 * - Get or create an AgentBox by userId + agentId
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

  private boxKey(userId: string, agentId: string): string {
    return `${userId}:${agentId}`;
  }

  private podName(userId: string, agentId: string): string {
    const sanitizedUser = userId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
    const agentSuffix = agentId
      ? agentId.replace(/[^a-z0-9]/g, "").slice(0, 8)
      : "default";
    return `agentbox-${sanitizedUser}-${agentSuffix}`;
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

  async getOrCreate(userId: string, agentId = "default", config?: Partial<AgentBoxConfig>): Promise<AgentBoxHandle> {
    if (this.isK8s) {
      return this.getOrCreateK8s(userId, agentId, config);
    }
    return this.getOrCreateLocal(userId, agentId, config);
  }

  private async getOrCreateK8s(userId: string, agentId: string, config?: Partial<AgentBoxConfig>): Promise<AgentBoxHandle> {
    const name = this.podName(userId, agentId);

    const info = await this.spawner.get(name);
    if (info && info.status === "running" && info.endpoint) {
      return { boxId: name, userId, endpoint: info.endpoint, agentId };
    }

    console.log(`[agentbox-manager] Creating new AgentBox for user=${userId} agent=${agentId}`);

    const resolvedEnv = this.resolveEnv(config?.env);
    const handle = await this.spawner.spawn({
      userId,
      agentId,
      ...config,
      env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
    });

    handle.agentId = agentId;
    return handle;
  }

  private async getOrCreateLocal(userId: string, agentId: string, config?: Partial<AgentBoxConfig>): Promise<AgentBoxHandle> {
    const key = this.boxKey(userId, agentId);

    const existing = this.boxes.get(key);
    if (existing) {
      existing.lastActiveAt = new Date();
      const info = await this.spawner.get(existing.handle.boxId);
      if (info && info.status === "running") {
        return existing.handle;
      }
      this.boxes.delete(key);
    }

    console.log(`[agentbox-manager] Creating new AgentBox for user=${userId} agent=${agentId}`);

    const resolvedEnv = this.resolveEnv(config?.env);
    const handle = await this.spawner.spawn({
      userId,
      agentId,
      ...config,
      env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
    });

    this.boxes.set(key, { handle, lastActiveAt: new Date(), createdAt: new Date() });
    return handle;
  }

  private resolveEnv(configEnv?: Record<string, string>): Record<string, string> {
    return configEnv ?? {};
  }

  get(userId: string, agentId = "default"): AgentBoxHandle | undefined {
    if (this.isK8s) return undefined;
    const key = this.boxKey(userId, agentId);
    const managed = this.boxes.get(key);
    if (managed) {
      managed.lastActiveAt = new Date();
      return managed.handle;
    }
    return undefined;
  }

  async getAsync(userId: string, agentId = "default"): Promise<AgentBoxHandle | undefined> {
    if (this.isK8s) {
      const name = this.podName(userId, agentId);
      const info = await this.spawner.get(name);
      if (info && info.status === "running" && info.endpoint) {
        return { boxId: name, userId, endpoint: info.endpoint, agentId };
      }
      return undefined;
    }
    return this.get(userId, agentId);
  }

  async stop(userId: string, agentId = "default"): Promise<void> {
    if (this.isK8s) {
      const name = this.podName(userId, agentId);
      console.log(`[agentbox-manager] Stopping AgentBox ${name}`);
      await this.spawner.stop(name);
      return;
    }
    const key = this.boxKey(userId, agentId);
    const managed = this.boxes.get(key);
    if (!managed) return;
    console.log(`[agentbox-manager] Stopping AgentBox for ${key}`);
    await this.spawner.stop(managed.handle.boxId);
    this.boxes.delete(key);
  }

  async stopAll(userId: string): Promise<void> {
    if (this.isK8s) {
      const allBoxes = await this.spawner.list();
      for (const box of allBoxes) {
        if (box.userId === userId) {
          await this.spawner.stop(box.boxId);
        }
      }
      return;
    }
    const toRemove: string[] = [];
    for (const [key, managed] of this.boxes) {
      if (key.startsWith(userId + ":")) {
        await this.spawner.stop(managed.handle.boxId);
        toRemove.push(key);
      }
    }
    for (const key of toRemove) this.boxes.delete(key);
  }

  activeUserIds(): string[] {
    if (this.isK8s) return [];
    const userIds = new Set<string>();
    for (const key of this.boxes.keys()) userIds.add(key.split(":")[0]);
    return [...userIds];
  }

  getForUser(userId: string): AgentBoxHandle[] {
    if (this.isK8s) return [];
    const handles: AgentBoxHandle[] = [];
    for (const [key, managed] of this.boxes) {
      if (key.startsWith(userId + ":")) {
        if (!managed.handle.agentId) {
          managed.handle.agentId = key.slice(userId.length + 1);
        }
        handles.push(managed.handle);
      }
    }
    return handles;
  }

  async list(): Promise<AgentBoxInfo[]> {
    return this.spawner.list();
  }

  touch(userId: string, agentId = "default"): void {
    if (this.isK8s) return;
    const managed = this.boxes.get(this.boxKey(userId, agentId));
    if (managed) managed.lastActiveAt = new Date();
  }

  stats(): { total: number; userIds: string[] } {
    return { total: this.boxes.size, userIds: Array.from(this.boxes.keys()) };
  }

  async cleanup(): Promise<void> {
    this.stopHealthCheck();
    for (const [key, managed] of this.boxes) {
      await this.spawner.stop(managed.handle.boxId);
    }
    this.boxes.clear();
    await this.spawner.cleanup();
  }
}
