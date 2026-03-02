/**
 * AgentBox Manager
 *
 * Manages the lifecycle of AgentBoxes and provides a high-level API:
 * - Get or create an AgentBox by userId
 * - Automatic health checks and reclamation
 * - Multiple Spawner support
 */

import type { BoxSpawner } from "./spawner.js";
import type { AgentBoxConfig, AgentBoxHandle, AgentBoxInfo } from "./types.js";

export interface AgentBoxManagerConfig {
  /** Idle timeout (ms); box is automatically reclaimed after this period */
  idleTimeoutMs?: number;
  /** Health check interval (ms) */
  healthCheckIntervalMs?: number;
  /** Maximum number of retries */
  maxRetries?: number;
}

const DEFAULT_CONFIG: Required<AgentBoxManagerConfig> = {
  idleTimeoutMs: 30 * 60 * 1000, // 30 minutes
  healthCheckIntervalMs: 60 * 1000, // 1 minute
  maxRetries: 3,
};

interface ManagedBox {
  handle: AgentBoxHandle;
  lastActiveAt: Date;
  createdAt: Date;
}

export type EnvResolver = () => Promise<Record<string, string>>;

export class AgentBoxManager {
  private spawner: BoxSpawner;
  private config: Required<AgentBoxManagerConfig>;

  /** "userId:workspaceId" → ManagedBox */
  private boxes = new Map<string, ManagedBox>();

  /** Health check timer */
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  /** Optional async resolver that provides extra env vars for new AgentBoxes */
  private envResolver?: EnvResolver;

  constructor(spawner: BoxSpawner, config?: AgentBoxManagerConfig) {
    this.spawner = spawner;
    this.config = { ...DEFAULT_CONFIG, ...config };

    console.log(`[agentbox-manager] Initialized with spawner: ${spawner.name}`);
  }

  /**
   * Set an async resolver that provides extra env vars injected into every new AgentBox.
   * The resolved env is merged after config.env, so it takes precedence.
   */
  setEnvResolver(resolver: EnvResolver): void {
    this.envResolver = resolver;
  }

  /**
   * Start health check
   */
  startHealthCheck(): void {
    if (this.healthCheckTimer) return;

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
   * Run health check
   */
  private async runHealthCheck(): Promise<void> {
    const now = Date.now();

    for (const [key, managed] of this.boxes.entries()) {
      const idleTime = now - managed.lastActiveAt.getTime();

      // Check if idle timeout has been exceeded
      if (idleTime > this.config.idleTimeoutMs) {
        console.log(
          `[agentbox-manager] Box ${key} idle for ${idleTime}ms, stopping...`,
        );
        await this.spawner.stop(managed.handle.boxId);
        this.boxes.delete(key);
        continue;
      }

      // Check whether the Pod still exists
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
    const key = this.boxKey(userId, workspaceId);

    // Check cache
    const existing = this.boxes.get(key);
    if (existing) {
      // Update last active time
      existing.lastActiveAt = new Date();

      // Verify the Box still exists
      const info = await this.spawner.get(existing.handle.boxId);
      if (info && info.status === "running") {
        return existing.handle;
      }

      // Box is stale, remove from cache
      this.boxes.delete(key);
    }

    // Create a new AgentBox
    console.log(`[agentbox-manager] Creating new AgentBox for user: ${userId} workspace: ${workspaceId}`);

    // Resolve extra env vars from DB (e.g. LLM/Embedding provider config)
    let resolvedEnv: Record<string, string> | undefined;
    if (this.envResolver) {
      try {
        resolvedEnv = await this.envResolver();
      } catch (err) {
        console.warn("[agentbox-manager] envResolver failed, continuing without extra env:", err);
      }
    }

    const mergedEnv = { ...config?.env, ...resolvedEnv };

    const handle = await this.spawner.spawn({
      userId,
      workspaceId,
      ...config,
      env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
    });

    const managed: ManagedBox = {
      handle,
      lastActiveAt: new Date(),
      createdAt: new Date(),
    };

    this.boxes.set(key, managed);

    return handle;
  }

  /**
   * Get an AgentBox (without auto-creating)
   */
  get(userId: string, workspaceId = "default"): AgentBoxHandle | undefined {
    const key = this.boxKey(userId, workspaceId);
    const managed = this.boxes.get(key);
    if (managed) {
      managed.lastActiveAt = new Date();
      return managed.handle;
    }
    return undefined;
  }

  /**
   * Stop the AgentBox for a given user and workspace
   */
  async stop(userId: string, workspaceId = "default"): Promise<void> {
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
    const userIds = new Set<string>();
    for (const key of this.boxes.keys()) {
      const userId = key.split(":")[0];
      userIds.add(userId);
    }
    return [...userIds];
  }

  /** Get all AgentBox handles for a given user (across all workspaces) */
  getForUser(userId: string): AgentBoxHandle[] {
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
   * Update last active time
   */
  touch(userId: string, workspaceId = "default"): void {
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
