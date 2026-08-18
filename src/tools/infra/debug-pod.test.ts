import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildDebugPodLabels,
  buildDebugJobManifest,
  DebugPodCache,
  LABEL_COMPONENT,
  LABEL_USER_ID,
  LABEL_TARGET_NODE,
  LABEL_MANAGED_BY,
  LABEL_DEBUG_ID,
  COMPONENT_DEBUG_POD,
  MANAGED_BY_SICLAW,
  DEBUG_POD_RESOURCE_LIMITS,
  DEBUG_JOB_FINISHED_TTL_SECONDS,
  classifyStartupFailure,
  DebugPodStartupError,
  rememberStartupFailure,
  lookupStartupFailure,
  forgetStartupFailure,
  resetStartupFailureMemo,
  startupFailureMemoSize,
  startupFailureKey,
} from "./debug-pod.js";

describe("buildDebugJobManifest — self-cleaning Job", () => {
  const labels = { ...buildDebugPodLabels("u", "node-1"), [LABEL_DEBUG_ID]: "abcd1234" };
  const m = buildDebugJobManifest("node-debug-abcd1234", labels, "busybox:1.36", 600, "node-1") as any;

  it("is a Job that the cluster auto-deletes after it finishes", () => {
    expect(m.apiVersion).toBe("batch/v1");
    expect(m.kind).toBe("Job");
    expect(m.spec.activeDeadlineSeconds).toBe(600);          // hard run cap
    expect(m.spec.ttlSecondsAfterFinished).toBe(DEBUG_JOB_FINISHED_TTL_SECONDS); // self-clean
    expect(m.spec.backoffLimit).toBe(0);                     // no retries
  });

  it("carries the privileged host-namespace debug pod template, pinned to the node", () => {
    const pod = m.spec.template.spec;
    expect(pod.nodeName).toBe("node-1");
    expect(pod.hostPID).toBe(true);
    expect(pod.restartPolicy).toBe("Never");
    expect(pod.containers[0].securityContext.privileged).toBe(true);
    expect(pod.containers[0].command).toEqual(["sleep", "infinity"]);
    expect(m.spec.template.metadata.labels[LABEL_DEBUG_ID]).toBe("abcd1234"); // resolvable pod
  });
});

describe("buildDebugPodLabels", () => {
  it("returns all required label keys", () => {
    const labels = buildDebugPodLabels("user-1", "node-1");
    expect(labels[LABEL_COMPONENT]).toBe(COMPONENT_DEBUG_POD);
    expect(labels[LABEL_MANAGED_BY]).toBe(MANAGED_BY_SICLAW);
    expect(labels[LABEL_USER_ID]).toBe("user-1");
    expect(labels[LABEL_TARGET_NODE]).toBe("node-1");
  });

  it("sanitizes invalid chars to dashes", () => {
    const labels = buildDebugPodLabels("user@example.com", "my/node");
    expect(labels[LABEL_USER_ID]).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/);
    expect(labels[LABEL_USER_ID]).toContain("user");
    expect(labels[LABEL_TARGET_NODE]).toContain("my-node");
  });

  it("truncates to 63 chars for K8s compliance", () => {
    const long = "a".repeat(100);
    const labels = buildDebugPodLabels(long, long);
    expect(labels[LABEL_USER_ID].length).toBeLessThanOrEqual(63);
    expect(labels[LABEL_TARGET_NODE].length).toBeLessThanOrEqual(63);
  });

  it("strips leading/trailing non-alphanumeric", () => {
    const labels = buildDebugPodLabels("---user---", "...node...");
    expect(labels[LABEL_USER_ID]).toBe("user");
    expect(labels[LABEL_TARGET_NODE]).toBe("node");
  });

  it("falls back to 'unknown' when sanitized value is empty", () => {
    const labels = buildDebugPodLabels("@@@", "!!!");
    expect(labels[LABEL_USER_ID]).toBe("unknown");
    expect(labels[LABEL_TARGET_NODE]).toBe("unknown");
  });
});

