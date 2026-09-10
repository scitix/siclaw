import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ create: vi.fn(), evict: vi.fn() }));
vi.mock("../tools/cmd-exec/restricted-bash.js", () => ({ createRestrictedBashTool: (...args: unknown[]) => state.create("bash", ...args) }));
vi.mock("../tools/cmd-exec/host-exec.js", () => ({ createHostExecTool: (...args: unknown[]) => state.create("host_exec", ...args) }));
vi.mock("../tools/cmd-exec/node-exec.js", () => ({ createNodeExecTool: (...args: unknown[]) => state.create("node_exec", ...args) }));
vi.mock("../tools/cmd-exec/pod-exec.js", () => ({ createPodExecTool: (...args: unknown[]) => state.create("pod_exec", ...args) }));
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
    return { content: [{ type: "text", text: "rows" }], details: {} };
  } }));
  state.evict.mockImplementation(async (owner, cluster, node) => {
    expect(owner).toMatch(/^sandbox-/); expect(cluster).toBe("prod"); expect(node).toBe("node-a");
    expect(fs.existsSync(snapshotPath)).toBe(true);
  });
  const args = { command: "uname", timeout_seconds: 10, cluster: "prod", ...(tool === "node_exec" ? { node: "node-a" } : { namespace: "app", pod: "pod-a" }) };
  await expect(executeSandboxBuiltin({ tool, arguments: args }, approval(tool), dir, new AbortController().signal)).resolves.toEqual({ text: "rows" });
  expect(fs.readdirSync(dir)).toEqual([]);
  expect(state.evict).toHaveBeenCalledTimes(tool === "node_exec" ? 1 : 0);
});
it.each(["blocked", "error", "truncated", "oversized", "cancelled"])("rejects %s output and still cleans the diagnostic resources before credentials", async kind => {
  const controller = new AbortController();
  state.create.mockReturnValue({ execute: async () => {
    if (kind === "cancelled") { controller.abort(); throw new Error("aborted"); }
    return { content: [{ type: "text", text: kind === "oversized" ? "x".repeat(4 * 1024 * 1024) : "prefix" }], details: { [kind]: true } };
  } });
  state.evict.mockImplementation(async () => expect(fs.readdirSync(dir)).toHaveLength(1));
  await expect(executeSandboxBuiltin({ tool: "node_exec", arguments: { cluster: "prod", node: "node-a", command: "uname", timeout_seconds: 10 } }, approval("node_exec"), dir, controller.signal)).rejects.toThrow();
  expect(state.evict).toHaveBeenCalledOnce(); expect(fs.readdirSync(dir)).toEqual([]);
});
it("fails closed on missing or malformed SSH pins before constructing the actual host tool", async () => {
  const request = { tool: "host_exec" as const, arguments: { host: "host-a", command: "uname", timeout_seconds: 10 } };
  const grant: SandboxBuiltinApproval = { tool: "host_exec", credential: { name: "host-a", type: "ssh", files: [] } };
  for (const pins of [undefined, {}, { "192.0.2.1:22": "" }]) {
    await expect(executeSandboxBuiltin(request, { ...grant, hostKeyPins: pins }, dir, new AbortController().signal)).rejects.toThrow("pins");
  }
  expect(state.create).not.toHaveBeenCalled(); expect(fs.readdirSync(dir)).toEqual([]);
});
it("removes credential snapshots even if confirmed cleanup fails", async () => {
  state.create.mockReturnValue({ execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
  state.evict.mockRejectedValue(new Error("cleanup unconfirmed"));
  await expect(executeSandboxBuiltin({ tool: "node_exec", arguments: { cluster: "prod", node: "node-a", command: "uname", timeout_seconds: 10 } }, approval("node_exec"), dir, new AbortController().signal)).rejects.toThrow("cleanup");
  expect(fs.readdirSync(dir)).toEqual([]);
});
