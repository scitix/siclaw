import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../infra/script-resolver.js", () => ({ resolveScript: vi.fn() }));
vi.mock("../infra/k8s-checks.js", () => ({ checkPodRunning: vi.fn() }));
vi.mock("../infra/exec-utils.js", async () => {
  const actual = await vi.importActual<any>("../infra/exec-utils.js");
  return {
    ...actual,
    spawnAsync: vi.fn(),
  };
});
vi.mock("../infra/kubeconfig-resolver.js", () => ({
  resolveRequiredKubeconfig: vi.fn(() => ({ path: "/tmp/kc" })),
}));
vi.mock("../infra/ensure-kubeconfigs.js", () => ({
  ensureClusterForTool: vi.fn(),
}));

import { createPodScriptTool } from "./pod-script.js";
import { resolveScript } from "../infra/script-resolver.js";
import { checkPodRunning } from "../infra/k8s-checks.js";
import { spawnAsync } from "../infra/exec-utils.js";
import { ensureClusterForTool } from "../infra/ensure-kubeconfigs.js";

const tool = createPodScriptTool();

beforeEach(() => {
  vi.mocked(resolveScript).mockReset();
  vi.mocked(checkPodRunning).mockReset();
  vi.mocked(spawnAsync).mockReset();
  vi.mocked(ensureClusterForTool).mockReset();
});

describe("pod_script tool", () => {
  it("has correct metadata", () => {
    expect(tool.name).toBe("pod_script");
    expect(tool.label).toBe("Pod Script");
  });

  it("returns kubeconfig_ensure_failed on ensure error", async () => {
    vi.mocked(ensureClusterForTool).mockRejectedValueOnce(new Error("no access"));
    const res = await tool.execute("id", { pod: "p", script: "x.sh" }, undefined, {} as any);
    expect((res.details as any).reason).toBe("kubeconfig_ensure_failed");
  });

  it("rejects invalid pod name", async () => {
    const res = await tool.execute(
      "id", { pod: "BAD_POD!", script: "x.sh" }, undefined, {} as any,
    );
    expect((res.details as any).error).toBe(true);
    expect(res.content[0].text).toContain("invalid pod name");
  });

  it("returns resolver error when script missing", async () => {
    vi.mocked(resolveScript).mockReturnValue({ error: "not found" } as any);
    const res = await tool.execute(
      "id", { pod: "p1", script: "missing.sh" }, undefined, {} as any,
    );
    expect((res.details as any).error).toBe(true);
    expect(res.content[0].text).toContain("not found");
  });

  it("returns pod-not-running error", async () => {
    vi.mocked(resolveScript).mockReturnValue({
      interpreter: "bash", content: "x", path: "/x", scope: "global",
    } as any);
    vi.mocked(checkPodRunning).mockResolvedValue(`Pod "p1" is not Running (phase: Pending)`);
    const res = await tool.execute(
      "id", { pod: "p1", script: "x.sh" }, undefined, {} as any,
    );
    expect((res.details as any).error).toBe(true);
    expect(res.content[0].text).toContain("not Running");
  });

  it("invokes kubectl exec with pod + pipes script stdin", async () => {
    vi.mocked(resolveScript).mockReturnValue({
      interpreter: "bash", content: "echo hello", path: "/x", scope: "global",
    } as any);
    vi.mocked(checkPodRunning).mockResolvedValue(null);
    vi.mocked(spawnAsync).mockResolvedValue({ stdout: "hello", stderr: "", exitCode: 0 });

    const res = await tool.execute(
      "id",
      { pod: "my-pod", namespace: "ns1", skill: "sk", script: "x.sh" },
      undefined, {} as any,
    );
    expect((res.details as any).exitCode).toBe(0);
    const [cmd, args, , , , stdin] = vi.mocked(spawnAsync).mock.calls[0] as any;
    expect(cmd).toBe("kubectl");
    expect(args).toContain("my-pod");
    expect(args).toContain("-n");
    expect(args).toContain("ns1");
    expect(args).toContain("-i");
    expect(stdin).toBe("echo hello");
  });

  it("adds -c container flag when specified", async () => {
    vi.mocked(resolveScript).mockReturnValue({
      interpreter: "bash", content: "x", path: "/x", scope: "global",
    } as any);
    vi.mocked(checkPodRunning).mockResolvedValue(null);
    vi.mocked(spawnAsync).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await tool.execute(
      "id",
      { pod: "p", script: "x.sh", container: "sidecar" },
      undefined, {} as any,
    );
    const args = vi.mocked(spawnAsync).mock.calls[0][1] as string[];
    const cIdx = args.indexOf("-c");
    expect(cIdx).toBeGreaterThan(-1);
    expect(args[cIdx + 1]).toBe("sidecar");
  });

  it("defaults to 'default' namespace when not provided", async () => {
    vi.mocked(resolveScript).mockReturnValue({
      interpreter: "bash", content: "x", path: "/x", scope: "global",
    } as any);
    vi.mocked(checkPodRunning).mockResolvedValue(null);
    vi.mocked(spawnAsync).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await tool.execute("id", { pod: "p", script: "x.sh" }, undefined, {} as any);
    expect(vi.mocked(checkPodRunning).mock.calls[0][1]).toBe("default");
  });

  it("shell-escapes args (prevents injection)", async () => {
    vi.mocked(resolveScript).mockReturnValue({
      interpreter: "bash", content: "echo $1", path: "/x", scope: "global",
    } as any);
    vi.mocked(checkPodRunning).mockResolvedValue(null);
    vi.mocked(spawnAsync).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await tool.execute(
      "id",
      { pod: "p", script: "x.sh", args: "evil; rm -rf /" },
      undefined, {} as any,
    );
    const args = vi.mocked(spawnAsync).mock.calls[0][1] as string[];
    // sh -c "<execCmd>" — the exec command contains shell-escaped args
    const execCmd = args[args.length - 1];
    expect(execCmd).toMatch(/'evil;'/);
  });

  it("returns error payload when kubectl throws", async () => {
    vi.mocked(resolveScript).mockReturnValue({
      interpreter: "bash", content: "x", path: "/x", scope: "global",
    } as any);
    vi.mocked(checkPodRunning).mockResolvedValue(null);
    const err = Object.assign(new Error("k8s err"), { code: 1, stdout: "", stderr: "no such pod" });
    vi.mocked(spawnAsync).mockRejectedValue(err);
    const res = await tool.execute(
      "id", { pod: "p", script: "x.sh" }, undefined, {} as any,
    );
    expect((res.details as any).error).toBe(true);
    expect((res.details as any).exitCode).toBe(1);
  });
});
