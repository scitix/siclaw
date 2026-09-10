import { expect, it, vi } from "vitest";
import { ReadOnlyScriptBroker } from "./broker.js";
import { loadScriptSandboxConfig } from "../../script-sandbox/config.js";
import type { SandboxBuiltinExecutor } from "./broker.js";

const kubeconfig = JSON.stringify({ "current-context": "c", contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
  clusters: [{ name: "c", cluster: { server: "https://example.test" } }], users: [{ name: "u", user: { token: "private-token" } }] });
const scope = { language: "python" as const, code: "pass", hosts: ["host-a"], clusters: [{ name: "prod" }] };
const p = () => ({ agentId: "a", sessionId: "s", boxId: "b", userId: "u", callbackToken: "private-grant" });
const nodeCall = { id: "1", tool: "node_exec", arguments: { cluster: "prod", node: "node-a", command: "uname -r" } };
const credential = { name: "prod", type: "kubeconfig", files: [{ name: "cluster.kubeconfig", content: kubeconfig }] };
const rpc = () => ({ request: vi.fn(async (method: string) => method === "config.getAgent"
  ? { status: "active", tool_capabilities: ["run_sandbox", "run_commands"] } : { user_id: "u", credential }) });
const signal = () => new AbortController().signal;

it("caps concurrent node callbacks at ten and holds each slot until the callback settles", async () => {
  const finish: Array<() => void> = [];
  const builtin = vi.fn<SandboxBuiltinExecutor>(() => new Promise(resolve => finish.push(() => resolve({ text: "ok" }))));
  const broker = new ReadOnlyScriptBroker(rpc(), loadScriptSandboxConfig(), builtin);
  const pending = Array.from({ length: 10 }, () => broker.call(p(), scope, nodeCall, signal()));
  await vi.waitFor(() => expect(builtin).toHaveBeenCalledTimes(10));
  await expect(broker.call(p(), scope, nodeCall, signal())).rejects.toThrow("busy");
  expect(builtin).toHaveBeenCalledTimes(10);
  finish[0](); await pending[0];
  const next = broker.call(p(), scope, nodeCall, signal());
  await vi.waitFor(() => expect(builtin).toHaveBeenCalledTimes(11));
  finish.slice(1).forEach(f => f()); await Promise.all([...pending, next]);
});

it.each(["node_exec", "pod_exec", "host_exec"])("checks current %s capabilities, bindings and identity before executing", async tool => {
  const control = rpc();
  control.request.mockImplementation(async () => ({ status: "active", tool_capabilities: ["run_sandbox"] }) as any);
  const builtin = vi.fn<SandboxBuiltinExecutor>();
  const broker = new ReadOnlyScriptBroker(control, loadScriptSandboxConfig(), builtin);
  const args = tool === "host_exec" ? { host: "host-a", command: "uname" } : tool === "pod_exec"
    ? { cluster: "prod", namespace: "app", pod: "pod-a", command: "uname" } : nodeCall.arguments;
  const call = { id: "1", tool, arguments: args };
  await expect(broker.call(p(), scope, call, signal())).rejects.toThrow("capability");
  await expect(broker.authorizeResult(p(), scope, call, signal())).rejects.toThrow("capability");
  expect(builtin).not.toHaveBeenCalled();
  expect(control.request).not.toHaveBeenCalledWith("sandbox.resolve", expect.anything(), expect.anything());
});

it("requires an operator pin for every SSH hop and keeps credentials in the trusted callback", async () => {
  const config = loadScriptSandboxConfig();
  config.hostKeyPins = { "host-a": "SHA256:" + "a".repeat(43) };
  const credential = { name: "host-a", type: "ssh", files: [{ name: "host.password", content: "private-password" }],
    metadata: { ip: "192.0.2.2", port: 22 }, jump_chain: [{ name: "bastion", metadata: { ip: "192.0.2.1", port: 2222 }, files: [] }] };
  const control = rpc(); control.request.mockImplementation(async method => method === "config.getAgent" ? { status: "active" } : { user_id: "u", credential } as any);
  const builtin = vi.fn<SandboxBuiltinExecutor>(async () => ({ text: "Linux" }));
  const broker = new ReadOnlyScriptBroker(control, config, builtin);
  const call = { id: "1", tool: "host_exec", arguments: { host: "host-a", command: "uname" } };
  await expect(broker.call(p(), scope, call, signal())).rejects.toThrow("pin");
  expect(builtin).not.toHaveBeenCalled();
  config.hostKeyPins.bastion = "SHA256:" + "b".repeat(43);
  await expect(broker.call(p(), scope, call, signal())).resolves.toEqual({ text: "Linux" });
  expect(builtin.mock.calls[0][3]).toMatchObject({ tool: "host_exec", credential, hostKeyPins: { "192.0.2.1:2222": config.hostKeyPins.bastion, "192.0.2.2:22": config.hostKeyPins["host-a"] } });
  expect(JSON.stringify(builtin.mock.calls[0][1])).not.toContain("private-password");
});
