import { describe, it, expect, vi } from "vitest";

// Mock the transport layer so we can inspect the command shape + the abort reap without a cluster.
const spawnMock = vi.fn(() => ({ on: vi.fn(), unref: vi.fn(), kill: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));
vi.mock("../infra/k8s-checks.js", () => ({ checkNodeReady: vi.fn(async () => null) }));

const ensureDebugPodReady = vi.fn(async () => ({ podName: "node-debug-x", namespace: "siclaw-debug" }));
const runInDebugPod = vi.fn();
const acquireDebugPod = vi.fn(() => "node-debug-x");
const releaseDebugPod = vi.fn();
vi.mock("../infra/debug-pod.js", () => ({
  ensureDebugPodReady: (...a: unknown[]) => ensureDebugPodReady(...a),
  runInDebugPod: (...a: unknown[]) => runInDebugPod(...a),
  acquireDebugPod: (...a: unknown[]) => acquireDebugPod(...a),
  releaseDebugPod: (...a: unknown[]) => releaseDebugPod(...a),
}));

const { createNodeExecTool } = await import("./node-exec.js");

describe("node_exec foreground: killable session + abort reap", () => {
  it("runs the host command as a setsid+timeout session and reaps the remote group on abort", async () => {
    const tool = createNodeExecTool();
    const controller = new AbortController();
    // Abort mid-exec (the user clicks Stop) so the abort listener fires the reap.
    runInDebugPod.mockImplementation(async () => {
      controller.abort();
      return { stdout: "", stderr: "", exitCode: null };
    });

    const result = await tool.execute(
      "tc1", { node: "node-1", command: "ib_write_bw -D 60 -F", timeout_seconds: 90 }, controller.signal, {} as never,
    );

    // (1) The command handed to runInDebugPod is a host-namespace setsid session, `timeout`-bounded
    //     at the cap, recording a .pgid — i.e. the same killable shape the background path uses.
    const cmd = (runInDebugPod.mock.calls[0][0] as { command: string[] }).command;
    expect(cmd.slice(0, 3)).toEqual(["nsenter", "-t", "1"]); // host namespace
    const joined = cmd.join(" ");
    expect(joined).toContain("setsid sh -c");
    expect(joined).not.toContain("setsid -w");   // portable: no util-linux >= 2.24 dependency
    expect(joined).toContain("timeout 90 ");
    expect(joined).toMatch(/\.pgid/);
    expect(joined).toContain("ib_write_bw -D 60 -F");

    // (2) Abort spawned a FRESH `kubectl exec … nsenter … sh -c <pkill -s …>` into the same pod.
    expect(spawnMock).toHaveBeenCalled();
    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe("kubectl");
    expect(args).toContain("node-debug-x");
    expect(args.join(" ")).toContain("pkill -TERM -s");

    // (3) The pod is PINNED for the exec (so it can't be idle-evicted mid-run) and released after.
    expect(acquireDebugPod).toHaveBeenCalledTimes(1);
    expect(releaseDebugPod).toHaveBeenCalledTimes(1);

    expect((result.details as Record<string, unknown>).error).toBe(true); // "Aborted."
  });
});