describe("DEBUG_POD_RESOURCE_LIMITS", () => {
  it("sets generous limits for nsenter'd processes", () => {
    expect(DEBUG_POD_RESOURCE_LIMITS).toEqual({ cpu: "2", memory: "4Gi" });
  });
});

describe("DebugPodCache — lock + eviction mechanics", () => {
  let cache: DebugPodCache;
  let originalLog: any;
  let originalInfo: any;

  beforeEach(() => {
    cache = new DebugPodCache();
    // Silence structured logs emitted by eviction paths
    originalLog = console.error;
    originalInfo = console.info;
    console.error = () => {};
    console.info = () => {};
  });

  afterEach(() => {
    // Clear idle timers without triggering evict() (which calls kubectl).
    // Use remove() to drop cache entries and clear timers only.
    for (const key of ["u:c:n", "u1:c1:n1", "u1:c1:n2", "u2:c1:n1"]) {
      const [u, c, n] = key.split(":");
      cache.remove(u, c, n);
    }
    console.error = originalLog;
    console.info = originalInfo;
  });

  it("initial size is 0", () => {
    expect(cache.size).toBe(0);
  });

  it("isCreating returns false for unknown key", () => {
    expect(cache.isCreating("u", "c", "n")).toBe(false);
  });

  it("getOrCreate invokes factory exactly once concurrently", async () => {
    let callCount = 0;
    const factory = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
      cache.set("u", "c", "n", "job-pod-1", "pod-1", "ns", {} as any, 60_000);
    };
    const [a, b, c] = await Promise.all([
      cache.getOrCreate("u", "c", "n", factory),
      cache.getOrCreate("u", "c", "n", factory),
      cache.getOrCreate("u", "c", "n", factory),
    ]);
    expect(callCount).toBe(1);
    // Exactly one caller receives created=true; others reuse
    const createdCount = [a, b, c].filter(r => r.created).length;
    expect(createdCount).toBe(1);
    // All resolve to same pod
    expect(a.pod?.podName).toBe("pod-1");
    expect(b.pod?.podName).toBe("pod-1");
  });

  it("get returns cached entry", () => {
    cache.set("u", "c", "n", "job-pod-1", "pod-1", "ns", {} as any, 60_000);
    const got = cache.get("u", "c", "n");
    expect(got?.podName).toBe("pod-1");
    expect(cache.size).toBe(1);
  });

  it("get returns undefined for unknown key", () => {
    expect(cache.get("u", "c", "n")).toBeUndefined();
  });

  it("touch resets idle timer", () => {
    cache.set("u", "c", "n", "job-pod-1", "pod-1", "ns", {} as any, 60_000);
    const e1 = cache.get("u", "c", "n");
    const originalTimer = e1?.idleTimer;
    cache.touch("u", "c", "n", 30_000);
    const e2 = cache.get("u", "c", "n");
    expect(e2?.idleTimer).not.toBe(originalTimer);
  });

  it("touch is a no-op on missing entry", () => {
    expect(() => cache.touch("u", "c", "n", 1000)).not.toThrow();
  });

  it("remove deletes cache entry but does not delete pod", () => {
    cache.set("u", "c", "n", "job-pod-1", "pod-1", "ns", {} as any, 60_000);
    expect(cache.size).toBe(1);
    cache.remove("u", "c", "n");
    expect(cache.size).toBe(0);
  });

  it("set replaces previous entry (clears old timer)", () => {
    cache.set("u", "c", "n", "job-pod-1", "pod-1", "ns", {} as any, 60_000);
    cache.set("u", "c", "n", "job-pod-2", "pod-2", "ns", {} as any, 60_000);
    expect(cache.size).toBe(1);
    expect(cache.get("u", "c", "n")?.podName).toBe("pod-2");
  });

  it("different triples get isolated entries", () => {
    cache.set("u1", "c1", "n1", "job-pod-A", "pod-A", "ns", {} as any, 60_000);
    cache.set("u1", "c1", "n2", "job-pod-B", "pod-B", "ns", {} as any, 60_000);
    cache.set("u2", "c1", "n1", "job-pod-C", "pod-C", "ns", {} as any, 60_000);
    expect(cache.size).toBe(3);
    expect(cache.get("u1", "c1", "n1")?.podName).toBe("pod-A");
    expect(cache.get("u1", "c1", "n2")?.podName).toBe("pod-B");
    expect(cache.get("u2", "c1", "n1")?.podName).toBe("pod-C");
  });

  it("acquire pins (refCount up, idle timer cleared); release re-arms at 0", () => {
    cache.set("u", "c", "n", "job-pod-1", "pod-1", "ns", {} as any, 60_000);
    const armed = cache.get("u", "c", "n")?.idleTimer;
    expect(cache.acquire("u", "c", "n")).toBe("pod-1");
    const e = cache.get("u", "c", "n")!;
    expect(e.refCount).toBe(1);
    // acquire disarmed the idle timer (replaced/cleared) so eviction can't fire while pinned
    cache.acquire("u", "c", "n");
    expect(cache.get("u", "c", "n")?.refCount).toBe(2);
    cache.release("u", "c", "n");
    expect(cache.get("u", "c", "n")?.refCount).toBe(1);
    cache.release("u", "c", "n");
    const after = cache.get("u", "c", "n")!;
    expect(after.refCount).toBe(0);
    expect(after.idleTimer).not.toBe(armed); // re-armed a fresh timer at refCount 0
  });

  it("acquire returns false for a missing entry; release is a no-op", () => {
    expect(cache.acquire("u", "c", "n")).toBeNull();
    expect(() => cache.release("u", "c", "n")).not.toThrow();
  });

  it("release never drives refCount below 0", () => {
    cache.set("u", "c", "n", "job-pod-1", "pod-1", "ns", {} as any, 60_000);
    cache.release("u", "c", "n");
    cache.release("u", "c", "n");
    expect(cache.get("u", "c", "n")?.refCount).toBe(0);
  });

  it("release with a stale podName does NOT steal a ref from the replacement pod", () => {
    cache.set("u", "c", "n", "job-1", "pod-1", "ns", {} as any, 60_000);
    cache.acquire("u", "c", "n");                 // old job pins pod-1
    cache.set("u", "c", "n", "job-2", "pod-2", "ns", {} as any, 60_000); // pod-1 died, pod-2 replaced it (refCount 0)
    cache.acquire("u", "c", "n");                 // a new job pins pod-2 → refCount 1
    cache.release("u", "c", "n", "pod-1");        // stale release for the GONE pod → must be a no-op
    expect(cache.get("u", "c", "n")?.refCount).toBe(1); // pod-2 still pinned
    cache.release("u", "c", "n", "pod-2");        // correct release
    expect(cache.get("u", "c", "n")?.refCount).toBe(0);
  });
});

