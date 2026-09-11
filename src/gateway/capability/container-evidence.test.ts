import { afterEach, describe, expect, it, vi } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import { containerObservation, ContainerEvidenceQueue, observeContainerLifecycle } from "./container-evidence.js";

const watch = vi.hoisted(() => ({ handlers: new Map<string, (pod: unknown) => void>(), start: vi.fn(async () => {}), stop: vi.fn(async () => {}), get: vi.fn() }));
vi.mock("@kubernetes/client-node", () => ({ makeInformer: () => ({ ...watch, on: (event: string, cb: (pod: unknown) => void) => watch.handlers.set(event, cb) }) }));

function pod(): k8s.V1Pod {
  return {
    metadata: { name: "compile-1", namespace: "work", uid: "pod-1", labels: { "test/agent": "run-1", "test/boxType": "kb-compile" }, annotations: { secret: "private" } },
    spec: { nodeName: "node-1", containers: [{ name: "compiler", image: "box:rev1", env: [{ name: "SECRET", value: "private" }] }], initContainers: [{ name: "init", image: "init:rev1" }], ephemeralContainers: [{ name: "debug", image: "debug:rev1" }] },
    status: { phase: "Failed", message: "private", containerStatuses: [{ name: "compiler", image: "box:rev1", imageID: "containerd://sha256:abc", ready: false, restartCount: 2,
      state: { terminated: { exitCode: 137, reason: "OOMKilled", message: "private", finishedAt: new Date("2026-09-11T01:00:00Z") } },
      lastState: { terminated: { exitCode: 1, reason: "Error" } } }], initContainerStatuses: [{ name: "init", ready: true, restartCount: 0, image: "init:rev1", imageID: "sha256:def", state: { terminated: { exitCode: 0, reason: "Completed" } } }] },
  };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); watch.handlers.clear(); watch.start.mockReset().mockResolvedValue(); watch.get.mockReset(); });

