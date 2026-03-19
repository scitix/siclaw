/**
 * Debug pod label constants, label builder, and kubectl execution helper.
 *
 * Provides the foundation for structured debug pod lifecycle management:
 * - Standard label keys for all debug pods
 * - Label value sanitization (K8s constraints: ≤63 chars, alphanumeric boundaries)
 * - Thin kubectl wrapper with kubeconfig propagation
 */
import { spawnAsync, prepareExecEnv, type ExecEnv } from "./exec-utils.js";
import { loadConfig } from "../core/config.js";

// ── Label key constants ──────────────────────────────────────────────

export const LABEL_COMPONENT = "siclaw.io/component";
export const LABEL_USER_ID = "siclaw.io/user-id";
export const LABEL_TARGET_NODE = "siclaw.io/target-node";
export const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";

// ── Label value constants ────────────────────────────────────────────

export const COMPONENT_DEBUG_POD = "debug-pod";
export const MANAGED_BY_SICLAW = "siclaw";

// ── Lifecycle constants ──────────────────────────────────────────────

export const ACTIVE_DEADLINE_BUFFER_S = 120;

// ── Resource limit constants ────────────────────────────────────────
export const DEBUG_POD_RESOURCE_REQUESTS = { cpu: "0", memory: "0" };
export const DEBUG_POD_RESOURCE_LIMITS = { cpu: "500m", memory: "256Mi" };

// ── Label helpers ────────────────────────────────────────────────────

/**
 * Sanitize a raw string into a valid K8s label value.
 * Rules: ≤63 chars, alphanumeric + `-_.`, must start/end with alphanumeric.
 */
function sanitizeLabelValue(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 63);
  return cleaned.replace(/^[^a-zA-Z0-9]+/, "").replace(/[^a-zA-Z0-9]+$/, "") || "unknown";
}

/**
 * Build the standard label set for a debug pod.
 */
export function buildDebugPodLabels(
  userId: string,
  nodeName: string,
): Record<string, string> {
  return {
    [LABEL_COMPONENT]: COMPONENT_DEBUG_POD,
    [LABEL_USER_ID]: sanitizeLabelValue(userId),
    [LABEL_TARGET_NODE]: sanitizeLabelValue(nodeName),
    [LABEL_MANAGED_BY]: MANAGED_BY_SICLAW,
  };
}

// ── kubectl wrapper ──────────────────────────────────────────────────

/**
 * Run kubectl with kubeconfig args prepended.
 * Thin wrapper around spawnAsync — centralises kubeconfig propagation
 * so that no caller needs to manually splice kubeconfigArgs.
 */
export function kubectlExec(
  args: string[],
  env: ExecEnv,
  timeoutMs: number,
  signal?: AbortSignal,
  namespace?: string,
): Promise<{ stdout: string; stderr: string }> {
  const nsArgs = namespace ? ["-n", namespace] : [];
  return spawnAsync(
    "kubectl",
    [...env.kubeconfigArgs, ...nsArgs, ...args],
    timeoutMs,
    env.childEnv,
    signal,
  );
}

// ── Namespace helpers ────────────────────────────────────────────────

/**
 * Ensure the debug namespace exists. Idempotent — safe to call on every invocation.
 * Creates the namespace if it doesn't exist, or no-ops if it does.
 */
export async function ensureDebugNamespace(
  namespace: string,
  env: ExecEnv,
  timeoutMs = 10_000,
): Promise<void> {
  try {
    await spawnAsync(
      "kubectl",
      [...env.kubeconfigArgs, "create", "namespace", namespace],
      timeoutMs,
      env.childEnv,
    );
  } catch (err: any) {
    // "AlreadyExists" is expected and safe to ignore
    if (err.stderr && err.stderr.includes("already exists")) return;
    throw err;
  }
}

// ── Concurrency limiter (internal) ──────────────────────────────────
//
// Merged into DebugPodCache below. The limiter Set tracks which
// (userId, nodeName) slots are held — acquire/release is managed
// exclusively by the cache's set/remove/evict methods.

// ── Cleanup constants ───────────────────────────────────────────────

const CLEANUP_MAX_RETRIES = 3;
const CLEANUP_RETRY_INTERVAL_MS = 2_000;