describe("DebugPodCache — getOrCreate failure paths", () => {
  let cache: DebugPodCache;

  beforeEach(() => {
    cache = new DebugPodCache();
  });

  it("releases lock when factory throws, next caller re-enters", async () => {
    const factory1 = async () => { throw new Error("creation failed"); };
    await expect(
      cache.getOrCreate("u", "c", "n", factory1),
    ).rejects.toThrow("creation failed");
    expect(cache.isCreating("u", "c", "n")).toBe(false);

    // Subsequent call with successful factory works
    const factory2 = async () => {
      cache.set("u", "c", "n", "job-pod-ok", "pod-ok", "ns", {} as any, 60_000);
    };
    const res = await cache.getOrCreate("u", "c", "n", factory2);
    expect(res.pod?.podName).toBe("pod-ok");
    expect(res.created).toBe(true);
  });

  it("waiter gets undefined pod when factory sets nothing", async () => {
    let factoryDone: () => void;
    const factoryPromise = new Promise<void>((r) => { factoryDone = r; });

    // First call won't call set() - simulating "pod didn't reach Running"
    const p1 = cache.getOrCreate("u", "c", "n", async () => {
      await factoryPromise;
      // Intentionally does NOT call cache.set()
    });

    // Wait a tick then start second caller (it should wait on lock)
    await new Promise((r) => setTimeout(r, 1));
    const p2 = cache.getOrCreate("u", "c", "n", async () => {
      cache.set("u", "c", "n", "job-pod-late", "pod-late", "ns", {} as any, 60_000);
    });

    factoryDone!();
    const r1 = await p1;
    expect(r1.pod).toBeUndefined();
    expect(r1.created).toBe(true);

    const r2 = await p2;
    // After first caller fails to set, second caller gets fresh creator slot
    expect(r2.pod?.podName).toBe("pod-late");
  });
});

