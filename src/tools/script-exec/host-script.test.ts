import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../infra/ssh-client.js", () => ({
  acquireSshTarget: vi.fn(),
  sshExec: vi.fn(),
}));

vi.mock("../infra/script-resolver.js", () => ({
  resolveScript: vi.fn(),
}));
vi.mock("../infra/pod-netns-resolve.js", () => ({
  resolvePodNetnsViaSsh: vi.fn(async () => ({ netns: "cni-x" })),
}));

import { createHostScriptTool } from "./host-script.js";
import { acquireSshTarget, sshExec } from "../infra/ssh-client.js";
import { resolveScript } from "../infra/script-resolver.js";
import { resolvePodNetnsViaSsh } from "../infra/pod-netns-resolve.js";
import type { CredentialBroker } from "../../agentbox/credential-broker.js";

const fakeBroker = {} as CredentialBroker;
const tool = createHostScriptTool({ credentialBroker: fakeBroker } as any);

beforeEach(() => {
  vi.mocked(acquireSshTarget).mockReset();
  vi.mocked(sshExec).mockReset();
  vi.mocked(resolveScript).mockReset();
  vi.mocked(resolvePodNetnsViaSsh).mockReset();
  vi.mocked(resolvePodNetnsViaSsh).mockResolvedValue({ netns: "cni-x" } as any);
});

const okTarget = {
  host: "10.0.0.1", port: 22, username: "root",
  auth: { type: "key" as const, privateKeyPath: "/tmp/h1.key" },
};

describe("host_script", () => {
  it("rejects invalid host name", async () => {
    const result = await tool.execute("id", { host: "bad name", script: "x.sh" }, undefined, {} as any);
    expect((result.details as any).error).toBe(true);
    expect((result.details as any).reason).toBe("invalid_host_name");
  });

  it("returns script-resolver error", async () => {
    vi.mocked(resolveScript).mockReturnValueOnce({ error: "Script not found in skill" } as any);
    const result = await tool.execute("id", { host: "h1", script: "missing.sh" }, undefined, {} as any);
    expect((result.details as any).error).toBe(true);
    expect(result.content[0].text).toContain("Script not found");
  });

  it("returns acquire failure with reason=host_acquire_failed", async () => {
    vi.mocked(resolveScript).mockReturnValueOnce({
      interpreter: "bash", content: "echo ok", path: "/skills/x.sh", scope: "global",
    } as any);
    vi.mocked(acquireSshTarget).mockRejectedValueOnce(new Error("Host \"h1\" not bound to this agent"));
    const result = await tool.execute("id", { host: "h1", script: "x.sh" }, undefined, {} as any);
    expect((result.details as any).reason).toBe("host_acquire_failed");
  });

  it("happy path: pipes script via stdin", async () => {
    vi.mocked(resolveScript).mockReturnValueOnce({
      interpreter: "bash", content: "echo from-script", path: "/skills/x.sh", scope: "global",
    } as any);
    vi.mocked(acquireSshTarget).mockResolvedValueOnce(okTarget);
    vi.mocked(sshExec).mockResolvedValueOnce({
      stdout: "from-script\n", stderr: "", exitCode: 0,
    });
    const result = await tool.execute("id", { host: "h1", script: "x.sh" }, undefined, {} as any);
    expect((result.details as any).exitCode).toBe(0);
    expect(result.content[0].text).toContain("from-script");

    // Verify sshExec was called with stdin
    const callArg = vi.mocked(sshExec).mock.calls[0][2];
    expect(callArg.stdin).toBe("echo from-script");
  });

  it("escapes args with shellEscape (no injection via args)", async () => {
    vi.mocked(resolveScript).mockReturnValueOnce({
      interpreter: "bash", content: "echo $1", path: "/skills/x.sh", scope: "global",
    } as any);
    vi.mocked(acquireSshTarget).mockResolvedValueOnce(okTarget);
    vi.mocked(sshExec).mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    await tool.execute("id", { host: "h1", script: "x.sh", args: "evil; rm -rf /" }, undefined, {} as any);

    const cmd = vi.mocked(sshExec).mock.calls[0][1];
    // shellEscape wraps in single quotes
    expect(cmd).toContain("'evil;'");
    expect(cmd).toContain("'rm");
  });

  it("non-zero exit produces error=true", async () => {
    vi.mocked(resolveScript).mockReturnValueOnce({
      interpreter: "bash", content: "exit 2", path: "/skills/x.sh", scope: "global",
    } as any);
    vi.mocked(acquireSshTarget).mockResolvedValueOnce(okTarget);
    vi.mocked(sshExec).mockResolvedValueOnce({ stdout: "", stderr: "fail", exitCode: 2 });
    const result = await tool.execute("id", { host: "h1", script: "x.sh" }, undefined, {} as any);
    expect((result.details as any).error).toBe(true);
    expect(result.content[0].text).toContain("Exit code: 2");
  });
});

describe("host_script — one-step pod netns", () => {
  it("resolves the pod netns over SSH and runs the script inside it", async () => {
    vi.mocked(acquireSshTarget).mockResolvedValue(okTarget as any);
    vi.mocked(resolveScript).mockReturnValue({ interpreter: "bash", content: "echo hi", path: "/x", scope: "global" } as any);
    vi.mocked(sshExec).mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 } as any);
    const res = await tool.execute("id", { host: "node-1", pod: "rdma-a", namespace: "rdma-test", script: "x.sh" }, undefined, {} as any);
    expect((res.details as any).error).toBeFalsy();
    expect(resolvePodNetnsViaSsh).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolvePodNetnsViaSsh).mock.calls[0][0]).toMatchObject({ pod: "rdma-a", namespace: "rdma-test" });
    // Foreground now runs as a killable, timeout-bounded setsid session; the netns'd interpreter
    // command lives inside that wrapper (so the abort reap can kill the whole remote group).
    const remoteCmd = vi.mocked(sshExec).mock.calls[0][1] as string;
    expect(remoteCmd).toContain("setsid sh -c");
    expect(remoteCmd).not.toContain("setsid -w");   // portable: no util-linux >= 2.24 dependency
    expect(remoteCmd).toContain("timeout ");
    expect(remoteCmd).toContain("ip netns exec cni-x ");
    expect(remoteCmd).toContain("bash -s");
  });

  it("foreground: reaps the remote session on abort instead of returning ssh_exec_failed", async () => {
    const controller = new AbortController();
    vi.mocked(acquireSshTarget).mockResolvedValue(okTarget as any);
    vi.mocked(resolveScript).mockReturnValue({ interpreter: "bash", content: "echo hi", path: "/x", scope: "global" } as any);
    // The real SSH path rejects with Error("Aborted") on abort; emulate that after the signal fires.
    vi.mocked(sshExec).mockImplementation(async (_t: any, cmd: any) => {
      if (typeof cmd === "string" && cmd.includes("setsid")) { controller.abort(); throw new Error("Aborted"); }
      return { stdout: "", stderr: "", exitCode: 0 } as any;
    });
    const res = await tool.execute("tc1", { host: "node-1", script: "x.sh" }, controller.signal, {} as any);
    expect(res.content[0].text).toBe("Aborted.");
    expect((res.details as any).reason).not.toBe("ssh_exec_failed");
    // A SECOND sshExec carried the reap script over a fresh connection.
    const kill = vi.mocked(sshExec).mock.calls.find((c) => String(c[1]).includes("pkill -TERM -s"));
    expect(kill).toBeTruthy();
  });
});
