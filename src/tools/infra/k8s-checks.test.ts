import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so the mock target is available when vi.mock's factory runs.
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock("node:child_process", async () => {
  const util = await import("node:util");
  const execFileMock = Object.assign(
    () => { throw new Error("raw execFile not supported in test; use promisified"); },
    {
      [util.promisify.custom]: async (cmd: string, args: string[], opts?: any) => {
        try {
          return await mockExecFile(cmd, args, opts);
        } catch (err: any) {
          const e = err instanceof Error ? err : new Error(String(err));
          if (err?.stdout !== undefined) (e as any).stdout = err.stdout;
          if (err?.stderr !== undefined) (e as any).stderr = err.stderr;
          throw e;
        }
      },
    },
  );
  return { execFile: execFileMock };
});

import { checkNodeReady, checkPodRunning, waitForPodDone } from "./k8s-checks.js";

beforeEach(() => {
  mockExecFile.mockReset();
});

describe("checkNodeReady", () => {
  it("returns null when status is True", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "True" });
    expect(await checkNodeReady("node-1")).toBeNull();
  });

  it("returns error message when status is not True", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "False" });
    const err = await checkNodeReady("node-1");
    expect(err).toContain("not Ready");
    expect(err).toContain("status: False");
  });

  it("returns 'unknown' when status empty", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "" });
    const err = await checkNodeReady("node-1");
    expect(err).toContain("unknown");
  });

  it("returns node-not-found message when kubectl says 'not found'", async () => {
    const err = Object.assign(new Error("kubectl fail"), { stderr: 'Error: nodes "bad" not found' });
    mockExecFile.mockRejectedValueOnce(err);
    const result = await checkNodeReady("bad");
    expect(result).toContain("does not exist");
  });

  it("returns generic failure message on other errors", async () => {
    const err = Object.assign(new Error("boom"), { stderr: "random error" });
    mockExecFile.mockRejectedValueOnce(err);
    const result = await checkNodeReady("bad");
    expect(result).toContain("Failed to check node");
  });

  it("passes kubeconfig flag when supplied", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "True" });
    await checkNodeReady("node-1", undefined, "/tmp/kc");
    const argsArray = mockExecFile.mock.calls[0][1] as string[];
    expect(argsArray[0]).toBe("--kubeconfig=/tmp/kc");
  });
});

describe("checkPodRunning", () => {
  it("returns null when phase is Running", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "Running" });
    expect(await checkPodRunning("p", "ns")).toBeNull();
  });

  it("returns non-running error with phase info", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "Pending" });
    const err = await checkPodRunning("p", "ns");
    expect(err).toContain("not Running");
    expect(err).toContain("Pending");
  });

  it("returns pod-not-found message on 'not found'", async () => {
    const err = Object.assign(new Error("x"), { stderr: 'pods "p" not found' });
    mockExecFile.mockRejectedValueOnce(err);
    const result = await checkPodRunning("p", "ns");
    expect(result).toContain("not found in namespace");
  });
});

describe("waitForPodDone", () => {
  it("returns when Running target phase is reached", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "Running" });
    const phase = await waitForPodDone("p", 5_000, undefined, undefined, undefined, "ns", "Running");
    expect(phase).toBe("Running");
  });

  it("returns terminal phase when target is 'terminal'", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "Succeeded" });
    const phase = await waitForPodDone("p", 5_000, undefined, undefined, undefined, "ns", "terminal");
    expect(phase).toBe("Succeeded");
  });

  it("considers Running-target with terminal phase as done (fail fast)", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "Failed" });
    const phase = await waitForPodDone("p", 5_000, undefined, undefined, undefined, "ns", "Running");
    expect(phase).toBe("Failed");
  });

  it("throws on timeout", async () => {
    // Resolve with non-terminal phase forever; we expect the function to give up.
    mockExecFile.mockResolvedValue({ stdout: "Pending" });
    await expect(waitForPodDone("p", 10, undefined, undefined, undefined, "ns", "terminal"))
      .rejects.toThrow(/Timed out/);
  }, 5000);

  it("respects abort signal", async () => {
    mockExecFile.mockResolvedValue({ stdout: "Pending" });
    const controller = new AbortController();
    const promise = waitForPodDone("p", 5_000, undefined, controller.signal, undefined, "ns", "terminal");
    controller.abort();
    await expect(promise).rejects.toThrow(/Aborted|Timed out/);
  });
});