describe("container evidence", () => {
  it("keeps all container roles, previous exits and immutable image/Pod identities without content", () => {
    const snapshot = containerObservation(pod(), "deleted", "test")!;
    expect(snapshot).toMatchObject({ run_id: "run-1", pod_uid: "pod-1", source: "deleted", node_name: "node-1" });
    expect(snapshot.containers.map((c) => c.role)).toEqual(["container", "init", "ephemeral"]);
    expect(snapshot.containers[0]).toMatchObject({ restart_count: 2, image_id: "containerd://sha256:abc", termination: { exit_code: 137, reason: "OOMKilled" }, last_termination: { exit_code: 1 } });
    expect(JSON.stringify(snapshot)).not.toMatch(/private|SECRET|message|annotations/);
    const replaced = pod(); replaced.metadata!.uid = "pod-2";
    expect(containerObservation(replaced, "observed", "test")!.pod_uid).toBe("pod-2");
    replaced.metadata!.labels!["test/boxType"] = "agent";
    expect(containerObservation(replaced, "observed", "test")).toBeUndefined();
  });

  it("deduplicates only acknowledged persistence and allows retry on a later observation", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn().mockRejectedValueOnce(new Error("disconnected")).mockResolvedValueOnce({ observed: false }).mockResolvedValue({ observed: true });
    const queue = new ContainerEvidenceQueue(send);
    const snapshot = containerObservation(pod(), "deleted", "test")!;
    for (let i = 0; i < 4; i++) { queue.record(snapshot); await flush(); }
    expect(send).toHaveBeenCalledTimes(3);
    await queue.close();
  });

  it("replays an outage snapshot after reconnect even when its Pod was deleted", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn().mockRejectedValueOnce(new Error("disconnected")).mockResolvedValue({ observed: true });
    const queue = new ContainerEvidenceQueue(send);
    const snapshot = containerObservation(pod(), "deleted", "test")!;
    queue.record(snapshot); await flush();
    queue.retry(); await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(snapshot);
    queue.retry(); await flush();
    expect(send).toHaveBeenCalledTimes(2);
    await queue.close();
  });

  it("pumps reconnect evidence queued between drain completion and its finalizer", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let acknowledge!: (value: unknown) => void;
    const send = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }))
      .mockResolvedValue({ observed: true });
    const queue = new ContainerEvidenceQueue(send);
    const old = containerObservation(pod(), "deleted", "test")!;
    queue.record(old); await flush();
    queue.record({ ...old, pod_uid: "new-pod" });
    acknowledge({ observed: true });
    queueMicrotask(() => queue.retry());
    await flush(); await flush();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith(old);
    await queue.close();
  });

  it("logs a bounded backlog and shutdown waits only for the active request", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let complete!: (result: unknown) => void;
    const send = vi.fn(() => new Promise((resolve) => { complete = resolve; }));
    const queue = new ContainerEvidenceQueue(send);
    for (let i = 0; i < 300; i++) queue.record({ ...containerObservation(pod(), "observed", "test")!, pod_uid: `pod-${i}` });
    expect(send).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith("[capability-container] queue full; evicting oldest snapshot", expect.any(String));
    expect(logs).toHaveBeenCalledTimes(300);
    const closed = queue.close(); complete({ observed: true }); await closed;
    expect(send).toHaveBeenCalledTimes(1);
    queue.record(containerObservation(pod(), "deleted", "test")!);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("observes deletion and captures stopping without waiting for persistence", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const send = vi.fn(async () => ({ observed: true }));
    const observer = observeContainerLifecycle({} as k8s.KubeConfig, {} as k8s.CoreV1Api, "work", "test", send);
    watch.get.mockReturnValue(pod());
    expect(observer.beforeStop("compile-1")).toBeUndefined();
    await flush();
    watch.handlers.get("delete")!(pod()); await flush();
    expect(send.mock.calls.map(([s]) => (s as unknown as { source: string }).source)).toEqual(["stopping", "deleted"]);
    await observer.stop();
  });

  it("evicts old pending snapshots so a terminal exit survives a watch burst", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let release!: (result: unknown) => void;
    const blocked = new Promise(resolve => { release = resolve; });
    const send = vi.fn().mockImplementationOnce(() => blocked).mockResolvedValue({ observed: true });
    const queue = new ContainerEvidenceQueue(send);
    const snapshot = containerObservation(pod(), "observed", "test")!;
    for (let i = 0; i < 257; i++) queue.record({ ...snapshot, pod_uid: `pod-${i}` });
    const terminal = { ...snapshot, pod_uid: "pod-0", source: "deleted" as const };
    queue.record(terminal);
    release({ observed: true });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(257));
    expect(send).toHaveBeenLastCalledWith(terminal);
    expect(send.mock.calls.some(([event]) => event.pod_uid === "pod-1")).toBe(false);
    await queue.close();
  });

  it("handles rejected watch starts and cancels reconnect on shutdown", async () => {
    vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {});
    watch.start.mockRejectedValueOnce(new Error("watch unavailable"));
    const observer = observeContainerLifecycle({} as k8s.KubeConfig, {} as k8s.CoreV1Api, "work", "test", vi.fn());
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(watch.start).toHaveBeenCalledTimes(2);
    watch.handlers.get("error")!(new Error("expired"));
    await observer.stop(); await vi.advanceTimersByTimeAsync(5000);
    expect(watch.start).toHaveBeenCalledTimes(2);
  });

  it("keeps transport-failed exit evidence when a shared namespace yields 256 declined observations", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const own = { ...containerObservation(pod(), "deleted", "test")!, run_id: "own" };
    const send = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async event => ({ observed: event.run_id === "own" }));
    const queue = new ContainerEvidenceQueue(send);
    queue.record(own); await flush();
    for (let i = 0; i < 256; i++) {
      queue.record({ ...own, run_id: `foreign-${i}`, pod_uid: `foreign-${i}`, source: "observed" });
      await flush();
    }
    queue.retry();
    await vi.waitFor(() => expect(send.mock.calls.filter(([event]) => event.run_id === "own")).toHaveLength(2));
    await queue.close();
  });

  it("bounds explicit declines across reconnects without acknowledging or permanently rejecting the snapshot", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn().mockResolvedValue({ observed: false });
    const queue = new ContainerEvidenceQueue(send);
    const snapshot = containerObservation(pod(), "deleted", "test")!;
    queue.record(snapshot); await flush();
    for (let i = 0; i < 5; i++) { queue.retry(); await flush(); }
    expect(send).toHaveBeenCalledTimes(4); // initial observation + three recovery cycles
    expect(logs).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith("[capability-container] receiver declined replay budget; retained in logs", snapshot.run_id);
    send.mockResolvedValue({ observed: true });
    queue.record(snapshot); await flush(); // a later relist remains eligible
    queue.record({ ...snapshot, pod_uid: "replacement" }); await flush();
    expect(send).toHaveBeenCalledTimes(6);
    await queue.close();
  });

  it("does not consume decline replay opportunities on a watch burst or transport failure", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn().mockResolvedValue({ observed: false });
    const queue = new ContainerEvidenceQueue(send);
    const snapshot = containerObservation(pod(), "deleted", "test")!;
    for (let i = 0; i < 5; i++) { queue.record(snapshot); await flush(); }
    send.mockRejectedValue(new Error("offline"));
    for (let i = 0; i < 5; i++) { queue.retry(); await flush(); }
    expect(send).toHaveBeenCalledTimes(10);
    send.mockResolvedValue({ observed: true }); // legacy ownership claim completed
    queue.retry(); await flush();
    expect(send).toHaveBeenCalledTimes(11);
    queue.retry(); await flush();
    expect(send).toHaveBeenCalledTimes(11);
    await queue.close();
  });

  it("does not let reconnect replay evict fresh watch snapshots from a full pending queue", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let release!: (result: unknown) => void;
    const send = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue({ observed: true });
    const queue = new ContainerEvidenceQueue(send);
    const snapshot = containerObservation(pod(), "deleted", "test")!;
    queue.record(snapshot); await flush();
    for (let i = 0; i < 257; i++) queue.record({ ...snapshot, pod_uid: `fresh-${i}` });
    queue.retry();
    release({ observed: true });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(258));
    expect(send.mock.calls.filter(([event]) => event.pod_uid.startsWith("fresh-"))).toHaveLength(257);
    queue.retry(); await flush();
    expect(send).toHaveBeenCalledTimes(259);
    expect(send).toHaveBeenLastCalledWith(snapshot);
    await queue.close();
  });
});
