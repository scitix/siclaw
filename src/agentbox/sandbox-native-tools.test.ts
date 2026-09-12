import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../tools/infra/bounded-exec.js", () => ({ boundedExec: vi.fn() }));
import { boundedExec } from "../tools/infra/bounded-exec.js";
import * as security from "../tools/infra/security-pipeline.js";
import { debugPodCache } from "../tools/infra/debug-pod.js";
import { executeSandboxBuiltin } from "./sandbox-tools.js";
import { resolveSandboxBuiltin, type SandboxBuiltinTool } from "../script-sandbox/tool-dispatch.js";
import type { SandboxBuiltinApproval } from "../shared/sandbox-tool-types.js";
import { sanitizeSandboxResult } from "../script-sandbox/sanitize.js";
import { ScriptResultTransfer } from "../script-sandbox/result-transfer.js";

const kubeconfig = JSON.stringify({ "current-context": "c", contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
  clusters: [{ name: "c", cluster: { server: "https://example.test" } }], users: [{ name: "u", user: { token: "snapshot-token" } }] });
const scope = { language: "python" as const, code: "pass", clusters: [{ name: "prod" }], hosts: ["host-a"] };
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-native-test-"));
  vi.mocked(boundedExec).mockReset();
  vi.spyOn(debugPodCache, "evictFor").mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

async function call(tool: SandboxBuiltinTool, command: string, extra = {}) {
  const args = tool === "host_exec" ? { host: "host-a", command, ...extra }
    : { cluster: "prod", command, ...(tool === "node_exec" ? { node: "node-a" } : {}),
      ...(tool === "pod_exec" ? { pod: "pod-a", namespace: "app" } : {}), ...extra };
  const request = resolveSandboxBuiltin({ id: "call", tool, arguments: args }, scope);
  const approval: SandboxBuiltinApproval = tool === "host_exec"
    ? { tool, credential: { name: "host-a", type: "ssh", files: [], metadata: { ip: "192.0.2.1", port: 22 } }, hostKeyPins: { "192.0.2.1:22": "SHA256:" + "a".repeat(43) } }
    : { tool, credential: { name: "prod", type: "kubeconfig", files: [{ name: "prod.kubeconfig", content: kubeconfig }] } };
  return executeSandboxBuiltin(request, approval, dir, new AbortController().signal);
}

it.each([
  "kubectl get nodes -o json", "kubectl get deployments -n app -o json",
  "kubectl describe deployment api -n app", "kubectl logs api -n app --tail=100",
  "kubectl get pods -n app | grep Running",
])("uses the real Bash tool's existing policy for %s", async command => {
  const pre = vi.spyOn(security, "preExecSecurity");
  vi.mocked(boundedExec).mockImplementation(async (_cmd, options) => {
    expect(fs.readFileSync(options.env!.KUBECONFIG, "utf8")).toBe(kubeconfig);
    return { stdout: "healthy", stderr: "" };
  });
  const result = await call("bash", command);
  expect(result).toMatchObject({ text: expect.stringContaining("healthy") });
  expect(pre).toHaveBeenCalledOnce();
  expect(pre.mock.calls[0][0]).toBe(command);
  expect(boundedExec).toHaveBeenCalledOnce();
  expect(fs.readdirSync(dir)).toEqual([]);
});

it.each([
  ["nodes", { kind: "NodeList", items: [] }, false],
  ["pods", { kind: "PodList", items: [{ kind: "Pod", metadata: { name: "api" }, spec: { containers: [{ name: "api", env: [{ name: "PASSWORD", value: "private-test-value" }] }] } }] }, true],
  ["secrets", { kind: "Secret", data: { password: "private-test-value" } }, true],
  ["configmaps", { kind: "ConfigMap", data: { password: "private-test-value" } }, true],
] as const)("keeps %s JSON parseable with warnings and redaction, inline and in file delivery", async (resource, payload, redacted) => {
  const pre = vi.spyOn(security, "preExecSecurity");
  const warning = "Warning: Use tokens from the TokenRequest API.";
  vi.mocked(boundedExec).mockResolvedValue({ stdout: JSON.stringify(payload), stderr: warning });
  const result = sanitizeSandboxResult(await call("bash", `kubectl get ${resource} -o json`)) as any;
  expect(JSON.parse(result.text).kind).toBe(payload.kind);
  expect(result).toMatchObject({ stderr: warning, exit_code: 0, exit_class: "success" });
  expect(result.notices.length > 0).toBe(redacted);
  expect(JSON.stringify(result)).not.toContain("private-test-value");
  expect(pre).toHaveBeenCalledOnce();
  expect(boundedExec).toHaveBeenCalledOnce();

  const transfer = new ScriptResultTransfer();
  const authorize = vi.fn(async () => {});
  const descriptor = transfer.open(result, authorize);
  const chunk = await transfer.read({ transfer_id: descriptor.transfer_id, offset: 0 }, new AbortController().signal);
  const saved = JSON.parse(Buffer.from(chunk.data, "base64").toString("utf8"));
  expect(chunk.done).toBe(true);
  expect(saved).toEqual(result);
  expect(JSON.parse(saved.text).kind).toBe(payload.kind);
  expect(authorize).toHaveBeenCalledOnce();
  expect(boundedExec).toHaveBeenCalledOnce();
});

