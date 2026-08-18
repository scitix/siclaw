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
/** Per-Job unique id, so we can find a Job's pod by label across K8s versions. */
export const LABEL_DEBUG_ID = "siclaw.io/debug-id";

// ── Label value constants ────────────────────────────────────────────

export const COMPONENT_DEBUG_POD = "debug-pod";
export const MANAGED_BY_SICLAW = "siclaw";

/**
 * Seconds after a debug Job finishes (Complete or Failed — e.g. it hit
 * activeDeadlineSeconds, or its owner was deleted) before the cluster's own
 * TTL-after-finished controller deletes the Job and its pod. This is what makes
 * orphaned debug pods self-clean — no external GC, on every cluster natively.
 */
export const DEBUG_JOB_FINISHED_TTL_SECONDS = 60;

// ── Resource limit constants ────────────────────────────────────────
// No requests — let the scheduler place the pod freely.
// Generous limits because nsenter'd processes (lsof, find, etc.) run under
// the debug pod's cgroup despite operating in host namespaces.
export const DEBUG_POD_RESOURCE_LIMITS = { cpu: "2", memory: "4Gi" };

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

/**
 * Build the debug Job manifest. A Job (not a bare Pod) so the cluster's own
 * TTL-after-finished controller self-cleans it: activeDeadlineSeconds bounds the
 * run; when the Job finishes (deadline, or owner deletion), ttlSecondsAfterFinished
 * makes the control plane delete the Job and its pod — no external GC, every cluster.
 */
export function buildDebugJobManifest(
  jobName: string,
  labels: Record<string, string>,
  image: string,
  activeDeadlineSeconds: number,
  nodeName: string,
): Record<string, unknown> {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: jobName, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds,
      ttlSecondsAfterFinished: DEBUG_JOB_FINISHED_TTL_SECONDS,
      template: {
        metadata: { labels },
        spec: {
          nodeName,
          hostPID: true,
          hostNetwork: true,
          restartPolicy: "Never",
          containers: [{
            name: "debug",
            image,
            securityContext: { privileged: true },
            command: ["sleep", "infinity"],
            resources: { limits: DEBUG_POD_RESOURCE_LIMITS },
          }],
        },
      },
    },
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
 * Delete a debug Job with retry; its pod is cascade-deleted via ownerReference.
 * On each failure, logs structured error data. After exhausting retries, logs a
 * final warning but does NOT throw — the Job's activeDeadlineSeconds +
 * ttlSecondsAfterFinished are the safety net (the cluster cleans it up regardless).
 *
 * Note: does not support AbortSignal. Worst-case retry loop is 6s (3 × 2s).
 * Callers on shutdown paths (evictAll) use Promise.allSettled; awaits may be
 * truncated by process exit, which is acceptable since the Job self-cleans.
 */
