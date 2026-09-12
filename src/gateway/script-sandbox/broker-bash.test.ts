import { expect, it, vi } from "vitest";
import { ReadOnlyScriptBroker } from "./broker.js";
import { loadScriptSandboxConfig } from "../../script-sandbox/config.js";

const kubeconfig = JSON.stringify({ "current-context": "c", contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
  clusters: [{ name: "c", cluster: { server: "https://example.test" } }], users: [{ name: "u", user: { token: "private-token" } }] });
const scope = { language: "python" as const, code: "pass", clusters: [{ name: "prod" }] };
const p = () => ({ agentId: "a", sessionId: "s", boxId: "b", userId: "u", callbackToken: "private-callback-token" });
const call = { id: "1", tool: "bash", arguments: { cluster: "prod", command: "kubectl get nodes" } };
it("binds each trusted Bash callback to freshly authorized credentials and omits grants from audit", async () => {
  let capabilities = ["run_sandbox", "run_commands"];
  const rpc = { request: vi.fn(async (method: string) => method === "config.getAgent"
    ? { status: "active", tool_capabilities: capabilities }
    : { user_id: "u", credential: { type: "kubeconfig", files: [{ name: "cluster.kubeconfig", content: kubeconfig }] } }) };
  const builtin = vi.fn(async () => ({ text: "nodes" }));
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const broker = new ReadOnlyScriptBroker(rpc, loadScriptSandboxConfig(), builtin);
    await expect(broker.call(p(), scope, call, new AbortController().signal)).resolves.toEqual({ text: "nodes" });
    expect(builtin).toHaveBeenCalledOnce();
    expect(builtin.mock.calls[0][1]).toEqual({ ...call.arguments, timeout_seconds: 10 });
    expect(builtin.mock.calls[0][3]).toMatchObject({ tool: "bash", credential: { type: "kubeconfig", files: [{ name: "cluster.kubeconfig", content: kubeconfig }] } });
    expect(JSON.stringify(builtin.mock.calls[0][1])).not.toContain("private-token");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-token");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-callback-token");
    capabilities = ["run_scripts"];
    await expect(broker.call(p(), scope, call, new AbortController().signal)).rejects.toThrow();
    expect(builtin).toHaveBeenCalledOnce();
  } finally { log.mockRestore(); }
});
