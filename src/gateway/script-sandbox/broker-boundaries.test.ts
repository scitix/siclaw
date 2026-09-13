import { afterEach, expect, it, vi } from "vitest";
import { ReadOnlyScriptBroker, type SandboxBuiltinExecutor } from "./broker.js";
import { loadScriptSandboxConfig } from "../../script-sandbox/config.js";
import type { ScriptToolCall } from "../../script-sandbox/types.js";

const kubeconfig = JSON.stringify({ "current-context": "c", contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
  clusters: [{ name: "c", cluster: { server: "https://cluster.example" } }], users: [{ name: "u", user: { token: "fixture-token" } }] });
const principal = () => ({ agentId: "a", sessionId: "s", boxId: "b", userId: "u", callbackToken: "fixture-grant" });
const scope = { language: "python" as const, code: "pass", clusters: [{ name: "prod" }], hosts: ["host-id"], mcp: [{ server: "metrics", tools: ["query"] }] };
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
function setup() {
  let grant: any = { user_id: "u", credential: { name: "prod", type: "kubeconfig", files: [{ name: "c.kubeconfig", content: kubeconfig }] } };
  const config = { ...loadScriptSandboxConfig(), hostKeyPins: { "host-name": "SHA256:" + "a".repeat(43) }, mcpPolicy: { metrics: { query: {} } } };
  const builtin = vi.fn<SandboxBuiltinExecutor>(async () => ({ text: "rows" }));
  const broker = new ReadOnlyScriptBroker({ request: async method => method === "config.getAgent" ? { status: "active" } : structuredClone(grant) }, config, builtin);
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    if (init.method !== "POST") return new Response(null, { status: 405 });
    const body = JSON.parse(String(init.body));
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result = body.method === "initialize" ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { content: [{ type: "text", text: "rows" }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  }));
  return { config, broker, builtin, get grant() { return grant; }, set grant(value) { grant = value; } };
}
it.each(["bash", "host_exec", "mcp.call"])("fences %s result delivery against replacement of the authorized snapshot", async tool => {
  const s = setup();
  const args = tool === "bash" ? { cluster: "prod", command: "kubectl get nodes" } : tool === "host_exec" ? { host: "host-id", command: "uname" } : { server: "metrics", tool: "query", arguments: {} };
  if (tool === "host_exec") s.grant = { user_id: "u", credential: { name: "host-name", type: "ssh", files: [], metadata: { ip: "HOST.EXAMPLE" } } };
  if (tool === "mcp.call") s.grant = { user_id: "u", mcp: { transport: "streamable-http", url: "https://metrics.example/mcp" } };
  const call = { id: "a", tool, arguments: args, delivery: "file" } as ScriptToolCall;
  await s.broker.call(principal(), scope, call, signal());
  await expect(s.broker.authorizeResult(principal(), scope, call, signal())).resolves.toBeUndefined();
  if (tool === "host_exec") expect(s.builtin.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ hostKeyPins: { "host.example:22": s.config.hostKeyPins["host-name"] } })]));
  if (tool === "mcp.call") s.grant.mcp.url = "https://replacement.example/mcp";
  else s.grant.credential.files = [{ name: "c.kubeconfig", content: kubeconfig.replace("fixture-token", "replacement-token") }];
  await expect(s.broker.authorizeResult(principal(), scope, call, signal())).rejects.toThrow("Result authorization changed");
});
it("applies operator policy replacement to inline and chunk delivery without replaying MCP", async () => {
  const s = setup(); s.grant = { user_id: "u", mcp: { transport: "streamable-http", url: "https://metrics.example/mcp" } };
  const call: ScriptToolCall = { id: "a", tool: "mcp.call", arguments: { server: "metrics", tool: "query", arguments: {} } };
  await s.broker.call(principal(), scope, call, signal());
  await s.broker.authorizeResult(principal(), scope, call, signal());
  s.config.mcpPolicy.metrics.query = { fixedArguments: { tenant: "new-tenant" } };
  await expect(s.broker.authorizeResult(principal(), scope, call, signal())).rejects.toThrow("policy changed");
  delete (s.config.mcpPolicy.metrics as any).query;
  await expect(s.broker.authorizeResult(principal(), scope, call, signal())).rejects.toThrow("reviewed");
});
it("serializes whitespace and omitted namespace aliases of one Pod", async () => {
  const s = setup(); const finish: Array<() => void> = [];
  s.builtin.mockImplementation(() => new Promise(resolve => finish.push(() => resolve({ text: "ok" }))));
  const tasks = [undefined, "default", " default ", "default"].map((namespace, i) => s.broker.call(principal(), scope,
    { id: String(i), tool: "pod_exec", arguments: { cluster: "prod", pod: i === 2 ? " api " : "api", namespace, command: "uname" } }, signal()));
  for (let i = 0; i < 4; i++) {
    await vi.waitFor(() => expect(finish).toHaveLength(i + 1));
    expect(s.builtin.mock.calls[i][1]).toMatchObject({ namespace: "default", pod: "api" });
    finish[i](); await tasks[i];
  }
});