// ── Cleanup helpers ─────────────────────────────────────────────────

/**
 * Delete a debug pod with retry. On each failure, logs structured error data.
 * After exhausting retries, logs a final warning but does NOT throw —
 * activeDeadlineSeconds is the safety net.
 *
 * Note: does not support AbortSignal. Worst-case retry loop is 6s (3 × 2s).
 * Callers on shutdown paths (evictAll) use Promise.allSettled; awaits may be
 * truncated by process exit, which is acceptable since activeDeadlineSeconds
 * guarantees eventual pod termination.
 */
export async function deleteDebugPod(
  podName: string,
  env: ExecEnv,
  opts: {
    namespace: string;
    nodeName: string;
    force?: boolean;
    gracePeriod?: number;
  },
): Promise<boolean> {
  const deleteArgs = [
    "delete", "pod", podName,
    ...(opts.force ? ["--force", "--grace-period=0"] : []),
    ...(opts.gracePeriod !== undefined && !opts.force ? [`--grace-period=${opts.gracePeriod}`] : []),
  ];

  for (let attempt = 1; attempt <= CLEANUP_MAX_RETRIES; attempt++) {
    try {
      await kubectlExec(deleteArgs, env, 10_000, undefined, opts.namespace);
      return true;
    } catch (err: any) {
      const errMsg = err.stderr?.trim() || err.message || String(err);
      // Pod already gone — treat as success
      if (errMsg.includes("not found")) return true;

      console.error("[debug-pod] cleanup failed", {
        podName,
        nodeName: opts.nodeName,
        namespace: opts.namespace,
        attempt,
        maxRetries: CLEANUP_MAX_RETRIES,
        error: errMsg,
      });

      if (attempt < CLEANUP_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, CLEANUP_RETRY_INTERVAL_MS));
      }
    }
  }

  console.warn("[debug-pod] cleanup exhausted retries, relying on activeDeadlineSeconds", {
    podName,
    nodeName: opts.nodeName,
    namespace: opts.namespace,
  });
  return false;
}

// ── Pod cache types ─────────────────────────────────────────────────

export interface CachedPod {
  podName: string;
  namespace: string;
  nodeName: string;
  userId: string;
  env: ExecEnv;
  idleTimer: ReturnType<typeof setTimeout>;
}

// ── Pod reuse cache (with integrated concurrency limiter) ───────────

/**
 * In-memory cache for reusable debug pods, keyed by "userId:nodeName".
 *
 * Owns both the pod cache AND the concurrency limiter. This ensures
 * acquire/release is always paired with set/remove/evict — callers
 * never need to manage the limiter separately.
 *
 * - acquire(): reserves a slot (throws if already held)
 * - set(): stores a pod and starts its idle timer (slot must be held)
 * - remove(): clears cache entry AND releases the limiter slot
 * - evict(): remove + delete the pod via kubectl
 *
 * Process crash loses all state — activeDeadlineSeconds is the safety net.
 */
export class DebugPodCache {
  private readonly pods = new Map<string, CachedPod>();
  private readonly active = new Set<string>();

  private key(userId: string, nodeName: string): string {
    return `${userId}:${nodeName}`;
  }

  /**
   * Reserve a concurrency slot. Throws if a pod is already active
   * for this (userId, nodeName) pair.
   */
  acquire(userId: string, nodeName: string): void {
    const k = this.key(userId, nodeName);
    if (this.active.has(k)) {
      throw new Error(
        `A debug pod is already running for user "${userId}" on node "${nodeName}". Wait for it to complete.`,
      );
    }
    this.active.add(k);
  }

  /**
   * Store a newly created pod in the cache and start its idle timer.
   * The concurrency slot must already be held via acquire().
   */
  set(
    userId: string,
    nodeName: string,
    podName: string,
    namespace: string,
    env: ExecEnv,
    idleTimeoutMs: number,
  ): void {
    const k = this.key(userId, nodeName);
    const existing = this.pods.get(k);
    if (existing) clearTimeout(existing.idleTimer);

    const entry: CachedPod = {
      podName,
      namespace,
      nodeName,
      userId,
      env,
      idleTimer: setTimeout(() => this.evict(k), idleTimeoutMs),
    };
    if (entry.idleTimer && typeof entry.idleTimer === "object" && "unref" in entry.idleTimer) {
      entry.idleTimer.unref();
    }
    this.pods.set(k, entry);
  }

