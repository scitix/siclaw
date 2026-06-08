import { describe, it, expect, vi } from "vitest";

// Capture the options handed to the local kubectl so we can assert the AbortSignal is threaded.
// promisify(execFile) calls our mock callback-style: (file, args, options, cb).
let capturedOptions: Record<string, unknown> | undefined;
let rejectWith: { code?: string; message?: string } | undefined; // set to make the mock reject (abort path)
vi.mock("node:child_process", () => ({
  execFile: (_file: string, _args: string[], options: Record<string, unknown>, cb: (e: unknown, r: unknown) => void) => {
    capturedOptions = options;
    if (rejectWith) cb(rejectWith, null);
    else cb(null, { stdout: "ok\n", stderr: "" });
  },
}));
// Pretend the target pod is Running so execute() reaches the kubectl exec.
vi.mock("../infra/k8s-checks.js", () => ({ checkPodRunning: vi.fn(async () => null) }));

const { createPodExecTool } = await import("./pod-exec.js");

describe("pod_exec foreground threads the AbortSignal to the local kubectl", () => {
  it("passes `signal` in the execFile options so Stop kills the local kubectl promptly", async () => {
    const tool = createPodExecTool();
    const controller = new AbortController();
    const result = await tool.execute(
      "tc1", { pod: "my-pod", command: "ip addr show", timeout_seconds: 5 }, controller.signal, {} as never,
    );
    expect((result.details as Record<string, unknown>).blocked).toBeUndefined();
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.signal).toBe(controller.signal);
  });

  it("returns a clean 'Aborted.' (not an ABORT_ERR command error) when Stopped", async () => {
    const tool = createPodExecTool();
    const controller = new AbortController();
    controller.abort();
    rejectWith = { code: "ABORT_ERR", message: "The operation was aborted" }; // how Node rejects an aborted execFile
    const result = await tool.execute(
      "tc2", { pod: "my-pod", command: "ip addr show", timeout_seconds: 5 }, controller.signal, {} as never,
    );
    rejectWith = undefined;
    expect(result.content[0].text).toBe("Aborted.");
    expect(result.content[0].text).not.toContain("ABORT_ERR");
  });
});
