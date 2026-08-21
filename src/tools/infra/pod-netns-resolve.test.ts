import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./exec-utils.js", async () => {
  const actual = await vi.importActual<any>("./exec-utils.js");
  return { ...actual, resolveContainerNetns: vi.fn() };
});
vi.mock("./debug-pod.js", () => ({ runInDebugPod: vi.fn() }));
vi.mock("./ssh-client.js", () => ({ sshExec: vi.fn() }));

import {
  validateNetnsName,
  buildCrictlNetnsScript,
  extractNetnsFromInspect,
  resolvePodNetnsViaKubectl,
  resolvePodNetnsViaSsh,
} from "./pod-netns-resolve.js";
import { resolveContainerNetns, validateNamespace } from "./exec-utils.js";
import { runInDebugPod } from "./debug-pod.js";
import { sshExec } from "./ssh-client.js";

beforeEach(() => {
  vi.mocked(resolveContainerNetns).mockReset();
  vi.mocked(runInDebugPod).mockReset();
  vi.mocked(sshExec).mockReset();
});

describe("validateNetnsName", () => {
  it("accepts safe names, rejects unsafe ones", () => {
    expect(validateNetnsName("cni-abc123")).toBeNull();
    expect(validateNetnsName("a_b-C9")).toBeNull();
    expect(validateNetnsName("foo; rm -rf /")).toMatch(/invalid netns/);
    expect(validateNetnsName("$(id)")).toMatch(/invalid netns/);
    expect(validateNetnsName("")).toMatch(/invalid netns/);
  });
});

describe("validateNamespace (shell-injection guard)", () => {
  it("accepts RFC-1123 labels, rejects shell metacharacters and bad shapes", () => {
    expect(validateNamespace("default")).toBeNull();
    expect(validateNamespace("kube-system")).toBeNull();
    expect(validateNamespace('default" ; id ; echo "')).toMatch(/Invalid namespace/); // the injection payload
    expect(validateNamespace("ns;rm -rf /")).toMatch(/Invalid namespace/);
    expect(validateNamespace("$(id)")).toMatch(/Invalid namespace/);
    expect(validateNamespace("Foo")).toMatch(/Invalid namespace/);       // uppercase
    expect(validateNamespace("ns.with.dots")).toMatch(/Invalid namespace/); // dots not allowed in a namespace
    expect(validateNamespace("a".repeat(64))).toMatch(/Invalid namespace/); // too long
  });
});

function inspectpJson(netnsPath: string | null, opts?: { infoAsString?: boolean }): string {
  const info = {
    runtimeSpec: {
      linux: {
        namespaces: [
          { type: "pid" },
          ...(netnsPath === null ? [{ type: "network" }] : [{ type: "network", path: netnsPath }]),
        ],
      },
    },
  };
  return JSON.stringify({ status: { id: "sandbox-1" }, info: opts?.infoAsString ? JSON.stringify(info) : info });
}

describe("buildCrictlNetnsScript", () => {
  it("looks up the sandbox by pod+namespace and returns RAW crictl JSON", () => {
    const s = buildCrictlNetnsScript("rdma-a", "rdma-test");
    expect(s).toContain('crictl pods --name "^rdma-a$" --namespace "rdma-test"');
    expect(s).toContain("crictl inspectp");
    // -o json is explicit, not inherited: crictl's default output is configurable (CRICTL_OUTPUT,
    // or `output:` in /etc/crictl.yaml), and a node set to yaml would fail `pod=` before the user's
    // command ran — the same host-dependency class as the jq pipe this replaced.
    expect(s).toContain("crictl inspectp -o json");
  });

  it("does no JSON processing on the node", () => {
    // These commands run in the NODE's mount namespace, where the available binaries are
    // whatever the customer installed — a `jq` here made this tool's own `pod=` capability
    // fail on every node without it, before the user's command ran at all.
    const s = buildCrictlNetnsScript("rdma-a", "rdma-test");
    expect(s).not.toContain("jq");
    expect(s).not.toContain("basename");
  });
});