it("preserves a no-match exit status without appending it to stdout", async () => {
  vi.mocked(boundedExec).mockRejectedValue({ code: 1, stdout: "\n__siclaw_pipe_status_9f3c__0 1\n", stderr: "" });
  const result = await call("bash", "kubectl get pods -n app | grep absent") as any;
  expect(result.text).toBe("");
  expect(result.exit_code).toBe(1);
  expect(result.exit_class).toBe("no_match");
  expect(result.notices.length).toBeGreaterThan(0);
});

it("transfers a large sanitized JSON result across chunks without repeating the query", async () => {
  const payload = { kind: "PodList", items: Array.from({ length: 1000 }, (_, i) => ({
    metadata: { name: `pod-${i}` }, spec: { containers: [{ name: "api", image: "example/api:latest",
      env: [{ name: "PASSWORD", value: "private-test-value" }] }] },
  })) };
  vi.mocked(boundedExec).mockResolvedValue({ stdout: JSON.stringify(payload), stderr: "query warning" });
  const result = sanitizeSandboxResult(await call("bash", "kubectl get pods -n app -o json"));
  const transfer = new ScriptResultTransfer();
  const authorize = vi.fn(async () => {});
  const descriptor = transfer.open(result, authorize);
  expect(descriptor.bytes).toBeGreaterThan(128 * 1024);
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < descriptor.bytes) {
    const chunk = await transfer.read({ transfer_id: descriptor.transfer_id, offset }, new AbortController().signal);
    chunks.push(Buffer.from(chunk.data, "base64"));
    offset = chunk.next_offset;
    expect(chunk.done).toBe(offset === descriptor.bytes);
  }
  const saved = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  expect(JSON.parse(saved.text).items).toHaveLength(1000);
  expect(saved.stderr).toBe("query warning");
  expect(saved.notices).toHaveLength(1);
  expect(saved.text).not.toContain("private-test-value");
  expect(authorize).toHaveBeenCalledTimes(chunks.length);
  expect(boundedExec).toHaveBeenCalledOnce();
});

it.each([
  ["bash", "kubectl delete pod api -n app"],
  ["bash", "kubectl logs api -n app"],
  ["bash", "kubectl get pods --server=https://other.example"],
  ["node_exec", "rm /tmp/example"],
  ["node_exec", "sysctl -w net.ipv4.ip_forward=1"],
  ["pod_exec", "rm /tmp/example"],
  ["host_exec", "curl -X POST https://example.test"],
])("rejects %s / %s in the real shared tool, not a sandbox command filter", async (tool, command) => {
  const pre = vi.spyOn(security, "preExecSecurity");
  await expect(call(tool as SandboxBuiltinTool, command)).rejects.toMatchObject({ code: "UNAUTHORIZED", execution: "NOT_DISPATCHED" });
  expect(pre).toHaveBeenCalledOnce();
  expect(pre.mock.results[0].value.error).toBeTruthy();
  expect(boundedExec).not.toHaveBeenCalled();
  expect(fs.readdirSync(dir)).toEqual([]);
});

it.each([
  ["bash", { run_in_background: true }],
  ["bash", { env: { KUBECONFIG: "/private" } }],
  ["node_exec", { image: "untrusted/image" }],
  ["node_exec", { pod: "other-pod", namespace: "app" }],
  ["node_exec", { netns: "other" }],
  ["pod_exec", { credential: "private" }],
])("uses %s's published schema to reject execution overrides", async (tool, extra) => {
  const pre = vi.spyOn(security, "preExecSecurity");
  await expect(call(tool as SandboxBuiltinTool, "uname", extra)).rejects.toThrow("arguments");
  expect(pre).not.toHaveBeenCalled();
  expect(boundedExec).not.toHaveBeenCalled();
  expect(fs.readdirSync(dir)).toEqual([]);
});
