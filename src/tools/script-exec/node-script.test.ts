import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../infra/script-resolver.js", () => ({ resolveScript: vi.fn() }));
vi.mock("../infra/k8s-checks.js", () => ({ checkNodeReady: vi.fn() }));
vi.mock("../infra/debug-pod.js", () => ({ runInDebugPod: vi.fn() }));
vi.mock("../infra/kubeconfig-resolver.js", () => ({
  resolveRequiredKubeconfig: vi.fn(() => ({ path: "/tmp/kc" })),
  resolveDebugImage: vi.fn(() => "debug:latest"),
}));
vi.mock("../infra/ensure-kubeconfigs.js", () => ({
  ensureClusterForTool: vi.fn(),
}));

import { createNodeScriptTool } from "./node-script.js";
import { resolveScript } from "../infra/script-resolver.js";
import { checkNodeReady } from "../infra/k8s-checks.js";
import { runInDebugPod } from "../infra/debug-pod.js";
import { ensureClusterForTool } from "../infra/ensure-kubeconfigs.js";

const tool = createNodeScriptTool(undefined, "user-1");

beforeEach(() => {
  vi.mocked(resolveScript).mockReset();
  vi.mocked(checkNodeReady).mockReset();
  vi.mocked(runInDebugPod).mockReset();
  vi.mocked(ensureClusterForTool).mockReset();
});

describe("node_script tool", () => {
  it("has correct metadata", () => {
    expect(tool.name).toBe("node_script");
    expect(tool.label).toBe("Node Script");
  });

  it("returns kubeconfig_ensure_failed on broker error", async () => {
    vi.mocked(ensureClusterForTool).mockRejectedValueOnce(new Error("not bound"));
    const res = await tool.execute("id", { node: "n1", script: "x.sh" }, undefined, {} as any);
    expect((res.details as any).reason).toBe("kubeconfig_ensure_failed");
  });

  it("rejects invalid node names", async () => {
    const res = await tool.execute("id", { node: "bad space", script: "x.sh" }, undefined, {} as any);
    expect((res.details as any).error).toBe(true);
    expect(res.content[0].text).toContain("Error");
  });

  it("rejects invalid netns names (injection attempt)", async () => {
    vi.mocked(checkNodeReady).mockResolvedValue(null);
    vi.mocked(resolveScript).mockReturnValue({
      interpreter: "bash", content: "echo ok", path: "/x.sh", scope: "global",
    } as any);
    const res = await tool.execute(
      "id",
      { node: "n1", script: "x.sh", netns: "bad; rm -rf /" },
      undefined, {} as any,
    );
    expect((res.details as any).error).toBe(true);
    expect(res.content[0].text).toContain("invalid netns");
  });

  it("returns node-not-ready error", async () => {
    vi.mocked(checkNodeReady).mockResolvedValue("Node n1 is not Ready (status: False)");
    const res = await tool.execute("id", { node: "n1", script: "x.sh" }, undefined, {} as any);
    expect((res.details as any).error).toBe(true);
    expect(res.content[0].text).toContain("not Ready");
  });

  it("returns resolver error when script not found", async () => {
    vi.mocked(checkNodeReady).mockResolvedValue(null);
    vi.mocked(resolveScript).mockReturnValue({ error: "Script not found" } as any);
    const res = await tool.execute("id", { node: "n1", script: "missing.sh" }, undefined, {} as any);
    expect((res.details as any).error).toBe(true);
    expect(res.content[0].text).toContain("Script not found");
  });

  it("pipes resolved script via stdin to debug pod", async () => {
    vi.mocked(checkNodeReady).mockResolvedValue(null);
    vi.mocked(resolveScript).mockReturnValue({
      interpreter: "bash", content: "echo hello", path: "/x.sh", scope: "global",
    } as any);
    vi.mocked(runInDebugPod).mockResolvedValue({
      stdout: "hello\n", stderr: "", exitCode: 0,
    });

    const res = await tool.execute(
      "id", { node: "n1", skill: "sk", script: "x.sh" }, undefined, {} as any,
    );
    expect((res.details as any).exitCode).toBe(0);
    const call = vi.mocked(runInDebugPod).mock.calls[0][0];
    expect(call.stdinData).toBe("echo hello");
    expect(call.nodeName).toBe("n1");
    expect(call.userId).toBe("user-1");
    // command array uses nsenter + -- sh -c innerCmd
    expect(call.command[0]).toBe("nsenter");
  });

  it("wraps command with ip netns exec when netns given", async () => {
    vi.mocked(checkNodeReady).mockResolvedValue(null);
    vi.mocked(resolveScript).mockReturnValue({
      interpreter: "bash", content: "echo x", path: "/x.sh", scope: "global",
    } as any);
    vi.mocked(runInDebugPod).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await tool.execute(
      "id", { node: "n1", script: "x.sh", netns: "abc-123" }, undefined, {} as any,
    );
    const call = vi.mocked(runInDebugPod).mock.calls[0][0];
    // innerCmd passed as last "sh -c ..." arg
    const innerCmd = call.command[call.command.length - 1];
    expect(innerCmd).toContain("ip netns exec abc-123");
  });

  it("shell-escapes user args to prevent injection", async () => {
    vi.mocked(checkNodeReady).mockResolvedValue(null);
    vi.mocked(resolveScript).mockReturnValue({
      interpreter: "bash", content: "echo $1", path: "/x.sh", scope: "global",
    } as any);
    vi.mocked(runInDebugPod).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await tool.execute(
      "id",
      { node: "n1", script: "x.sh", args: "evil; rm -rf /" },
      undefined, {} as any,
    );
    const call = vi.mocked(runInDebugPod).mock.calls[0][0];
    const innerCmd = call.command[call.command.length - 1];
    // shellEscape uses single quotes; unsafe chars should be inside quotes
    expect(innerCmd).toMatch(/'evil;'/);
  });

  it("returns error when exit code is non-zero", async () => {
    vi.mocked(checkNodeReady).mockResolvedValue(null);
    vi.mocked(resolveScript).mockReturnValue({
      interpreter: "bash", content: "exit 2", path: "/x.sh", scope: "global",
    } as any);
    vi.mocked(runInDebugPod).mockResolvedValue({
      stdout: "", stderr: "err", exitCode: 2,
    });

    const res = await tool.execute("id", { node: "n1", script: "x.sh" }, undefined, {} as any);
    expect((res.details as any).error).toBe(true);
    expect((res.details as any).exitCode).toBe(2);
  });

  it("respects timeout_seconds (max 300s)", async () => {
    vi.mocked(checkNodeReady).mockResolvedValue(null);
    vi.mocked(resolveScript).mockReturnValue({
      interpreter: "bash", content: "x", path: "/x.sh", scope: "global",
    } as any);
    vi.mocked(runInDebugPod).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await tool.execute(
      "id", { node: "n1", script: "x.sh", timeout_seconds: 9999 }, undefined, {} as any,
    );
    const opts = vi.mocked(runInDebugPod).mock.calls[0][2];
    expect(opts.timeoutMs).toBe(300_000);
  });
});