  /**
   * Look up a cached pod. Returns undefined if no entry exists.
   * Does NOT reset the idle timer — call touch() after successful exec.
   */
  get(userId: string, nodeName: string): CachedPod | undefined {
    return this.pods.get(this.key(userId, nodeName));
  }

  /**
   * Reset the idle timer for an existing cache entry.
   * Called after each successful kubectl exec to keep the pod alive.
   */
  touch(userId: string, nodeName: string, idleTimeoutMs: number): void {
    const k = this.key(userId, nodeName);
    const entry = this.pods.get(k);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => this.evict(k), idleTimeoutMs);
    if (entry.idleTimer && typeof entry.idleTimer === "object" && "unref" in entry.idleTimer) {
      entry.idleTimer.unref();
    }
  }

  /**
   * Remove a cache entry, clear its timer, and release the concurrency slot.
   * Does NOT delete the pod — used when the caller handles deletion externally.
   */
  remove(userId: string, nodeName: string): void {
    const k = this.key(userId, nodeName);
    const entry = this.pods.get(k);
    if (entry) {
      clearTimeout(entry.idleTimer);
      this.pods.delete(k);
    }
    this.active.delete(k);
  }

  /**
   * Evict a cache entry by key: release slot, delete the pod, remove from cache.
   * Called by the idle timer. Errors are logged but not thrown.
   */
  private async evict(key: string): Promise<void> {
    const entry = this.pods.get(key);
    if (!entry) return;
    this.pods.delete(key);
    this.active.delete(key);

    console.info("[debug-pod] idle eviction", {
      podName: entry.podName,
      nodeName: entry.nodeName,
      namespace: entry.namespace,
      userId: entry.userId,
    });

    await deleteDebugPod(entry.podName, entry.env, {
      namespace: entry.namespace,
      nodeName: entry.nodeName,
    });
  }

  /** Check if a concurrency slot is held (for testing/diagnostics). */
  isHeld(userId: string, nodeName: string): boolean {
    return this.active.has(this.key(userId, nodeName));
  }

  /** Number of cached pods (for testing/diagnostics). */
  get size(): number {
    return this.pods.size;
  }

  /**
   * Evict all cached pods immediately. Used for graceful shutdown.
   */
  async evictAll(): Promise<void> {
    const keys = [...this.pods.keys()];
    await Promise.allSettled(keys.map((k) => this.evict(k)));
  }
}

/** Singleton pod cache — shared across all callers in the same process. */
export const debugPodCache = new DebugPodCache();

// ── Garbage Collection ──────────────────────────────────────────────

const GC_INTERVAL_MS = 60_000;
const GC_PROBE_TIMEOUT_MS = 5_000;
const GC_LIST_TIMEOUT_MS = 15_000;

/**
 * Background garbage collector for orphaned debug pods.
 *
 * Wired in agentbox-main.ts and cli-main.ts only. Local mode
 * (Gateway + LocalSpawner) does not start GC — activeDeadlineSeconds
 * is the sole cleanup mechanism in that configuration.
 *
 * Runs a sweep every 60 seconds. Targets pods matching:
 *   siclaw.io/component=debug-pod
 * and deletes:
 *   (1) Pods in Succeeded or Failed phase (terminal — delete immediately)
 *   (2) Running/Unknown pods whose creationTimestamp age > config.debugPodTTL seconds
 *
 * GC does NOT consult DebugPodCache — it operates purely on kubectl label queries.
 * activeDeadlineSeconds is the ultimate safety net; GC is best-effort acceleration.
 *
 * Process lifecycle:
 *   - start(): verifies cluster access, then schedules sweep immediately + every 60s
 *   - stop(): clears interval; does NOT attempt a final sweep (process is exiting)
 *   - Timer uses .unref() so it does not prevent process exit
 */
export class DebugPodGC {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private credentialsDir: string | undefined;

