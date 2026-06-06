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
