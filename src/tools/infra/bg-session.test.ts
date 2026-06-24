import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));

const sshExecMock = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
vi.mock("./ssh-client.js", () => ({ sshExec: (...a: unknown[]) => sshExecMock(...a) }));

const {
  backgroundPgidFile,
  wrapBackgroundSession,
  backgroundSessionKillScript,
  killRemoteSessionViaKubectl,
  killRemoteSessionViaSsh,
} = await import("./bg-session.js");

describe("bg-session", () => {
  it("builds a unique, sanitized pidfile path", () => {
    const a = backgroundPgidFile("functions.host_exec:0");
    const b = backgroundPgidFile("functions.host_exec:0");
    expect(a).toMatch(/^\/tmp\/siclaw-bg-functions_host_exec_0-[0-9a-f]{8}\.pgid$/);
    expect(a).not.toBe(b); // random suffix → no collision across jobs
  });

  it("wraps a command as a setsid session that records its session id and cleans up", () => {
    const wrapped = wrapBackgroundSession("timeout 600 sh -c 'do work'", "/tmp/x.pgid");
    expect(wrapped.startsWith("setsid sh -c ")).toBe(true);
    expect(wrapped).not.toContain("setsid -w");            // no util-linux >= 2.24 dependency
    expect(wrapped.endsWith("; exit $?")).toBe(true);      // forces a forked (non-leader) setsid child
    expect(wrapped).toContain("echo $$ > /tmp/x.pgid");   // record session id
    expect(wrapped).toContain("timeout 600 sh -c");        // inner command preserved
    expect(wrapped).toContain("rm -f /tmp/x.pgid");        // cleanup on normal exit
    // The inner single-quotes are escaped for the outer setsid `sh -c '…'` (one quoting level).
    expect(wrapped).toContain(`'\\''`);
  });

  it("kills by SESSION (pkill -s) with a process-group fallback", () => {
    const kill = backgroundSessionKillScript("/tmp/x.pgid");
    expect(kill).toContain("cat /tmp/x.pgid");
    expect(kill).toContain("pkill -TERM -s");
    expect(kill).toContain("pkill -KILL -s");
    expect(kill).toContain("kill -TERM -");  // group-kill fallback when pkill is absent
    expect(kill).toContain("rm -f /tmp/x.pgid");
  });
});

describe("killRemoteSessionViaKubectl", () => {
  beforeEach(() => { spawnMock.mockReset(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  function fakeChild() {
    return { on: vi.fn(), unref: vi.fn(), kill: vi.fn() };
  }

  it("spawns a detached `kubectl exec … nsenter … sh -c <killScript>` over a fresh connection", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    killRemoteSessionViaKubectl({
      kubeconfigArgs: ["--kubeconfig", "/k"],
      childEnv: { KUBECONFIG: "/k" },
      namespace: "siclaw-debug",
      podName: "node-debug-abcd",
      nsenterPrefix: ["nsenter", "-t", "1", "--"],
      pgidFile: "/tmp/x.pgid",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe("kubectl");
    expect(args).toEqual([
      "--kubeconfig", "/k", "-n", "siclaw-debug", "exec", "node-debug-abcd", "--",
      "nsenter", "-t", "1", "--", "sh", "-c", backgroundSessionKillScript("/tmp/x.pgid"),
    ]);
    expect((opts as { detached?: boolean }).detached).toBe(true);
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function)); // swallow spawn errors
    expect(child.unref).toHaveBeenCalled();
  });

  it("self-kills the reap exec if it lingers past the timeout, then is unreffed", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    killRemoteSessionViaKubectl({
      kubeconfigArgs: [], childEnv: {}, namespace: "ns", podName: "p",
      nsenterPrefix: [], pgidFile: "/tmp/x.pgid", timeoutMs: 5000,
    });
    // pod_exec passes an empty nsenter prefix → kill runs directly in the pod.
    expect(spawnMock.mock.calls[0][1]).toEqual(["-n", "ns", "exec", "p", "--", "sh", "-c", backgroundSessionKillScript("/tmp/x.pgid")]);
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("never throws when spawn itself throws (best-effort)", () => {
    spawnMock.mockImplementation(() => { throw new Error("ENOENT kubectl"); });
    expect(() => killRemoteSessionViaKubectl({
      kubeconfigArgs: [], childEnv: {}, namespace: "ns", podName: "p", nsenterPrefix: [], pgidFile: "/tmp/x.pgid",
    })).not.toThrow();
  });
});

describe("killRemoteSessionViaSsh", () => {
  beforeEach(() => sshExecMock.mockClear());

  it("reaps the remote session over a fresh ssh connection with a bounded timeout", () => {
    const target = { host: "h" } as never;
    killRemoteSessionViaSsh({ target, pgidFile: "/tmp/x.pgid" });
    expect(sshExecMock).toHaveBeenCalledTimes(1);
    expect(sshExecMock.mock.calls[0][0]).toBe(target);
    expect(sshExecMock.mock.calls[0][1]).toBe(backgroundSessionKillScript("/tmp/x.pgid"));
    expect(sshExecMock.mock.calls[0][2]).toEqual({ timeoutMs: 20_000 });
  });

  it("swallows a rejected sshExec (best-effort)", async () => {
    sshExecMock.mockRejectedValueOnce(new Error("connect failed"));
    expect(() => killRemoteSessionViaSsh({ target: {} as never, pgidFile: "/tmp/x.pgid" })).not.toThrow();
    await Promise.resolve(); // let the .catch settle without an unhandled rejection
  });
});
