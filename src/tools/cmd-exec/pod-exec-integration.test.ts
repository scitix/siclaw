import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * pod_exec's execute() path had no integration test at all — `pod-exec.test.ts` covers only
 * validatePodName. Reverting the whole of pod-exec.ts failed exactly one test in the suite, while this
 * PR added four behaviours to it: json_path projection, exit classification, the tail-truncation note,
 * and cluster-failure classification. Each is unit-tested in isolation; none was asserted through the
 * tool, which is where the wiring can be wrong.
 *
 * Mock shape follows k8s-checks.test.ts: `promisify(execFile)` only resolves to `{stdout, stderr}`
 * because Node's execFile carries a promisify.custom implementation, and a rejection has to be a real
 * Error carrying stdout/stderr/code — that is what execFile itself produces, and pod-exec reads those
 * fields off it.
 */
const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));

vi.mock("node:child_process", async () => {
  const util = await import("node:util");
  const execFileMock = Object.assign(
    () => { throw new Error("raw execFile is not used by pod-exec; use the promisified form"); },
    {
      [util.promisify.custom]: async (cmd: string, args: string[], opts?: unknown) => {
        try {
          return await mockExec(cmd, args, opts);
        } catch (err: any) {
          const e = err instanceof Error ? err : new Error(String(err?.message ?? "exec failed"));
          for (const k of ["stdout", "stderr", "code", "signal"]) {
            if (err?.[k] !== undefined) (e as any)[k] = err[k];
          }
          throw e;
        }
      },
    },
  );
  return { execFile: execFileMock, spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn(), kill: vi.fn() })) };
});
vi.mock("../infra/k8s-checks.js", () => ({ checkPodRunning: vi.fn(async () => null) }));

const { createPodExecTool } = await import("./pod-exec.js");
const tool = createPodExecTool();
const run = (params: Record<string, unknown>, signal?: AbortSignal) =>
  tool.execute("t", { pod: "p1", ...params } as never, signal ?? new AbortController().signal, {} as never);

beforeEach(() => mockExec.mockReset());

describe("pod_exec: json_path", () => {
  const DOC = JSON.stringify([{ ifname: "eth0", mtu: 1500 }, { ifname: "lo", mtu: 65536 }]);

  it("projects the requested field and drops the rest", async () => {
    mockExec.mockResolvedValueOnce({ stdout: DOC, stderr: "" });
    const text = (await run({ command: "ip -j addr", json_path: ".[].ifname" })).content[0].text as string;
    expect(text).toContain("eth0");
    expect(text).not.toContain("mtu");
    expect(text).not.toContain("65536");
  });

  it("projects on the failure path too, where the document is still JSON", async () => {
    // A non-zero exit with a complete JSON body on stdout is ordinary. The failure branch has its own
    // postExecSecurity call, so it needs its own wiring and does not get it for free.
    mockExec.mockRejectedValueOnce(Object.assign(new Error("x"), { code: 1, stdout: DOC, stderr: "warning" }));
    const text = (await run({ command: "ip -j addr", json_path: ".[].ifname" })).content[0].text as string;
    expect(text).toContain("eth0");
    expect(text).not.toContain("mtu");
  });
});

describe("pod_exec: exit classification reaches the tool result", () => {
  it("does not call a grep that matched nothing an error", async () => {
    mockExec.mockRejectedValueOnce(Object.assign(new Error("x"), { code: 1, stdout: "", stderr: "" }));
    const res = await run({ command: "grep nosuchthing /etc/hosts" });
    expect((res.details as Record<string, unknown>).exit_class).toBe("no_match");
    expect((res.details as Record<string, unknown>).error).toBeFalsy();
  });

  it("separates a missing binary from the container's own answer", async () => {
    mockExec.mockRejectedValueOnce(Object.assign(new Error("x"), {
      code: 126, stdout: "",
      stderr: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "jq": executable file not found in $PATH',
    }));
    const res = await run({ command: "jq ." });
    expect((res.details as Record<string, unknown>).exit_class).toBe("dependency_missing");
  });

  it("reports a real command failure as one", async () => {
    mockExec.mockRejectedValueOnce(Object.assign(new Error("x"), {
      code: 2, stdout: "", stderr: "ls: /nope: No such file or directory",
    }));
    const res = await run({ command: "ls /nope" });
    expect((res.details as Record<string, unknown>).error).toBe(true);
    expect(res.content[0].text as string).toContain("[exit code: 2]");
  });

  it("does not report the container's answer when the exec channel itself failed", async () => {
    // `err.code` is a STRING when the spawn failed rather than the command — reporting that as the
    // container's exit status is the misdiagnosis exit_class exists to prevent.
    mockExec.mockRejectedValueOnce(Object.assign(new Error("spawn kubectl ENOENT"), { code: "ENOENT", stdout: "", stderr: "" }));
    const res = await run({ command: "true" });
    expect((res.details as Record<string, unknown>).exit_class).toBe("channel_error");
  });
});

describe("pod_exec: kubectl is not runnable here", () => {
  it("refuses kubectl, which is why the --tail note was removed from this tool", async () => {
    // The tail-window note fires only for `kubectl logs --tail=N`. This tool passes no `extraAllowed`,
    // so kubectl is refused before it runs and the note was unreachable — it was wired here anyway and
    // has been removed. tail-truncation.test.ts holds the invariant; this asserts the premise.
    const res = await run({ command: "kubectl logs --tail=5 somepod" });
    expect((res.details as Record<string, unknown>).blocked).toBe(true);
    expect(res.content[0].text as string).toContain("kubectl");
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("pod_exec: a user Stop is not a command failure", () => {
  it("answers Aborted rather than an exit code", async () => {
    const controller = new AbortController();
    mockExec.mockImplementationOnce(async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
    });
    const res = await run({ command: "sleep 60" }, controller.signal);
    expect(res.content[0].text).toBe("Aborted.");
  });
});