  /**
   * Start the GC loop.
   *
   * Accepts credentialsDir instead of a fixed ExecEnv — kubeconfig is resolved
   * dynamically on each sweep because credentials may not exist at startup
   * (gateway pushes them when a session is created).
   *
   * The startup probe uses `kubectl version --client` which doesn't need
   * cluster access, only verifies kubectl binary is available.
   */
  async start(credentialsDir?: string): Promise<void> {
    this.credentialsDir = credentialsDir;

    // Verify kubectl binary is available (--client doesn't need cluster access)
    const probeEnv = prepareExecEnv();
    try {
      await kubectlExec(["version", "--client"], probeEnv, GC_PROBE_TIMEOUT_MS);
    } catch {
      return;
    }

    // Run first sweep immediately to catch orphans from a previous crash
    void this.sweep().catch((err) => {
      console.warn("[debug-pod-gc] initial sweep error", { error: String(err) });
    });

    this.intervalHandle = setInterval(() => {
      void this.sweep().catch((err) => {
        console.warn("[debug-pod-gc] sweep error", { error: String(err) });
      });
    }, GC_INTERVAL_MS);

    if (
      this.intervalHandle &&
      typeof this.intervalHandle === "object" &&
      "unref" in this.intervalHandle
    ) {
      (this.intervalHandle as NodeJS.Timeout).unref();
    }
  }

  /** Stop the GC loop. Clears the interval; any in-progress sweep runs to completion. */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Perform a single GC sweep.
   *
   * Resolves kubeconfig dynamically on each call — credentials may arrive
   * after agentbox startup (gateway pushes them on session creation).
   * If kubeconfig is not yet available, the sweep silently skips.
   */
  async sweep(): Promise<void> {
    const env = prepareExecEnv(
      this.credentialsDir ? { credentialsDir: this.credentialsDir } : undefined,
    );
    // No kubeconfig available yet — credentials not pushed, skip silently
    if (!env.kubeconfigPath) return;
    const config = loadConfig();
    const { debugNamespace, debugPodTTL } = config;

    // Use component label only — each agentbox serves a single user,
    // and userId label may not match config (e.g., "unknown" vs "default").
    const labelSelector = `${LABEL_COMPONENT}=${COMPONENT_DEBUG_POD}`;

    let listOutput: string;
    try {
      const result = await kubectlExec(
        ["get", "pods", "-l", labelSelector, "-o", "json"],
        env,
        GC_LIST_TIMEOUT_MS,
        undefined,
        debugNamespace,
      );
      listOutput = result.stdout;
    } catch (err: any) {
      const msg: string = err.stderr?.trim() || err.message || String(err);
      if (msg.includes("not found") || msg.includes("No resources found")) return;
      console.warn("[debug-pod-gc] list failed", { error: msg });
      return;
    }

    let pods: any[];
    try {
      pods = JSON.parse(listOutput).items ?? [];
    } catch {
      console.warn("[debug-pod-gc] failed to parse pod list JSON");
      return;
    }

    const nowMs = Date.now();
    const hardTtlMs = debugPodTTL * 1000;

    const toDelete = pods.filter((pod: any) => {
      const phase: string = pod.status?.phase ?? "";
      if (phase === "Succeeded" || phase === "Failed") return true;
      const createdAt = pod.metadata?.creationTimestamp;
      if (!createdAt) return false;
      const ageMs = nowMs - new Date(createdAt).getTime();
      return ageMs > hardTtlMs;
    });

    if (toDelete.length === 0) return;

    console.info("[debug-pod-gc] sweep deleting pods", {
      count: toDelete.length,
      namespace: debugNamespace,
    });

    await Promise.allSettled(
      toDelete.map(async (pod: any) => {
        const podName: string = pod.metadata?.name ?? "";
        const nodeName: string = pod.spec?.nodeName ?? "unknown";
        if (!podName) return;

        const ok = await deleteDebugPod(podName, env, {
          namespace: debugNamespace,
          nodeName,
        });
        if (!ok) {
          console.warn("[debug-pod-gc] delete failed, will retry next cycle", {
            podName,
            nodeName,
            namespace: debugNamespace,
          });
        } else {
          console.info("[debug-pod-gc] deleted orphaned pod", {
            podName,
            nodeName,
            namespace: debugNamespace,
          });
        }
      }),
    );
  }
}

/** Singleton GC instance — shared across all callers in the same process. */
export const debugPodGC = new DebugPodGC();