describe("classifyStartupFailure", () => {
  it("separates the stages an agent would act on differently", () => {
    // One sentence for all of these is what made every failure look like the same problem, and
    // made retrying the only available response.
    expect(classifyStartupFailure('Pod "p" cannot start: Unschedulable — no node can run the pod'))
      .toEqual({ stage: "schedule", reason: "unschedulable" });
    expect(classifyStartupFailure("ImagePullBackOff — manifest unknown"))
      .toEqual({ stage: "startup", reason: "image_pull_failed" });
    expect(classifyStartupFailure("CreateContainerConfigError"))
      .toEqual({ stage: "startup", reason: "container_config_error" });
    // Two timeouts, two stages: a pod that never appeared is a scheduling-side fact, while a pod
    // that exists and never reached Running failed during startup. Both used to say "schedule".
    expect(classifyStartupFailure('Timed out waiting for pod "p" to complete'))
      .toEqual({ stage: "startup", reason: "startup_timeout" });
    expect(classifyStartupFailure("Debug Job pod (id abcd) did not appear within 60s"))
      .toEqual({ stage: "schedule", reason: "pod_never_appeared" });
    expect(classifyStartupFailure('pods "x" is forbidden: admission webhook denied the request'))
      .toEqual({ stage: "create", reason: "rejected_by_apiserver" });
    expect(classifyStartupFailure('Debug pod "p" reached terminal phase=Failed before it was Running.'))
      .toEqual({ stage: "startup", reason: "pod_terminated_during_startup" });
  });

  it("says unknown rather than guessing", () => {
    expect(classifyStartupFailure("connection reset by peer")).toEqual({ stage: "unknown", reason: "unknown" });
  });
});

describe("DebugPodStartupError", () => {
  it("carries the stage, reason and node so a caller need not parse prose", () => {
    const err = new DebugPodStartupError("boom", "schedule", "unschedulable", "node-1");
    expect(err).toBeInstanceOf(Error);
    expect({ stage: err.stage, reason: err.reason, nodeName: err.nodeName, cached: err.cached })
      .toEqual({ stage: "schedule", reason: "unschedulable", nodeName: "node-1", cached: false });
  });
});