export async function deleteDebugJob(
  jobName: string,
  env: ExecEnv,
  opts: {
    namespace: string;
    nodeName: string;
    force?: boolean;
  },
): Promise<boolean> {
  const deleteArgs = [
    "delete", "job", jobName,
    ...(opts.force ? ["--force", "--grace-period=0"] : []),
  ];

  for (let attempt = 1; attempt <= CLEANUP_MAX_RETRIES; attempt++) {
    try {
      await kubectlExec(deleteArgs, env, 10_000, undefined, opts.namespace);
      return true;
    } catch (err: any) {
      const errMsg = err.stderr?.trim() || err.message || String(err);
      // Job already gone — treat as success
      if (errMsg.includes("not found")) return true;

      console.error("[debug-pod] cleanup failed", {
        jobName,
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

  console.warn("[debug-pod] cleanup exhausted retries, relying on Job ttlSecondsAfterFinished", {
    jobName,
    nodeName: opts.nodeName,
    namespace: opts.namespace,
  });
  return false;
}

/**
 * Resolve the pod created by a debug Job, by our unique debug-id label. The Job
 * controller creates the pod asynchronously, so poll briefly until it appears
 * (a Pending pod counts — waitForPodDone then handles Running / fast-fail).
 * Throws on timeout / abort.
 */
async function resolveJobPodName(
  debugId: string,
  env: ExecEnv,
  namespace: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let interval = 250;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Aborted");
    try {
      const { stdout } = await kubectlExec(
        ["get", "pods", "-l", `${LABEL_DEBUG_ID}=${debugId}`, "-o", "jsonpath={.items[0].metadata.name}"],
        env, 5_000, undefined, namespace,
      );
      const name = stdout.trim();
      if (name) return name;
    } catch {
      // pod not created yet / transient kubectl error — keep polling
    }
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(interval * 1.5, 2_000);
  }
  throw new Error(`Debug Job pod (id ${debugId}) did not appear within ${Math.round(timeoutMs / 1000)}s`);
}

// ── Pod cache types ─────────────────────────────────────────────────

export interface CachedPod {
  /** The Job that owns the debug pod — deleted on eviction (cascades to the pod). */
  jobName: string;
  /** The Job's pod, used for kubectl exec. */
  podName: string;
  namespace: string;
  nodeName: string;
  userId: string;
  env: ExecEnv;
  idleTimer: ReturnType<typeof setTimeout>;
  /** Idle timeout used to (re)arm the timer — stored so evict/release can re-arm. */
  idleTimeoutMs: number;
  /**
   * Number of in-flight holders that must not have the pod evicted (e.g. a background
   * node_exec job streaming a long `kubectl exec`). While > 0 the idle timer is disarmed;
   * evict() refuses to delete and re-arms instead. acquire()/release() manage it.
   */
  refCount: number;
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
    jobName: string,
    podName: string,
    namespace: string,
    env: ExecEnv,
    idleTimeoutMs: number,
  ): void {
    const k = this.key(userId, clusterKey, nodeName);
    const existing = this.pods.get(k);
    if (existing) clearTimeout(existing.idleTimer);

    const entry: CachedPod = {
      jobName,
      podName,
      namespace,
      nodeName,
      userId,
      env,
      idleTimer: setTimeout(() => this.evict(k), idleTimeoutMs),
      idleTimeoutMs,
      refCount: 0,
    };
    if (entry.idleTimer && typeof entry.idleTimer === "object" && "unref" in entry.idleTimer) {
      entry.idleTimer.unref();
    }
    this.pods.set(k, entry);
  }

  /**
   * Pin a cached pod so the idle timer cannot evict it while a long-running holder
   * (e.g. a background node_exec job) is using it. Disarms the idle timer. Returns the
   * pinned pod's NAME (null if no entry), so the caller releases that exact pod — pinning
   * and releasing the same instance even if the cache entry is later replaced. Pair every
   * acquire() with a release().
   */
  acquire(userId: string, clusterKey: string, nodeName: string): string | null {
    const entry = this.pods.get(this.key(userId, clusterKey, nodeName));
    if (!entry) return null;
    entry.refCount++;
    clearTimeout(entry.idleTimer);
    return entry.podName;
  }

  /**
   * Release a pin. When the count reaches 0, re-arm the idle timer so the pod is
   * eventually reclaimed. Idempotent-safe (won't go below 0).
   *
   * `expectedPodName` guards against decrementing the WRONG pod: if the pinned pod
   * died (deadline) and a fresh pod replaced it under the same cache key, a late
   * release from the old job must NOT steal a ref from the replacement (which could
   * drop its count to 0 and let evict() delete a pod another job is still using).
   * When the current entry is a different pod, the release is a no-op.
   */
  release(userId: string, clusterKey: string, nodeName: string, expectedPodName?: string): void {
    const entry = this.pods.get(this.key(userId, clusterKey, nodeName));
    if (!entry) return;
    if (expectedPodName !== undefined && entry.podName !== expectedPodName) return;
    if (entry.refCount > 0) entry.refCount--;
    if (entry.refCount === 0) this.armIdle(entry, this.key(userId, clusterKey, nodeName));
  }

  /** (Re)arm the idle eviction timer for an entry. */
  private armIdle(entry: CachedPod, key: string): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => this.evict(key), entry.idleTimeoutMs);
    if (entry.idleTimer && typeof entry.idleTimer === "object" && "unref" in entry.idleTimer) {
      entry.idleTimer.unref();
    }
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
   * Evict a cache entry by key: delete the Job (cascades to the pod), remove
   * from cache. Called by the idle timer. Errors are logged but not thrown.
   *
   * Note: the cache entry is removed BEFORE deleteDebugJob completes.
   * During the deletion window (up to 6s), a concurrent getOrCreate may
   * create a second Job on the same node. This is harmless — the old Job
   * self-cleans via ttlSecondsAfterFinished as a hard safety net.
   * Moving pods.delete after deleteDebugJob would risk returning a stale
   * (being-deleted) entry to concurrent get() callers, which is worse.
   */
  private async evict(key: string): Promise<void> {
    const entry = this.pods.get(key);
    if (!entry) return;
    // Pinned by an in-flight holder (e.g. a background job streaming a long exec) —
    // do not delete; re-arm so we retry after the next idle window.
    if (entry.refCount > 0) {
      this.armIdle(entry, key);
      return;
    }
    clearTimeout(entry.idleTimer);
    this.pods.delete(key);

    console.info("[debug-pod] idle eviction", {
      jobName: entry.jobName,
      podName: entry.podName,
      nodeName: entry.nodeName,
      namespace: entry.namespace,
      userId: entry.userId,
    });

    await deleteDebugJob(entry.jobName, entry.env, {
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
/**
 * Phase 0 only: ensure a reusable debug pod exists & is Running on the node, returning
 * its CachedPod. Extracted from runInDebugPod so background node_exec can ensure+pin a
 * pod and then build its own (detached, streamed) `kubectl exec`. Throws on failure
 * (creation error carries .stdout/.stderr/.code; "didn't start" is a plain Error).
 */
export async function ensureDebugPodReady(
  spec: DebugPodSpec,
  env: ExecEnv,
  opts: { signal?: AbortSignal },
): Promise<CachedPod> {
  const config = loadConfig();
  const image = spec.image || config.debugImage;
  const clusterKey = spec.clusterKey || "default";
  const debugNamespace = config.debugNamespace;
  const idleTimeoutMs = config.debugPodIdleTimeout * 1000;

  // A node that just failed to host a debug pod is not asked again straight away — replay the
  // detail instead, and say that is what happened so the answer is not mistaken for a fresh probe.
  const key = memoKey(spec);
  const remembered = lookupStartupFailure(key);
  if (remembered) throw remembered;

  let result;
  try {
    result = await debugPodCache.getOrCreate(
    spec.userId,
    clusterKey,
    spec.nodeName,
    async () => {
      // Re-checked HERE, not only before getOrCreate: its wait loop promotes a queued waiter to
      // creator once the first creator fails, and that waiter would otherwise pay the full
      // create + schedule + wait budget again — the exact repetition the memo exists to stop.
      const rememberedInLock = lookupStartupFailure(key);
      if (rememberedInLock) throw rememberedInLock;

      const debugId = randomBytes(4).toString("hex");
      const jobName = `node-debug-${debugId}`;
      const labels = { ...buildDebugPodLabels(spec.userId, spec.nodeName), [LABEL_DEBUG_ID]: debugId };

      // A Job (not a bare Pod) so the cluster self-cleans it: when the pod hits
      // activeDeadlineSeconds (or its owner is deleted), the Job finishes and
      // ttlSecondsAfterFinished deletes it — no external GC, on every cluster.
      const manifest = JSON.stringify(
        buildDebugJobManifest(jobName, labels, image, config.debugPodTTL, spec.nodeName),
      );

      try {
        await ensureDebugNamespace(debugNamespace, env);

        await spawnAsync(
          "kubectl",
          [...env.kubeconfigArgs, "-n", debugNamespace, "create", "-f", "-"],
          30_000,
          env.childEnv,
          opts.signal,
          manifest,
        );

        // The Job controller creates the pod asynchronously — resolve its name by
        // our unique label (works across K8s versions, not relying on job-name).
        const podName = await resolveJobPodName(
          debugId, env, debugNamespace, config.debugPodStartupTimeout * 1000, opts.signal,
        );

        // Pod startup gets its OWN bounded budget (config.debugPodStartupTimeout),
        // not the command's timeoutMs — so a pod stuck pulling/scheduling fails fast
        // within ~a minute instead of holding the tool call for the full command
        // timeout. detectFatalPodStartupFailure also short-circuits known fatal
        // reasons (ImagePullBackOff / Unschedulable / config errors) even sooner.
        const phase = await waitForPodDone(
          podName, config.debugPodStartupTimeout * 1000, env.childEnv, opts.signal,
          env.kubeconfigPath ?? undefined, debugNamespace, "Running",
        );

        if (phase !== "Running") {
          await deleteDebugJob(jobName, env, {
            namespace: debugNamespace,
            nodeName: spec.nodeName,
            force: true,
          });
          // Carry the phase out. Discarding it left one sentence for every startup failure, so a
          // pod that reached a terminal phase read exactly like an API error.
          throw new Error(
            `Debug pod "${podName}" reached terminal phase=${phase || "unknown"} before it was Running.`,
          );
        }

        // Store in cache — idle timer starts now
        debugPodCache.set(spec.userId, clusterKey, spec.nodeName, jobName, podName, debugNamespace, env, idleTimeoutMs);
      } catch (err) {
        // Creation failed — best-effort cleanup (the Job self-cleans regardless)
        await deleteDebugJob(jobName, env, {
          namespace: debugNamespace,
          nodeName: spec.nodeName,
          force: true,
        }).catch(() => {});
        throw err; // re-throw so getOrCreate reports failure; waiters will retry
      }
    },
  );

  } catch (err) {
    // Aborts say nothing about the node, so they are not remembered.
    const message = err instanceof Error ? err.message : String(err);
    if (opts.signal?.aborted || /^Aborted/i.test(message)) throw err;
    // A replayed memo entry must not be re-remembered: doing so would refresh its timestamp on every
    // caller (so it never ages out under load) and append the "unchanged from an attempt …" suffix
    // to a message that already carries one.
    if (err instanceof DebugPodStartupError && err.cached) throw err;
    const { stage, reason } = classifyStartupFailure(message);
    const startupError = err instanceof DebugPodStartupError
      ? err
      : new DebugPodStartupError(message, stage, reason, spec.nodeName);
    rememberStartupFailure(key, startupError);
    throw startupError;
  }

  if (!result.pod) {
    const failure = new DebugPodStartupError(
      `Debug pod failed to start on node "${spec.nodeName}" (no pod was created and no error was reported).`,
      "unknown",
      "no_pod_created",
      spec.nodeName,
    );
    rememberStartupFailure(key, failure);
    throw failure;
  }
  // Started: whatever this node failed with before no longer describes it.
  forgetStartupFailure(key);
  return result.pod;
}

/**
 * A debug pod could not be started. Carries the stage and reason so a caller can report WHICH
 * step failed instead of one sentence for API errors, scheduling, image pulls and admission alike
 * — the agent could not previously tell those apart, and retried all of them the same way.
 */
export class DebugPodStartupError extends Error {
  constructor(
    message: string,
    readonly stage: DebugPodFailureStage,
    readonly reason: string,
    readonly nodeName: string,
    readonly cached = false,
  ) {
    super(message);
    this.name = "DebugPodStartupError";
  }
}

export type DebugPodFailureStage = "create" | "schedule" | "startup" | "unknown";

/**
 * Startup failures remembered per (user, cluster, node) for a short window.
 *
 * A node that cannot host a debug pod does not become able to a second later, and an agent that
 * gets a bare failure will try again — one report showed a third attempt on a node that had
 * already failed twice, each paying the full create + schedule + wait budget. A repeat inside the
 * window replays the original detail instead, and says it is doing so.
 *
 * Deliberately short: a node that has just been uncordoned, or whose image pull has since
 * succeeded, must not stay refused. Aborts are never remembered — they say nothing about the node.
 */
const STARTUP_FAILURE_MEMO_MS = 60_000;
/** Bound on remembered entries — one per (user, cluster, node, image), so a broad sweep is finite. */
const STARTUP_FAILURE_MEMO_MAX = 256;
const startupFailures = new Map<string, { at: number; error: DebugPodStartupError }>();

/**
 * The image is part of the key: `image_pull_failed` is a property of the IMAGE, not the node, so a
 * corrected image must get a fresh attempt instead of inheriting the previous one's refusal.
 */
function memoKey(spec: DebugPodSpec): string {
  const image = spec.image || loadConfig().debugImage;
  return `${spec.userId}|${spec.clusterKey || "default"}|${spec.nodeName}|${image}`;
}

/**
 * Reasons that describe THIS node+image and will not change inside the window.
 *
 * `unknown` and `rejected_by_apiserver` are deliberately absent: an unclassified error may be
 * transient, and an admission or RBAC refusal is a property of the cluster or of our request rather
 * than of the node, so attributing either to the node would refuse a healthy node for the whole
 * window. The safe direction here is to retry, so this is an allow-list.
 */
const MEMOIZABLE_REASONS = new Set([
  "unschedulable",
  "image_pull_failed",
  "container_config_error",
  "startup_timeout",
  "pod_never_appeared",
  "pod_terminated_during_startup",
]);

/** Classify a startup failure from the error text kubectl/our own waiters produced. */
export function classifyStartupFailure(message: string): { stage: DebugPodFailureStage; reason: string } {
  if (/Unschedulable/i.test(message)) return { stage: "schedule", reason: "unschedulable" };
  if (/ImagePull|ErrImage|InvalidImageName/i.test(message)) return { stage: "startup", reason: "image_pull_failed" };
  if (/CreateContainerConfigError|CreateContainerError/i.test(message)) return { stage: "startup", reason: "container_config_error" };
  // Two different timeouts, two different stages: the pod never being created is a scheduling-side
  // fact, while a pod that exists and never reaches Running failed during startup. Both used to
  // report "schedule", which pointed the reader at the wrong step.
  if (/did not appear within/i.test(message)) return { stage: "schedule", reason: "pod_never_appeared" };
  if (/Timed out waiting for pod/i.test(message)) return { stage: "startup", reason: "startup_timeout" };
  if (/forbidden|admission|denied/i.test(message)) return { stage: "create", reason: "rejected_by_apiserver" };
  if (/terminal phase|phase=/i.test(message)) return { stage: "startup", reason: "pod_terminated_during_startup" };
  return { stage: "unknown", reason: "unknown" };
}

/**
 * Remember a startup failure for this node+image, if the reason is one that will still be true in a
 * minute — see {@link MEMOIZABLE_REASONS}. A reason outside that set is dropped, so the next caller
 * retries normally.
 *
 * Aborts must never reach here: they say nothing about the node, and remembering one would refuse a
 * healthy node for the whole window.
 */
export function rememberStartupFailure(key: string, error: DebugPodStartupError): void {
  if (!MEMOIZABLE_REASONS.has(error.reason)) return;
  // Expired entries are also dropped on read, but a key that is never queried again would otherwise
  // sit here for the process's lifetime.
  const now = Date.now();
  for (const [k, v] of startupFailures) {
    if (now - v.at >= STARTUP_FAILURE_MEMO_MS) startupFailures.delete(k);
  }
  if (startupFailures.size >= STARTUP_FAILURE_MEMO_MAX) {
    const oldest = startupFailures.keys().next();
    if (!oldest.done) startupFailures.delete(oldest.value);
  }
  startupFailures.set(key, { at: now, error });
}

/**
 * The remembered failure for this node, as the error to raise in place of another attempt — or null
 * when there is none or it has aged out. Expired entries are dropped on read, so a node is not
 * refused twice for the same stale reason.
 */
export function lookupStartupFailure(key: string): DebugPodStartupError | null {
  const remembered = startupFailures.get(key);
  if (!remembered) return null;
  const ageMs = Date.now() - remembered.at;
  if (ageMs >= STARTUP_FAILURE_MEMO_MS) {
    startupFailures.delete(key);
    return null;
  }
  return new DebugPodStartupError(
    `${remembered.error.message} (unchanged from an attempt ${Math.round(ageMs / 1000)}s ago on this node; `
      + `not retried. It will be retried after ${Math.round(STARTUP_FAILURE_MEMO_MS / 1000)}s, or use a different node / transport.)`,
    remembered.error.stage,
    remembered.error.reason,
    remembered.error.nodeName,
    true,
  );
}

/** Forget this node's remembered failure — it started, so the old reason no longer describes it. */
export function forgetStartupFailure(key: string): void {
  startupFailures.delete(key);
}

/** Test seam: forget every remembered startup failure. */
export function resetStartupFailureMemo(): void {
  startupFailures.clear();
}

/** Test seam: how many failures are currently remembered (asserts the map stays bounded). */
export function startupFailureMemoSize(): number {
  return startupFailures.size;
}

/** Key a memo entry by the identity that determines whether a debug pod can start. */
export function startupFailureKey(spec: DebugPodSpec): string {
  return memoKey(spec);
}

/**
 * Pin a node's debug pod (prevent idle eviction) while a background job uses it. Returns the
 * pinned pod's NAME (null if no entry); pass it to {@link releaseDebugPod} so pin and release
 * always target the same pod instance.
 */
export function acquireDebugPod(spec: DebugPodSpec): string | null {
  return debugPodCache.acquire(spec.userId, spec.clusterKey || "default", spec.nodeName);
}

/**
 * Release a pin acquired via {@link acquireDebugPod}. Pass the pod name that was pinned
 * (e.g. the `podName` from {@link ensureDebugPodReady}) so a stale release can't decrement
 * a replacement pod that took over the same cache key.
 */
export function releaseDebugPod(spec: DebugPodSpec, expectedPodName?: string): void {
  debugPodCache.release(spec.userId, spec.clusterKey || "default", spec.nodeName, expectedPodName);
}

export async function runInDebugPod(
  spec: DebugPodSpec,
  env: ExecEnv,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<ExecResult> {
  const config = loadConfig();
  const clusterKey = spec.clusterKey || "default";
  const debugNamespace = config.debugNamespace;
  const idleTimeoutMs = config.debugPodIdleTimeout * 1000;

  // ── Phase 0: Get or create a reusable pod ─────────────────────────
  let cachedPod: CachedPod;
  try {
    cachedPod = await ensureDebugPodReady(spec, env, { signal: opts.signal });
  } catch (err: any) {
    return {
      stdout: err.stdout?.trim() ?? "",
      stderr: err.stderr?.trim() ?? err.message ?? String(err),
      exitCode: typeof err.code === "number" ? err.code : null,
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
    //             (b) numeric exit code with "not found" in stderr (the Job/pod was deleted).
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
        // let the idle timer / Job ttlSecondsAfterFinished handle cleanup instead.
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
