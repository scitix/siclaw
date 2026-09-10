import { expect, it } from "vitest";
import { validateSandboxExec, validateSandboxBuiltin } from "./sandbox-tool-policy.js";

const scope = { language: "python" as const, code: "pass", hosts: ["host-a"], clusters: [{ name: "prod", nodes: true, namespaces: ["app"] }] };
const targets = {
  host_exec: { host: "host-a" },
  node_exec: { cluster: "prod", node: "node-a" },
  pod_exec: { cluster: "prod", namespace: "app", pod: "pod-a", container: "main" },
};
for (const tool of ["host_exec", "node_exec", "pod_exec"] as const) {
  it.each(["uname -r", "free -m", "cat /etc/os-release", "cat /proc/meminfo", "sysctl net.ipv4.ip_forward", "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader", "ip -j addr show", "ss -tuln", "lscpu -J", "rdma link show"])(`${tool} accepts bounded diagnostic %s`, command => {
    expect(validateSandboxExec(tool, { ...targets[tool], command }, scope)).toMatchObject({ timeout_seconds: 10 });
  });
  it.each([
    "rm /tmp/x", "uname; rm /tmp/x", "uname && uptime", "uname | cat", "uname\nuptime", "$(uname)", "`uname`", "uname > /tmp/x",
    "python -c 'import os'", "sh -c uname", "bash -c uname", "curl https://example.test", "ssh host-a uname", "sudo uname", "env", "cat /etc/shadow", "cat /proc/1/environ",
    "sysctl -w net.ipv4.ip_forward=1", "sysctl --system", "sysctl -p", "sysctl net.ipv4.ip_forward=1",
    "ip link set eth0 down", "ip -batch commands", "rdma -b commands", "rdma link delete eth0",
    "ss -K", "ss --kill", "ss -D output", "ss --diag=output", "ss -F input", "ss --filter=input",
    "nvidia-smi -pm 1", "nvidia-smi --gpu-reset", "nvidia-smi -f output", "nvidia-smi nvlink -r", "ethtool -s eth0 speed 1000", "ethtool -E eth0",
    "findmnt --tab-file input", "findmnt --poll", "lscpu --sysroot root", "modinfo /private/key", "iostat -f input", "cat --help",
  ])(`${tool} rejects writes, credential reads, alternate inputs and interpreters: %s`, command => {
    expect(() => validateSandboxExec(tool, { ...targets[tool], command }, scope)).toThrow();
  });
  it.each(["image", "env", "cwd", "netns", "run_in_background", "namespace_override", "approval", "outputMode"])(`${tool} denies caller-supplied %s`, key => {
    expect(() => validateSandboxExec(tool, { ...targets[tool], command: "uname", [key]: "x" }, scope)).toThrow();
  });
}
it("requires exact immutable resource scope and disallows callback tool substitution", () => {
  for (const [tool, args] of Object.entries(targets)) {
    expect(() => validateSandboxBuiltin({ id: "1", tool, arguments: { ...args, command: "uname" } }, { ...scope, hosts: [], clusters: [] })).toThrow();
  }
  expect(() => validateSandboxExec("node_exec", { ...targets.node_exec, command: "uname" }, { ...scope, clusters: [{ name: "prod", namespaces: ["app"] }] })).toThrow();
  expect(() => validateSandboxExec("pod_exec", { ...targets.pod_exec, namespace: "other", command: "uname" }, scope)).toThrow();
  expect(() => validateSandboxBuiltin({ id: "1", tool: "node_script", arguments: {} }, scope)).toThrow();
  for (const timeout_seconds of [0, 16, 1.5, "2"]) expect(() => validateSandboxExec("host_exec", { ...targets.host_exec, command: "uname", timeout_seconds }, scope)).toThrow();
});
