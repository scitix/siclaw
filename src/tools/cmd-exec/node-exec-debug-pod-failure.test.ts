import { describe, it, expect, vi } from "vitest";
import type { BackgroundExecExecutor } from "../../core/tool-registry.js";

// A debug pod that will not start is the failure the retro was about. Both node_exec paths must
// report the same structured detail — background used to name the stage while foreground collapsed
// every fault to `debug_pod_failed`, so the same problem read differently depending on a flag the
// caller set for unrelated reasons.
vi.mock("../infra/k8s-checks.js", () => ({ checkNodeReady: vi.fn(async () => null) }));

const ensureDebugPodReady = vi.fn();
vi.mock("../infra/debug-pod.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/debug-pod.js")>("../infra/debug-pod.js");
  return {
    ...actual,
    ensureDebugPodReady: (...a: unknown[]) => ensureDebugPodReady(...a),
    runInDebugPod: vi.fn(),
    acquireDebugPod: vi.fn(() => "node-debug-x"),
    releaseDebugPod: vi.fn(),
  };
});

const { createNodeExecTool } = await import("./node-exec.js");
const { DebugPodStartupError } = await import("../infra/debug-pod.js");

const executor: BackgroundExecExecutor = vi.fn(() => ({ jobId: "j", outputFile: "/o" }));
const wiring = { executor, sessionIdRef: { current: "s1" } };

function parseText(result: { content: unknown[] }): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe("node_exec: a debug pod that will not start", () => {
  it("names the stage, reason, node and replay state on BOTH paths", async () => {
    ensureDebugPodReady.mockRejectedValue(
      new DebugPodStartupError(
        'Debug pod "p" cannot start: Unschedulable', "schedule", "unschedulable", "node-1", true,
      ),
    );

    const results = [
      await createNodeExecTool().execute(
        "t1", { node: "node-1", command: "uptime" }, new AbortController().signal, {} as never,
      ),
      await createNodeExecTool(undefined, "u", wiring).execute(
        "t2", { node: "node-1", command: "uptime", run_in_background: true },
        new AbortController().signal, {} as never,
      ),
    ];

    for (const result of results) {
      const text = parseText(result);
      expect(text.error).toBe(true);
      expect(text.stage).toBe("schedule");
      expect(text.reason).toBe("unschedulable");
      expect(text.node).toBe("node-1");
      // `cached` says this is a replay of a failure this node+image already produced — so a further
      // attempt inside the window will not run either. Reported as `cached`, not `retried`: the
      // previous revision sent `retried: !cached`, which labelled the FIRST failure a retry.
      expect(text.cached).toBe(true);

      // details is stripped before the model sees a tool result, so the text above is what the agent
      // can act on; details carries the same facts for the Trace outcome.
      const details = result.details as Record<string, unknown>;
      expect(details.error).toBe(true);
      expect(details.reason).toBe("unschedulable");
      expect(details.stage).toBe("schedule");
    }
  });

  it("still reports a non-structured failure without inventing a stage", async () => {
    ensureDebugPodReady.mockRejectedValue(new Error("connection reset by peer"));

    const result = await createNodeExecTool().execute(
      "t3", { node: "node-1", command: "uptime" }, new AbortController().signal, {} as never,
    );
    const text = parseText(result);
    expect(text.error).toBe(true);
    expect(text.message).toContain("connection reset by peer");
    expect(text.stage).toBeUndefined();
    expect((result.details as Record<string, unknown>).reason).toBe("debug_pod_failed");
  });
});
