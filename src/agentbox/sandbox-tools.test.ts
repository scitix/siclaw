import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ create: vi.fn(), evict: vi.fn() }));
const fixture = await vi.hoisted(async () => {
  const { Type } = await import("@sinclair/typebox");
  const parameters = Type.Object({ command: Type.String(), timeout_seconds: Type.Number(),
    cluster: Type.Optional(Type.String()), host: Type.Optional(Type.String()), node: Type.Optional(Type.String()),
    namespace: Type.Optional(Type.String()), pod: Type.Optional(Type.String()) });
  return (name: string, ...args: unknown[]) => ({ parameters, ...state.create(name, ...args) });
});
vi.mock("../tools/cmd-exec/restricted-bash.js", () => ({ createRestrictedBashTool: (...args: unknown[]) => fixture("bash", ...args) }));
vi.mock("../tools/cmd-exec/host-exec.js", () => ({ createHostExecTool: (...args: unknown[]) => fixture("host_exec", ...args) }));
vi.mock("../tools/cmd-exec/node-exec.js", () => ({ createNodeExecTool: (...args: unknown[]) => fixture("node_exec", ...args) }));
vi.mock("../tools/cmd-exec/pod-exec.js", () => ({ createPodExecTool: (...args: unknown[]) => fixture("pod_exec", ...args) }));
vi.mock("../tools/infra/debug-pod.js", () => ({ debugPodCache: { evictFor: state.evict } }));
import { executeSandboxBuiltin } from "./sandbox-tools.js";
import type { SandboxBuiltinApproval } from "../shared/sandbox-tool-types.js";
const kubeconfig = JSON.stringify({ "current-context": "c", contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
  clusters: [{ name: "c", cluster: { server: "https://example.test" } }], users: [{ name: "u", user: { token: "snapshot-token" } }] });
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-tools-test-")); state.create.mockReset(); state.evict.mockReset().mockResolvedValue(undefined); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const approval = (tool: "node_exec" | "pod_exec"): SandboxBuiltinApproval => ({ tool,
  credential: { name: "prod", type: "kubeconfig", files: [{ name: "prod.kubeconfig", content: kubeconfig }] } });
it.each(["node_exec", "pod_exec"] as const)("executes the shared %s factory against only the authorized credential snapshot", async tool => {
  let snapshotPath: string;
  state.create.mockImplementation((name, ref, ...options) => ({ execute: async (_id: string, args: any, signal: AbortSignal) => {
    expect(name).toBe(tool); expect(args.cluster).toBe("prod"); expect(signal.aborted).toBe(false);
    expect(options.at(-1)).toMatchObject({ outputMode: "data" });
    if (tool === "node_exec") expect(options.at(-1).sandboxDiagnostics).toBe(true);
    else expect(options.at(-1).remoteTimeoutSeconds).toBe(10);
    const broker = ref.credentialBroker;
    await broker.ensureCluster("prod", "test");
    snapshotPath = broker.getClusterLocalInfo("prod").path;
    expect(fs.readFileSync(snapshotPath, "utf8")).toBe(kubeconfig);
    await expect(broker.ensureCluster("other", "test")).rejects.toThrow();
    options.at(-1).onOutputData({ text: "rows", stderr: "", notices: [] });
    return { content: [{ type: "text", text: "rows" }], details: { exitCode: 0, exit_class: "success" } };
  } }));
  state.evict.mockImplementation(async (owner, cluster, node) => {
    expect(owner).toMatch(/^sandbox-/); expect(cluster).toBe("prod"); expect(node).toBe("node-a");
    expect(fs.existsSync(snapshotPath)).toBe(true);
  });
  const args = { command: "uname", timeout_seconds: 10, cluster: "prod", ...(tool === "node_exec" ? { node: "node-a" } : { namespace: "app", pod: "pod-a" }) };
  await expect(executeSandboxBuiltin({ tool, arguments: args }, approval(tool), dir, new AbortController().signal)).resolves.toEqual({ text: "rows", stderr: "", notices: [], exit_code: 0, exit_class: "success" });
  expect(fs.readdirSync(dir)).toEqual([]);
  expect(state.evict).toHaveBeenCalledTimes(tool === "node_exec" ? 1 : 0);
});
it.each(["blocked", "error", "truncated", "oversized", "cancelled", "missing-data"])("rejects %s output and still cleans the diagnostic resources before credentials", async kind => {
  const controller = new AbortController();
  state.create.mockImplementation((_name, _ref, ...options) => ({ execute: async () => {
    if (kind === "cancelled") { controller.abort(); throw new Error("aborted"); }
    if (kind !== "missing-data") options.at(-1).onOutputData({ text: kind === "oversized" ? "x".repeat(4 * 1024 * 1024) : "prefix", stderr: "", notices: [] });
    return { content: [{ type: "text", text: "display" }], details: { [kind]: true } };
  } }));
  state.evict.mockImplementation(async () => expect(fs.readdirSync(dir)).toHaveLength(1));
  await expect(executeSandboxBuiltin({ tool: "node_exec", arguments: { cluster: "prod", node: "node-a", command: "uname", timeout_seconds: 10 } }, approval("node_exec"), dir, controller.signal)).rejects.toThrow();
  expect(state.evict).toHaveBeenCalledOnce(); expect(fs.readdirSync(dir)).toEqual([]);
});
it("fails closed on missing or malformed SSH pins before constructing the actual host tool", async () => {
  const request = { tool: "host_exec" as const, arguments: { host: "host-a", command: "uname", timeout_seconds: 10 } };
  const grant: SandboxBuiltinApproval = { tool: "host_exec", credential: { name: "host-a", type: "ssh", files: [] } };
  for (const pins of [undefined, {}, { "192.0.2.1:22": "" }]) {
    await expect(executeSandboxBuiltin(request, { ...grant, hostKeyPins: pins }, dir, new AbortController().signal)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", execution: "NOT_DISPATCHED" });
  }
  expect(state.create).not.toHaveBeenCalled(); expect(fs.readdirSync(dir)).toEqual([]);
});
it("removes credential snapshots even if confirmed cleanup fails", async () => {
  state.create.mockImplementation((_name, _ref, options) => ({ execute: async () => {
    options.onOutputData({ text: "ok", stderr: "", notices: [] });
    return { content: [{ type: "text", text: "ok" }], details: {} };
  } }));
  state.evict.mockRejectedValue(new Error("cleanup unconfirmed"));
  await expect(executeSandboxBuiltin({ tool: "node_exec", arguments: { cluster: "prod", node: "node-a", command: "uname", timeout_seconds: 10 } }, approval("node_exec"), dir, new AbortController().signal)).rejects.toThrow("cleanup");
  expect(fs.readdirSync(dir)).toEqual([]);
});

it("rejects an expired trusted dispatch deadline before constructing or executing a tool", async () => {
  await expect(executeSandboxBuiltin({ tool: "node_exec", arguments: { cluster: "prod", node: "node-a", command: "uname", timeout_seconds: 10 } },
    { ...approval("node_exec"), deadlineMs: Date.now() - 1 }, dir, new AbortController().signal)).rejects.toMatchObject({ code: "UNAUTHORIZED", execution: "NOT_DISPATCHED" });
  expect(state.create).not.toHaveBeenCalled(); expect(fs.readdirSync(dir)).toEqual([]);
});