describe("startup-failure memo", () => {
  const key = "u|default|node-1";
  const failure = () => new DebugPodStartupError("Unschedulable — taints", "schedule", "unschedulable", "node-1");

  beforeEach(() => { resetStartupFailureMemo(); vi.useRealTimers(); });
  afterEach(() => { resetStartupFailureMemo(); vi.useRealTimers(); });

  it("replays the original detail instead of attempting again", () => {
    rememberStartupFailure(key, failure());
    const replay = lookupStartupFailure(key);
    expect(replay).not.toBeNull();
    // The reason survives verbatim — a fast refusal is only useful if it still says why.
    expect(replay!.reason).toBe("unschedulable");
    expect(replay!.stage).toBe("schedule");
    expect(replay!.message).toContain("Unschedulable — taints");
    // And it admits it is a replay, so the answer is not read as a fresh probe of the node.
    expect(replay!.cached).toBe(true);
    expect(replay!.message).toMatch(/not retried/);
  });

  it("keys by node, so one bad node does not refuse the others", () => {
    rememberStartupFailure(key, failure());
    expect(lookupStartupFailure("u|default|node-2")).toBeNull();
    expect(lookupStartupFailure("other-user|default|node-1")).toBeNull();
    expect(lookupStartupFailure("u|other-cluster|node-1")).toBeNull();
  });

  it("ages out — a node that has since been fixed must not stay refused", () => {
    vi.useFakeTimers();
    rememberStartupFailure(key, failure());
    vi.advanceTimersByTime(59_000);
    expect(lookupStartupFailure(key)).not.toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(lookupStartupFailure(key)).toBeNull();
    // Dropped on read, so the next attempt is not refused for the same stale reason.
    expect(lookupStartupFailure(key)).toBeNull();
  });

  it("is cleared when the node does start", () => {
    rememberStartupFailure(key, failure());
    forgetStartupFailure(key);
    expect(lookupStartupFailure(key)).toBeNull();
  });

  it("keys on the identity that decides whether a pod can start", () => {
    // user + cluster + node + IMAGE. The image belongs in the key because image_pull_failed is a
    // property of the image; without it, a corrected image inherits the bad one's refusal.
    expect(startupFailureKey({ userId: "u", nodeName: "node-1", command: [], clusterKey: "c1", image: "img:1" } as any))
      .toBe("u|c1|node-1|img:1");
    // No clusterKey means the default cluster, not a separate bucket per call.
    expect(startupFailureKey({ userId: "u", nodeName: "node-1", command: [], image: "img:1" } as any))
      .toBe("u|default|node-1|img:1");
    // A different image is a different key.
    expect(startupFailureKey({ userId: "u", nodeName: "node-1", command: [], clusterKey: "c1", image: "img:2" } as any))
      .not.toBe(startupFailureKey({ userId: "u", nodeName: "node-1", command: [], clusterKey: "c1", image: "img:1" } as any));
  });
});

describe("startup-failure memo: what is remembered, and keyed by what", () => {
  beforeEach(() => resetStartupFailureMemo());

  const spec = (over: Record<string, unknown> = {}) =>
    ({ userId: "u1", clusterKey: "c1", nodeName: "n1", command: "true", ...over }) as any;
  const failure = (reason: string, stage = "startup") =>
    new DebugPodStartupError(`failed: ${reason}`, stage as any, reason, "n1");

  it("does not remember a reason that may not still be true in a minute", () => {
    // An unclassified error can be transient, and an admission/RBAC refusal is a property of the
    // cluster or of our request — not of the node. Remembering either refuses a healthy node.
    for (const reason of ["unknown", "rejected_by_apiserver", "no_pod_created"]) {
      rememberStartupFailure(startupFailureKey(spec()), failure(reason));
      expect(lookupStartupFailure(startupFailureKey(spec()))).toBeNull();
    }
  });

  it("remembers the node-scoped reasons", () => {
    for (const reason of ["unschedulable", "image_pull_failed", "container_config_error",
      "startup_timeout", "pod_never_appeared", "pod_terminated_during_startup"]) {
      resetStartupFailureMemo();
      rememberStartupFailure(startupFailureKey(spec()), failure(reason));
      expect(lookupStartupFailure(startupFailureKey(spec()))?.reason).toBe(reason);
    }
  });

  it("keys on the image, so a corrected image is not refused by the previous one's failure", () => {
    // image_pull_failed is a property of the IMAGE. Keying only on the node made a fixed image wait
    // out the window before it could be tried.
    rememberStartupFailure(startupFailureKey(spec({ image: "bad:tag" })), failure("image_pull_failed"));
    expect(lookupStartupFailure(startupFailureKey(spec({ image: "bad:tag" })))).not.toBeNull();
    expect(lookupStartupFailure(startupFailureKey(spec({ image: "good:tag" })))).toBeNull();
  });

  it("bounds the map instead of growing once per node forever", () => {
    for (let i = 0; i < 400; i++) {
      rememberStartupFailure(startupFailureKey(spec({ nodeName: `n${i}` })), failure("unschedulable"));
    }
    expect(startupFailureMemoSize()).toBeLessThanOrEqual(256);
    // The most recent entry survives the eviction.
    expect(lookupStartupFailure(startupFailureKey(spec({ nodeName: "n399" })))).not.toBeNull();
  });
});
