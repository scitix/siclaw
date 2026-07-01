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
  private spawnEnvResolver?: (agentId: string) => Promise<Record<string, string> | undefined>;
  private persistenceResolver?: (agentId: string) => Promise<boolean | undefined>;

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

  /**
   * Inject a resolver for per-agent spawn env. Applied on EVERY cold spawn from
   * any entry point — chat RPCs, channel webhooks (Lark/DingTalk), cron tasks —
   * because they all share this single manager instance (bootstrap-runtime).
   * Without it, whichever entry point cold-spawns the (one-per-agent) pod first
   * would otherwise win the pod's env, silently ignoring the configured value.
   * Invoked lazily — only when a pod is actually created — so warm-pod reuse
   * pays nothing. Currently supplies SICLAW_AGENTBOX_IDLE_TIMEOUT.
   */
  setSpawnEnvResolver(fn: (agentId: string) => Promise<Record<string, string> | undefined>): void {
    this.spawnEnvResolver = fn;
  }

  /**
   * Inject a resolver for the per-agent PVC persistence mode. Same contract as
   * setSpawnEnvResolver: consulted on EVERY cold spawn (from any entry point —
   * chat RPCs, channel webhooks, cron tasks, abort/steer) and NEVER on warm
   * reuse. This is what makes persistence a true agent-level property: the
   * value is resolved by agentId, independent of which entry point first
   * cold-spawns the (one-per-agent) pod. Without it, only entry points that
   * happened to pass `config.persistence` would honour it, so a pod cold-spawned
   * by e.g. a Lark message would silently fall to the global default and ignore
   * the agent's configured mode. Returns undefined to fall back to the global
   * config (the spawner gates the actual mount on a claimName regardless).
   */
  setPersistenceResolver(fn: (agentId: string) => Promise<boolean | undefined>): void {
    this.persistenceResolver = fn;
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

  /**
   * Get a running AgentBox for the agent, or spawn one.
   *
   * Per-agent config — the injected `spawnEnvResolver` (env, e.g. idle timeout)
   * and `persistenceResolver` (PVC mode) — is resolved ONLY on a cold spawn,
   * never on warm-pod reuse, so the chat hot path and channel/cron paths pay no
   * RPC when the pod already exists.
   *
   * Because a pod is keyed by agentId, the persistence/env mode is resolved on
   * each cold spawn (including a cert-stale recreate) from the agent-level
   * resolver — NOT from whichever entry point happens to call first. The volume
   * mount is fixed at pod creation (K8s cannot hot-change a running pod's
   * mounts), so a configuration change applies on the agent's next cold spawn
   * (after restart/idle-release), not immediately on a warm pod.
   */
  async getOrCreate(agentId: string, config?: Partial<AgentBoxConfig>): Promise<AgentBoxHandle> {
    if (!agentId) throw new Error("AgentBoxManager.getOrCreate requires an agentId");
    if (this.isK8s) {
      return this.getOrCreateK8s(agentId, config);
    }
    return this.getOrCreateLocal(agentId, config);
  }

  private async getOrCreateK8s(agentId: string, config?: Partial<AgentBoxConfig>): Promise<AgentBoxHandle> {
    const name = this.podName(agentId);
    const wantProfile = config?.profile ?? "agent";

    const info = await this.spawner.get(name);
    if (info && info.status === "running" && info.endpoint && this.isCertFresh(info)) {
      const hasProfile = info.profile ?? "agent";
      if (hasProfile === wantProfile) {
        // Warm reuse: return the running pod without spawning. Per-agent config
        // (env/persistence) is NOT re-resolved here — the pod's volume mount is
        // already fixed, so a changed mode applies on the next cold spawn.
        return { boxId: name, endpoint: info.endpoint, agentId };
      }
      // Profile changed under the same identity — reusing the old-shaped pod would
      // silently run the wrong image/tools/volumes (the historic stale-box gap).
      // Stop it and respawn with the requested profile. Fail-closed on trust.
      console.log(
        `[agentbox-manager] Profile mismatch for ${name} (running=${hasProfile}, want=${wantProfile}); respawning`,
      );
      await this.spawner.stop(name);
    }
    if (info && info.status === "running" && !this.isCertFresh(info)) {
      console.log(`[agentbox-manager] Pod for agent=${agentId} has a stale CA cert; recreating to restore mTLS`);
    }

    console.log(`[agentbox-manager] Creating new AgentBox for agent=${agentId}`);

    const resolvedEnv = await this.resolveEnv(agentId, config?.env);
    const handle = await this.spawner.spawn({
      ...config,
      agentId,
      persistence: await this.resolvePersistence(agentId, config?.persistence),
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
        // Warm reuse: cached running box returned without spawning. Per-agent
        // config (env/persistence) is NOT re-resolved — applies on next cold spawn.
        return existing.handle;
      }
      this.boxes.delete(agentId);
    }

    console.log(`[agentbox-manager] Creating new AgentBox for agent=${agentId}`);

    const resolvedEnv = await this.resolveEnv(agentId, config?.env);
    const handle = await this.spawner.spawn({
      ...config,
      agentId,
      persistence: await this.resolvePersistence(agentId, config?.persistence),
      env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
    });

    this.boxes.set(agentId, { handle, lastActiveAt: new Date(), createdAt: new Date() });
    return handle;
  }

  /**
   * Merge static config env with the lazily-resolved per-agent env from the
   * injected resolver. Only called on a cold spawn. Static `config.env` wins on
   * key collisions.
   */
  private async resolveEnv(agentId: string, configEnv?: Record<string, string>): Promise<Record<string, string>> {
    const lazy = this.spawnEnvResolver ? (await this.spawnEnvResolver(agentId)) ?? {} : {};
    return { ...lazy, ...(configEnv ?? {}) };
  }

  /**
   * Resolve the per-agent PVC persistence mode for a cold spawn. An explicit
   * `configValue` (e.g. task-coordinator passing `binding.persistence`) wins;
   * otherwise the injected `persistenceResolver` is consulted by agentId. Either
   * may be undefined → the spawner falls back to its global config. Only called
   * on a cold spawn, so warm-pod reuse pays no RPC.
   */
  private async resolvePersistence(agentId: string, configValue?: boolean): Promise<boolean | undefined> {
    if (configValue !== undefined) return configValue;
    return this.persistenceResolver ? await this.persistenceResolver(agentId) : undefined;
  }

  /**
   * Whether a running pod's mTLS cert still chains to the runtime's current CA.
   *
   * If the spawner can't report a CA fingerprint (non-mTLS spawner, or cert
   * manager not yet set), there's nothing to validate → treat as fresh. A
   * running pod whose stamped fingerprint differs (or is absent on a pod
   * spawned before this label existed) is stale: the runtime can no longer
   * complete mTLS with it, so getOrCreate falls through to spawn(), which
   * deletes and recreates it with a cert signed by the current CA.
   */
  private isCertFresh(info: AgentBoxInfo): boolean {
    const want = this.spawner.caFingerprint?.();
    if (!want) return true;
    return info.caFingerprint === want;
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
