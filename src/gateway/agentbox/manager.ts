/**
 * AgentBox Manager
 *
 * Manages the lifecycle of AgentBoxes and provides a high-level API:
 * - Get or create an AgentBox by userId
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
  healthCheckIntervalMs: 60 * 1000, // 1 minute
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

  /**
   * In-memory cache — used ONLY for local dev spawners (process, local).
   * K8s spawner queries the K8s API each time and bypasses this cache.
   */
  private boxes = new Map<string, ManagedBox>();

  /** Health check timer (local dev only) */
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  /** Whether the spawner is K8s-based (stateless, no in-memory cache) */
  private readonly isK8s: boolean;

  constructor(spawner: BoxSpawner, config?: AgentBoxManagerConfig) {
    this.spawner = spawner;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.isK8s = spawner.name === "k8s";

    console.log(`[agentbox-manager] Initialized with spawner: ${spawner.name}${this.isK8s ? " (stateless, K8s API discovery)" : " (in-memory cache)"}`);
  }

  /** Update the spawner's AgentBox image at runtime (takes effect on next spawn) */
  setSpawnerImage(image: string): void {
    if ('setImage' in this.spawner) {
      (this.spawner as any).setImage(image);
    }
  }

  /** Inject CertificateManager into spawner (for mTLS, K8s spawner only) */
  setCertManager(cm: unknown): void {
    if ('setCertManager' in this.spawner) {
      (this.spawner as any).setCertManager(cm);
    }
  }

  /**
   * Start health check (local dev only — removes stale entries from in-memory cache)
   */
  startHealthCheck(): void {
    if (this.isK8s || this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(async () => {
      await this.runHealthCheck();
    }, this.config.healthCheckIntervalMs);

    console.log(
      `[agentbox-manager] Health check started (interval: ${this.config.healthCheckIntervalMs}ms)`,
    );
  }

  /**
   * Stop health check
   */
  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
      console.log("[agentbox-manager] Health check stopped");
    }
  }

  /** Build composite cache key */
  private boxKey(userId: string, workspaceId: string): string {
    return `${userId}:${workspaceId}`;
  }

  /**
   * Build deterministic pod name (must match K8sSpawner.podName)
   */
  private podName(userId: string, workspaceId: string): string {
    const sanitizedUser = userId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
    const wsSuffix = workspaceId
      ? workspaceId.replace(/[^a-z0-9]/g, "").slice(0, 8)
      : "default";
    return `agentbox-${sanitizedUser}-${wsSuffix}`;
  }

  /**
   * Run health check (local dev only — cleans stale entries)
   */
  private async runHealthCheck(): Promise<void> {
    for (const [key, managed] of this.boxes.entries()) {
      const info = await this.spawner.get(managed.handle.boxId);
      if (!info || info.status === "stopped" || info.status === "error") {
        console.log(`[agentbox-manager] Box ${key} is gone, removing from cache`);
        this.boxes.delete(key);
      }
    }
  }

  /**
   * Get or create an AgentBox
   */
  async getOrCreate(userId: string, workspaceId = "default", config?: Partial<AgentBoxConfig>): Promise<AgentBoxHandle> {
    if (this.isK8s) {
      return this.getOrCreateK8s(userId, workspaceId, config);
    }
    return this.getOrCreateLocal(userId, workspaceId, config);
  }

  /**
   * K8s path: stateless — queries K8s API each time, uses Pod IP endpoint.
   * Any Gateway pod can call this (K8s API is cluster-wide).
   */
  private async getOrCreateK8s(userId: string, workspaceId: string, config?: Partial<AgentBoxConfig>): Promise<AgentBoxHandle> {
    const name = this.podName(userId, workspaceId);

    // 1. Check if pod already exists and is running
    const info = await this.spawner.get(name);
    if (info && info.status === "running" && info.endpoint) {
      return { boxId: name, userId, endpoint: info.endpoint };
    }

    // 2. Pod doesn't exist or not running → create
    console.log(`[agentbox-manager] Creating new AgentBox for user: ${userId} workspace: ${workspaceId}`);

    const resolvedEnv = this.resolveEnv(config?.env);
    const handle = await this.spawner.spawn({
      userId,
      workspaceId,
      ...config,
      env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
    });

    // 3. Return handle with Pod IP endpoint (from spawner.spawn → waitForPodReady)
    return handle;
  }

  /**
   * Local dev path: in-memory cache
   */
  private async getOrCreateLocal(userId: string, workspaceId: string, config?: Partial<AgentBoxConfig>): Promise<AgentBoxHandle> {
    const key = this.boxKey(userId, workspaceId);

    // Check cache
    const existing = this.boxes.get(key);
    if (existing) {
      existing.lastActiveAt = new Date();
      const info = await this.spawner.get(existing.handle.boxId);
      if (info && info.status === "running") {
        return existing.handle;
      }
      this.boxes.delete(key);
    }

    console.log(`[agentbox-manager] Creating new AgentBox for user: ${userId} workspace: ${workspaceId}`);

    const resolvedEnv = this.resolveEnv(config?.env);
    const handle = await this.spawner.spawn({
      userId,
      workspaceId,
      ...config,
      env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
    });

    this.boxes.set(key, {
      handle,
      lastActiveAt: new Date(),
      createdAt: new Date(),
    });

    return handle;
  }

  /** Resolve merged env vars */
  private resolveEnv(configEnv?: Record<string, string>): Record<string, string> {
    return configEnv ?? {};
  }

  /**
   * Get an AgentBox (without auto-creating).
   *
   * NOTE: This is synchronous, so for K8s it cannot query the API.
   * Returns undefined for K8s — callers should use getOrCreate() or
   * the async getAsync() instead.
   */
  get(userId: string, workspaceId = "default"): AgentBoxHandle | undefined {
    if (this.isK8s) {
      // Cannot query K8s API synchronously — return undefined.
      // Callers that need K8s handles should use getOrCreate() or getAsync().
      return undefined;
    }
    const key = this.boxKey(userId, workspaceId);
    const managed = this.boxes.get(key);
    if (managed) {
      managed.lastActiveAt = new Date();
      return managed.handle;
    }
    return undefined;
  }

  /**
   * Get an AgentBox asynchronously (without auto-creating).
   * For K8s: queries the K8s API to find the running pod.
   */
  async getAsync(userId: string, workspaceId = "default"): Promise<AgentBoxHandle | undefined> {
    if (this.isK8s) {
      const name = this.podName(userId, workspaceId);
      const info = await this.spawner.get(name);
      if (info && info.status === "running" && info.endpoint) {
        return { boxId: name, userId, endpoint: info.endpoint };
      }
      return undefined;
    }
    return this.get(userId, workspaceId);
  }

  /**
   * Stop the AgentBox for a given user and workspace
   */
  async stop(userId: string, workspaceId = "default"): Promise<void> {
    if (this.isK8s) {
      const name = this.podName(userId, workspaceId);
      console.log(`[agentbox-manager] Stopping AgentBox ${name}`);
      await this.spawner.stop(name);
      return;
    }
    const key = this.boxKey(userId, workspaceId);
    const managed = this.boxes.get(key);
    if (!managed) return;
    console.log(`[agentbox-manager] Stopping AgentBox for ${key}`);
    await this.spawner.stop(managed.handle.boxId);
    this.boxes.delete(key);
  }

  /**
   * Stop ALL AgentBoxes for a given user (across all workspaces)
   */
  async stopAll(userId: string): Promise<void> {
    if (this.isK8s) {
      const allBoxes = await this.spawner.list();
      for (const box of allBoxes) {
        if (box.userId === userId) {
          console.log(`[agentbox-manager] Stopping AgentBox ${box.boxId}`);
          await this.spawner.stop(box.boxId);
        }
      }
      return;
    }
    const toRemove: string[] = [];
    for (const [key, managed] of this.boxes) {
      if (key.startsWith(userId + ":")) {
        console.log(`[agentbox-manager] Stopping AgentBox ${key}`);
        await this.spawner.stop(managed.handle.boxId);
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      this.boxes.delete(key);
    }
  }

  /** Get all active user IDs with running AgentBoxes (deduplicated) */
  activeUserIds(): string[] {
    if (this.isK8s) {
      // Cannot determine from in-memory state — return empty.
      // Callers (e.g. notifyAllSkillReload) should use spawner.list() instead.
      return [];
    }
    const userIds = new Set<string>();
    for (const key of this.boxes.keys()) {
      const userId = key.split(":")[0];
      userIds.add(userId);
    }
    return [...userIds];
  }

  /** Get all AgentBox handles for a given user (across all workspaces) */
  getForUser(userId: string): AgentBoxHandle[] {
    if (this.isK8s) {
      // Cannot query K8s API synchronously — return empty.
      // Skill reload notifications will be picked up on next prompt.
      return [];
    }
    const handles: AgentBoxHandle[] = [];
    for (const [key, managed] of this.boxes) {
      if (key.startsWith(userId + ":")) {
        handles.push(managed.handle);
      }
    }
    return handles;
  }

  /**
   * List all AgentBoxes
   */
  async list(): Promise<AgentBoxInfo[]> {
    return this.spawner.list();
  }

  /**
   * Update last active time (no-op for K8s — AgentBox self-governs)
   */
  touch(userId: string, workspaceId = "default"): void {
    if (this.isK8s) return;
    const key = this.boxKey(userId, workspaceId);
    const managed = this.boxes.get(key);
    if (managed) {
      managed.lastActiveAt = new Date();
    }
  }

  /**
   * Get statistics
   */
  stats(): { total: number; userIds: string[] } {
    return {
      total: this.boxes.size,
      userIds: Array.from(this.boxes.keys()),
    };
  }

  /**
   * Clean up all resources
   */
  async cleanup(): Promise<void> {
    this.stopHealthCheck();

    console.log(`[agentbox-manager] Cleaning up ${this.boxes.size} boxes...`);

    for (const [key, managed] of this.boxes) {
      console.log(`[agentbox-manager] Stopping AgentBox ${key}`);
      await this.spawner.stop(managed.handle.boxId);
    }
    this.boxes.clear();

    await this.spawner.cleanup();
  }
}
