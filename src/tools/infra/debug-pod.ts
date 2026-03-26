/**
 * Debug pod label constants, label builder, and kubectl execution helper.
 *
 * Provides the foundation for structured debug pod lifecycle management:
 * - Standard label keys for all debug pods
 * - Label value sanitization (K8s constraints: ≤63 chars, alphanumeric boundaries)
 * - Thin kubectl wrapper with kubeconfig propagation
 */
import { randomBytes } from "node:crypto";
import { spawnAsync, prepareExecEnv, type ExecEnv, type ExecResult } from "./exec-utils.js";
import { waitForPodDone } from "./k8s-checks.js";
import { loadConfig } from "../../core/config.js";

// ── Label key constants ──────────────────────────────────────────────

export const LABEL_COMPONENT = "siclaw.io/component";
export const LABEL_USER_ID = "siclaw.io/user-id";
export const LABEL_TARGET_NODE = "siclaw.io/target-node";
export const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";

// ── Label value constants ────────────────────────────────────────────

export const COMPONENT_DEBUG_POD = "debug-pod";
export const MANAGED_BY_SICLAW = "siclaw";

// ── Resource limit constants ────────────────────────────────────────
export const DEBUG_POD_RESOURCE_REQUESTS = { cpu: "1m", memory: "1Mi" };
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
 *
 * @internal This is an internal infrastructure helper that bypasses the
 * 6-pass command validation pipeline intentionally. All arguments are
 * programmatically constructed — never pass agent-controlled input.
 */
