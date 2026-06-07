import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the ssh-client boundary so we can drive host_exec's background branch without a real
// SSH dial and inspect the exact remote command + the job_stop (onAbort) kill path.
vi.mock("../infra/ssh-client.js", () => ({
  acquireSshTarget: vi.fn(async () => ({ host: "10.0.0.9", port: 22, username: "u", auth: { type: "password", password: "p" } })),
  sshExecStream: vi.fn(async () => ({ stdout: { setEncoding() {}, on() {} }, stderr: { setEncoding() {}, on() {} }, done: new Promise(() => {}), abort() {} })),
  sshExec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
}));
vi.mock("../infra/pod-netns-resolve.js", () => ({
  resolvePodNetnsViaSsh: vi.fn(async () => ({ netns: "cni-x" })),
}));

import { createHostExecTool } from "./host-exec.js";
import { sshExecStream, sshExec } from "../infra/ssh-client.js";
import { resolvePodNetnsViaSsh } from "../infra/pod-netns-resolve.js";
import type { BackgroundExecExecutor } from "../../core/tool-registry.js";

const fakeExecutor: BackgroundExecExecutor = vi.fn(() => ({ jobId: "j", outputFile: "/o" }));
const wiring = { executor: fakeExecutor, sessionIdRef: { current: "s1" } };

beforeEach(() => {
  vi.mocked(sshExecStream).mockClear();
  vi.mocked(sshExec).mockClear();
  vi.mocked(fakeExecutor).mockClear();
  vi.mocked(resolvePodNetnsViaSsh).mockClear();
});

describe("host_exec — run_in_background schema gating", () => {
  it("exposes run_in_background ONLY when an executor is injected", () => {
    const withExec = createHostExecTool(undefined, wiring);
    const withoutExec = createHostExecTool(undefined);
    expect((withExec.parameters as any).properties.run_in_background).toBeDefined();
    expect((withoutExec.parameters as any).properties.run_in_background).toBeUndefined();
  });

  it("keeps its core params regardless of background wiring", () => {
    const tool = createHostExecTool(undefined);
    expect((tool.parameters as any).properties.host).toBeDefined();
    expect((tool.parameters as any).properties.command).toBeDefined();
  });
});

describe("host_exec — background remote lifecycle", () => {
  it("wraps the remote command in setsid + timeout and records a PGID file", async () => {
    const tool = createHostExecTool(undefined, wiring);
    const res = await tool.execute("call-1", { host: "myhost", command: "uptime", run_in_background: true }, undefined, {} as any);
    expect((res.details as any).backgroundTaskId).toBe("j");

    const req = vi.mocked(fakeExecutor).mock.calls[0][0] as any;
    expect(req.jobType).toBe("host");
    expect(typeof req.streamFactory).toBe("function");
    expect(typeof req.onAbort).toBe("function");

    // Invoke the factory to capture the exact remote command handed to ssh.
    await req.streamFactory();
    const wrapped = vi.mocked(sshExecStream).mock.calls[0][1] as string;
    expect(wrapped).toContain("setsid");      // own process-group leader
    expect(wrapped).toMatch(/timeout \d+/);   // leak backstop
    expect(wrapped).toContain(".pgid");        // PGID recorded for job_stop
    expect(wrapped).toContain("uptime");       // the user command
  });

  it("job_stop (onAbort) kills the remote process group over a fresh ssh connection", async () => {
    const tool = createHostExecTool(undefined, wiring);
    await tool.execute("call-2", { host: "myhost", command: "uptime", run_in_background: true }, undefined, {} as any);
    const req = vi.mocked(fakeExecutor).mock.calls[0][0] as any;

    req.onAbort();
    expect(sshExec).toHaveBeenCalledTimes(1);
    const killScript = vi.mocked(sshExec).mock.calls[0][1] as string;
    // Kill by SESSION (pkill -s) so timeout's own child process group is reaped too,
    // with a process-group kill as the fallback when pkill is unavailable.
    expect(killScript).toContain("pkill -TERM -s");
    expect(killScript).toContain("pkill -KILL -s");
    expect(killScript).toContain("kill -TERM -"); // group-kill fallback
    expect(killScript).toContain(".pgid");
  });
});

describe("host_exec — one-step pod netns", () => {
  it("foreground: resolves the pod netns over SSH and runs the command inside it", async () => {
    const tool = createHostExecTool(undefined, wiring);
    await tool.execute("c1", { host: "node-1", pod: "rdma-a", namespace: "rdma-test", command: "show_gids" }, undefined, {} as any);
    expect(resolvePodNetnsViaSsh).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolvePodNetnsViaSsh).mock.calls[0][0]).toMatchObject({ pod: "rdma-a", namespace: "rdma-test" });
    // The actual remote command wraps the whole thing in `ip netns exec <netns> sh -c '<cmd>'`.
    const fgCmd = vi.mocked(sshExec).mock.calls.find((c) => String(c[1]).includes("show_gids"))![1] as string;
    expect(fgCmd).toBe("ip netns exec cni-x sh -c 'show_gids'");
  });

  it("background: the launched command runs under ip netns exec + timeout + setsid", async () => {
    const tool = createHostExecTool(undefined, wiring);
    const res = await tool.execute("c2", { host: "node-1", pod: "rdma-a", namespace: "rdma-test", command: "ib_write_bw -d mlx5_0", run_in_background: true }, undefined, {} as any);
    expect((res.details as any).backgroundTaskId).toBe("j");
    const req = vi.mocked(fakeExecutor).mock.calls[0][0] as any;
    await req.streamFactory();
    const wrapped = vi.mocked(sshExecStream).mock.calls[0][1] as string;
    expect(wrapped).toContain("setsid");
    expect(wrapped).toMatch(/timeout \d+ ip netns exec cni-x sh -c/);
  });

  it("rejects an invalid pod name", async () => {
    const tool = createHostExecTool(undefined, wiring);
    const res = await tool.execute("c3", { host: "node-1", pod: "BAD POD!", command: "show_gids" }, undefined, {} as any);
    expect((res.details as any).reason).toBe("invalid_pod_name");
    expect(resolvePodNetnsViaSsh).not.toHaveBeenCalled();
  });
});
