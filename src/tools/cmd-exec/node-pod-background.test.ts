import { describe, it, expect, vi } from "vitest";
import { createNodeExecTool } from "./node-exec.js";
import { createPodExecTool } from "./pod-exec.js";
import type { BackgroundExecExecutor } from "../../core/tool-registry.js";

const fakeExecutor: BackgroundExecExecutor = vi.fn(() => ({ jobId: "j", outputFile: "/o" }));
const wiring = { executor: fakeExecutor, sessionIdRef: { current: "s1" } };

describe("node_exec / pod_exec — run_in_background schema gating", () => {
  it("node_exec exposes run_in_background ONLY when an executor is injected", () => {
    const withExec = createNodeExecTool(undefined, "u", wiring);
    const withoutExec = createNodeExecTool(undefined, "u");
    expect((withExec.parameters as any).properties.run_in_background).toBeDefined();
    expect((withoutExec.parameters as any).properties.run_in_background).toBeUndefined();
  });

  it("pod_exec exposes run_in_background ONLY when an executor is injected", () => {
    const withExec = createPodExecTool(undefined, wiring);
    const withoutExec = createPodExecTool(undefined);
    expect((withExec.parameters as any).properties.run_in_background).toBeDefined();
    expect((withoutExec.parameters as any).properties.run_in_background).toBeUndefined();
  });

  it("both tools keep their core params regardless of background wiring", () => {
    const node = createNodeExecTool(undefined, "u");
    const pod = createPodExecTool(undefined);
    expect((node.parameters as any).properties.node).toBeDefined();
    expect((node.parameters as any).properties.command).toBeDefined();
    expect((pod.parameters as any).properties.pod).toBeDefined();
    expect((pod.parameters as any).properties.command).toBeDefined();
  });
});

describe("json_path is refused with run_in_background, not ignored", () => {
  // Accepting both would silently drop the projection: the agent asks for one field, gets the whole
  // stream, and has no way to tell its parameter did nothing.
  it("refuses the combination on node_exec and pod_exec, and does not launch", async () => {
    const executorCalls = vi.fn(() => ({ jobId: "j", outputFile: "/o" }));
    const w = { executor: executorCalls as never, sessionIdRef: { current: "s1" } };

    const node = await createNodeExecTool(undefined, "u", w).execute(
      "t1", { node: "node-1", command: "ip -j addr", run_in_background: true, json_path: ".[].ifname" },
      new AbortController().signal, {} as never,
    );
    expect((node.details as Record<string, unknown>).reason).toBe("background_json_path_unsupported");

    const pod = await createPodExecTool(undefined, w).execute(
      "t2", { pod: "p", command: "ip -j addr", run_in_background: true, json_path: ".[].ifname" },
      new AbortController().signal, {} as never,
    );
    expect((pod.details as Record<string, unknown>).reason).toBe("background_json_path_unsupported");

    // Nothing was launched — the refusal happens before the executor is reached.
    expect(executorCalls).not.toHaveBeenCalled();
  });
});