export function kubectlExec(
  args: string[],
  env: ExecEnv,
  timeoutMs: number,
  signal?: AbortSignal,
  namespace?: string,
  /** Optional data to pipe to kubectl's stdin. */
  stdinData?: string,
): Promise<{ stdout: string; stderr: string }> {
  const nsArgs = namespace ? ["-n", namespace] : [];
  return spawnAsync(
    "kubectl",
    [...env.kubeconfigArgs, ...nsArgs, ...args],
    timeoutMs,
    env.childEnv,
    signal,
    stdinData,
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

// ── Creation lock (internal) ─────────────────────────────────────────
//
// The creating Map tracks in-flight pod creations. Concurrent callers
// wait for the creation to complete, then re-check the cache.
// Once a pod is cached (Running), any number of kubectl exec calls
// can run concurrently against it.

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

// ── Pod reuse cache (with creation-only lock) ───────────────────────

/**
 * In-memory cache for reusable debug pods, keyed by "userId:clusterKey:nodeName".
 *
 * The creation lock ensures only one caller creates a pod for a given
 * (userId, clusterKey, nodeName) triple. Concurrent callers wait for creation to
 * complete, then reuse the cached pod. Once a pod is cached, any number
 * of kubectl exec calls can run concurrently against it.
 *
 * - getOrCreate(): returns a cached pod or creates one (with lock)
 * - touch(): resets idle timer after successful exec
 * - remove(): clears cache entry (caller handles pod deletion)
 * - evict(): remove + delete the pod via kubectl
 *
 * Process crash loses all state — activeDeadlineSeconds is the safety net.
 */
export class DebugPodCache {
  private readonly pods = new Map<string, CachedPod>();
  private readonly creating = new Map<string, Promise<void>>();

  private key(userId: string, clusterKey: string, nodeName: string): string {
    return `${userId}:${clusterKey}:${nodeName}`;
  }

  /**
   * Get a cached pod, or create one using the provided factory.
   *
   * - If a pod is already cached, returns it immediately.
   * - If another caller is creating a pod for this key, waits for
   *   creation to complete, then returns the cached result.
   * - Otherwise, calls createFn() to create a new pod. createFn is
   *   responsible for calling set() on success.
   *
   * Returns { pod, created }:
   *   - pod: the cached pod entry (undefined if creation failed)
   *   - created: true if this call was the one that ran createFn
   */
  async getOrCreate(
    userId: string,
    clusterKey: string,
    nodeName: string,
    createFn: () => Promise<void>,
  ): Promise<{ pod: CachedPod | undefined; created: boolean }> {
    const k = this.key(userId, clusterKey, nodeName);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Check cache first
      const cached = this.pods.get(k);
      if (cached) return { pod: cached, created: false };

      // Another caller is creating — wait and re-check
      const inflight = this.creating.get(k);
      if (inflight) {
        await inflight;
        continue;
      }

      // We are the creator
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      this.creating.set(k, promise);

      try {
        await createFn();
        // createFn should have called set() on success
        return { pod: this.pods.get(k), created: true };
      } finally {
        this.creating.delete(k);
        resolve(); // wake up waiters
      }
    }
  }

  /**
   * Store a newly created pod in the cache and start its idle timer.
   * Called by the createFn passed to getOrCreate().
   */
  set(
    userId: string,
    clusterKey: string,
    nodeName: string,
    podName: string,
    namespace: string,
    env: ExecEnv,
    idleTimeoutMs: number,
  ): void {
    const k = this.key(userId, clusterKey, nodeName);
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
  get(userId: string, clusterKey: string, nodeName: string): CachedPod | undefined {
    return this.pods.get(this.key(userId, clusterKey, nodeName));
  }

  /**
   * Reset the idle timer for an existing cache entry.
   * Called after each successful kubectl exec to keep the pod alive.
   */
  touch(userId: string, clusterKey: string, nodeName: string, idleTimeoutMs: number): void {
    const k = this.key(userId, clusterKey, nodeName);
    const entry = this.pods.get(k);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => this.evict(k), idleTimeoutMs);
    if (entry.idleTimer && typeof entry.idleTimer === "object" && "unref" in entry.idleTimer) {
      entry.idleTimer.unref();
    }
  }

  /**
   * Remove a cache entry and clear its timer.
   * Does NOT delete the pod — used when the caller handles deletion externally.
   */
  remove(userId: string, clusterKey: string, nodeName: string): void {
    const k = this.key(userId, clusterKey, nodeName);
    const entry = this.pods.get(k);
    if (entry) {
      clearTimeout(entry.idleTimer);
      this.pods.delete(k);
    }
  }

  /**
   * Evict a cache entry by key: delete the pod, remove from cache.
   * Called by the idle timer. Errors are logged but not thrown.
   *
   * Note: the cache entry is removed BEFORE deleteDebugPod completes.
   * During the deletion window (up to 6s), a concurrent getOrCreate may
   * create a second pod on the same node. This is harmless — the old pod
   * is being deleted and has activeDeadlineSeconds as a hard safety net.
   * Moving pods.delete after deleteDebugPod would risk returning a stale
   * (being-deleted) entry to concurrent get() callers, which is worse.
   */
  private async evict(key: string): Promise<void> {
    const entry = this.pods.get(key);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    this.pods.delete(key);

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

  /** Check if a pod is being created for this key (for testing/diagnostics). */
  isCreating(userId: string, clusterKey: string, nodeName: string): boolean {
    return this.creating.has(this.key(userId, clusterKey, nodeName));
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

// ── Debug Pod spec & orchestrator ───────────────────────────────────

export interface DebugPodSpec {
  userId: string;
  nodeName: string;
  /** Full command array for the container (including nsenter if needed). */
  command: string[];
  image?: string;
  /** Cluster identifier for cache isolation (credential name). Defaults to "default". */
  clusterKey?: string;
  /** Optional data to pipe via stdin (e.g. script content for stdin-based execution). */
  stdinData?: string;
}

/**
 * Run a command inside a privileged debug pod on a specific node.
 *
 * Uses an always-reuse model with creation-only locking:
 *   - First call for a (userId, clusterKey, nodeName) triple creates a long-lived pod
 *     with `sleep infinity` and caches it.
 *   - Concurrent callers wait for creation to complete, then reuse the pod.
 *   - Multiple kubectl exec calls can run concurrently on a cached pod.
 *   - Idle pods are auto-deleted by DebugPodCache after the configured timeout.
 *   - activeDeadlineSeconds (config.debugPodTTL) is the hard safety net.
 */
export async function runInDebugPod(
  spec: DebugPodSpec,
  env: ExecEnv,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<ExecResult> {
  const config = loadConfig();
  const image = spec.image || config.debugImage;
  const clusterKey = spec.clusterKey || "default";
  const debugNamespace = config.debugNamespace;
  const idleTimeoutMs = config.debugPodIdleTimeout * 1000;

  // ── Phase 0: Get or create a reusable pod ─────────────────────────
  let cachedPod: CachedPod | undefined;
  try {
    const result = await debugPodCache.getOrCreate(
      spec.userId,
      clusterKey,
      spec.nodeName,
      async () => {
        const podId = randomBytes(4).toString("hex");
        const podName = `node-debug-${podId}`;

        const labels = buildDebugPodLabels(spec.userId, spec.nodeName);
        const activeDeadlineSeconds = config.debugPodTTL;

        const overrides = JSON.stringify({
          metadata: { labels },
          spec: {
            activeDeadlineSeconds,
            nodeName: spec.nodeName,
            hostPID: true,
            hostNetwork: true,
            containers: [{
              name: podName,
              image,
              securityContext: { privileged: true },
              command: ["sleep", "infinity"],
              resources: {
                requests: DEBUG_POD_RESOURCE_REQUESTS,
                limits: DEBUG_POD_RESOURCE_LIMITS,
              },
            }],
            restartPolicy: "Never",
          },
        });

        try {
          await ensureDebugNamespace(debugNamespace, env);

          await spawnAsync(
            "kubectl",
            [
              ...env.kubeconfigArgs,
              "-n", debugNamespace,
              "run", podName,
              "--restart=Never",
              `--image=${image}`,
              `--overrides=${overrides}`,
            ],
            30_000,
            env.childEnv,
            opts.signal,
          );

          const phase = await waitForPodDone(
            podName, opts.timeoutMs, env.childEnv, opts.signal,
            env.kubeconfigPath ?? undefined, debugNamespace, "Running",
          );

          if (phase !== "Running") {
            await deleteDebugPod(podName, env, {
              namespace: debugNamespace,
              nodeName: spec.nodeName,
              force: true,
            });
            // Don't call set() — pod failed to start
            return;
          }

          // Store in cache — idle timer starts now
          debugPodCache.set(spec.userId, clusterKey, spec.nodeName, podName, debugNamespace, env, idleTimeoutMs);
        } catch (err) {
          // Creation failed — best-effort cleanup
          await deleteDebugPod(podName, env, {
            namespace: debugNamespace,
            nodeName: spec.nodeName,
            force: true,
          }).catch(() => {});
          throw err; // re-throw so getOrCreate reports failure; waiters will retry
        }
      },
    );
    cachedPod = result.pod;
  } catch (err: any) {
    return {
      stdout: err.stdout?.trim() ?? "",
      stderr: err.stderr?.trim() ?? err.message ?? String(err),
      exitCode: typeof err.code === "number" ? err.code : null,
    };
  }

  // Creation failed (pod didn't reach Running) or waiter got no cached pod
  if (!cachedPod) {
    return {
      stdout: "",
      stderr: `Debug pod failed to start on node "${spec.nodeName}".`,
      exitCode: null,
    };
  }

  const podName = cachedPod.podName;

  // ── Phase 1: Execute command via kubectl exec ─────────────────────
  if (opts.signal?.aborted) {
    return { stdout: "", stderr: "Aborted.", exitCode: null };
  }

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = 0;
  let timedOut = false;

  try {
    const result = await kubectlExec(
      ["exec", ...(spec.stdinData !== undefined ? ["-i"] : []), podName, "--", ...spec.command],
      env,
      opts.timeoutMs,
      opts.signal,
      debugNamespace,
      spec.stdinData,
    );
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = 0;
  } catch (err: any) {
    stdout = err.stdout?.trim() ?? "";
    stderr = err.stderr?.trim() ?? err.message;

    if (typeof err.code === "number") {
      exitCode = err.code;
    } else {
      exitCode = null;
      if (err.code === null && !stderr && !opts.signal?.aborted) {
        timedOut = true;
      }
    }

    // Check if pod is still alive — if gone or in terminal phase, evict stale cache entry.
    // Trigger on: (a) non-numeric exit code (kubectl killed), or
    //             (b) numeric exit code with "not found" in stderr (GC deleted the pod).
    const maybeStale = exitCode === null || (exitCode !== 0 && stderr.includes("not found"));
    if (maybeStale) {
      let podPhase = "";
      try {
        const phaseResult = await kubectlExec(
          ["get", "pod", podName, "-o", "jsonpath={.status.phase}"],
          env,
          5_000,
          undefined,
          debugNamespace,
        );
        podPhase = phaseResult.stdout.trim();
      } catch {
        // Probe failed (network error, pod gone) — don't evict on transient failure,
        // let GC and idle timer handle cleanup instead.
        podPhase = "Unknown";
      }
      if (podPhase === "Succeeded" || podPhase === "Failed" || podPhase === "") {
        debugPodCache.remove(spec.userId, clusterKey, spec.nodeName);
        return { stdout, stderr, exitCode };
      }
    }
  }

  // ── Phase 2: Reset idle timer ─────────────────────────────────────
  debugPodCache.touch(spec.userId, clusterKey, spec.nodeName, idleTimeoutMs);

  return { stdout, stderr, exitCode, ...(timedOut ? { timedOut: true } : {}) };
}

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
 * This means GC may delete a pod that is still in the cache. When this happens,
 * the next kubectl exec against that pod will fail; the stale-pod detection in
 * runInDebugPod evicts the cache entry, and the following call creates a fresh pod.
 * One request fails before auto-recovery — an acceptable trade-off to keep GC
 * decoupled from in-process cache state.
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
    if (this.intervalHandle !== null) return;
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

    // Use component + managed-by labels — each agentbox serves a single user,
    // and userId label may not match config (e.g., "unknown" vs "default").
    const labelSelector = `${LABEL_COMPONENT}=${COMPONENT_DEBUG_POD},${LABEL_MANAGED_BY}=${MANAGED_BY_SICLAW}`;

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