describe("extractNetnsFromInspect", () => {
  it("takes the network namespace basename", () => {
    expect(extractNetnsFromInspect(inspectpJson("/var/run/netns/cni-abc"))).toEqual({ netns: "cni-abc" });
  });

  it("parses an `info` that arrives as a JSON string", () => {
    // Some crictl versions emit info as a string rather than a map.
    expect(extractNetnsFromInspect(inspectpJson("/var/run/netns/cni-str", { infoAsString: true })))
      .toEqual({ netns: "cni-str" });
  });

  it("names the host-network case instead of returning an empty netns", () => {
    // `ip netns exec ""` downstream would be the alternative.
    const r = extractNetnsFromInspect(inspectpJson(null));
    expect("error" in r && r.error).toMatch(/host network/);
  });

  it("reports unreadable output rather than guessing", () => {
    expect("error" in extractNetnsFromInspect("not json")).toBe(true);
    expect("error" in extractNetnsFromInspect(JSON.stringify({ info: { runtimeSpec: {} } }))).toBe(true);
    expect("error" in extractNetnsFromInspect(JSON.stringify({ info: "{oops" }))).toBe(true);
  });

  it("still validates the resolved name before it can reach `ip netns exec`", () => {
    const r = extractNetnsFromInspect(inspectpJson("/var/run/netns/bad;name"));
    expect("error" in r && r.error).toMatch(/unexpected netns name/);
  });
});

describe("resolvePodNetnsViaKubectl", () => {
  const base = { pod: "rdma-a", namespace: "rdma-test", env: {} as any, userId: "u", clusterKey: "default", image: "img" };

  it("returns {node, netns} on success (crictl via debug pod)", async () => {
    vi.mocked(resolveContainerNetns).mockResolvedValue({ nodeName: "worker-1", containerID: "c" } as any);
    vi.mocked(runInDebugPod).mockResolvedValue({ stdout: inspectpJson("/var/run/netns/cni-abc"), stderr: "", exitCode: 0 } as any);
    const r = await resolvePodNetnsViaKubectl(base);
    expect(r).toEqual({ node: "worker-1", netns: "cni-abc" });
    // It ran a nsenter-wrapped crictl script in the debug pod.
    const cmd = vi.mocked(runInDebugPod).mock.calls[0][0].command as string[];
    expect(cmd.slice(0, 3)).toEqual(["nsenter", "-t", "1"]);
    expect(cmd.join(" ")).toContain("crictl pods");
  });

  it("propagates a node-resolution error", async () => {
    vi.mocked(resolveContainerNetns).mockResolvedValue({ error: "Pod not found" } as any);
    expect(await resolvePodNetnsViaKubectl(base)).toEqual({ error: "Pod not found" });
    expect(runInDebugPod).not.toHaveBeenCalled();
  });

  it("errors when crictl exits non-zero", async () => {
    vi.mocked(resolveContainerNetns).mockResolvedValue({ nodeName: "w1", containerID: "c" } as any);
    vi.mocked(runInDebugPod).mockResolvedValue({ stdout: "", stderr: "no sandbox", exitCode: 1 } as any);
    const r = await resolvePodNetnsViaKubectl(base);
    expect("error" in r && r.error).toMatch(/no sandbox/);
  });

  it("rejects a shell-injecting namespace BEFORE running anything (no debug pod, no node resolve)", async () => {
    const r = await resolvePodNetnsViaKubectl({ ...base, namespace: 'default" ; touch /tmp/pwned ; echo "' });
    expect("error" in r && r.error).toMatch(/Invalid namespace/);
    expect(resolveContainerNetns).not.toHaveBeenCalled();
    expect(runInDebugPod).not.toHaveBeenCalled();
  });
});

describe("resolvePodNetnsViaSsh", () => {
  const base = { target: {} as any, pod: "rdma-a", namespace: "rdma-test" };

  it("returns {netns} from a direct crictl run over SSH (no nsenter)", async () => {
    vi.mocked(sshExec).mockResolvedValue({ stdout: inspectpJson("/var/run/netns/cni-xyz"), stderr: "", exitCode: 0 } as any);
    expect(await resolvePodNetnsViaSsh(base)).toEqual({ netns: "cni-xyz" });
    const script = vi.mocked(sshExec).mock.calls[0][1] as string;
    expect(script).toContain("crictl pods"); // raw crictl, run directly on the node
    expect(script).not.toContain("nsenter");
  });

  it("hints at root requirement on a permission error", async () => {
    vi.mocked(sshExec).mockResolvedValue({ stdout: "", stderr: "permission denied", exitCode: 1 } as any);
    const r = await resolvePodNetnsViaSsh(base);
    expect("error" in r && r.error).toMatch(/must be a privileged account/);
  });

  it("rejects a shell-injecting namespace BEFORE the SSH exec (no command reaches the node)", async () => {
    const r = await resolvePodNetnsViaSsh({ ...base, namespace: 'default" ; id ; echo "' });
    expect("error" in r && r.error).toMatch(/Invalid namespace/);
    expect(sshExec).not.toHaveBeenCalled();
  });
});
