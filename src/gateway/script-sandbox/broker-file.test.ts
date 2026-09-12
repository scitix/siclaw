import { afterEach, expect, it, vi } from "vitest";
import { ReadOnlyScriptBroker } from "./broker.js";
import { loadScriptSandboxConfig } from "../../script-sandbox/config.js";
import type { ScriptToolCall } from "../../script-sandbox/types.js";

const config = () => ({ ...loadScriptSandboxConfig({ SICLAW_SCRIPT_SANDBOX_IMAGE: "fixture" }),
  mcpPolicy: { metrics: { query: { fixedArguments: { tenant: "fixture" } } } } });
const scope = { language: "python" as const, code: "pass", clusters: [{ name: "prod" }],
  hosts: ["node"], mcp: [{ server: "metrics", tools: ["query"] }] };
const principal = () => ({ agentId: "a", userId: "u", sessionId: "s", boxId: "b" });
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["bash", { cluster: "prod", command: "kubectl get nodes" }, "cluster", "prod"],
  ["host_exec", { host: "node", command: "uname" }, "host", "node"],
  ["mcp.call", { server: "metrics", tool: "query", arguments: {} }, "mcp", "metrics"],
])("rejects undelivered %s results and still checks revocation and identity changes", async (tool, args, source, name) => {
  const rpc = { request: vi.fn(async (method: string) => method === "config.getAgent" ? { status: "active" } : { user_id: "u" }) };
  const broker = new ReadOnlyScriptBroker(rpc, config());
  const call = { id: "1", tool, arguments: args, delivery: "file" } as ScriptToolCall;
  const execute = vi.spyOn(broker, "call");
  await expect(broker.authorizeResult(principal(), scope, call, signal())).rejects.toThrow("Result authorization changed");
  expect(rpc.request).toHaveBeenLastCalledWith("sandbox.resolve", { agent_id: "a", session_id: "s", source, name }, 10_000);
  rpc.request.mockImplementation(async method => { if (method === "config.getAgent") return { status: "active" }; throw new Error("resource revoked"); });
  await expect(broker.authorizeResult(principal(), scope, call, signal())).rejects.toThrow("revoked");
  rpc.request.mockImplementation(async method => method === "config.getAgent" ? { status: "active" } : { user_id: "other" });
  await expect(broker.authorizeResult(principal(), scope, call, signal())).rejects.toThrow("authorization");
  expect(execute).not.toHaveBeenCalled();
});

it("uses the real MCP client with bounded large, fully sanitized file results", async () => {
  const rows = "healthy-node\n".repeat(30_000);
  let text = rows + "token: private-value\nlast-node";
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect(init.redirect).toBe("error");
    if (init.method !== "POST") return new Response(null, { status: 405 });
    const body = JSON.parse(String(init.body));
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result = body.method === "initialize" ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { content: [{ type: "text", text }] };
    if (body.method === "tools/call") expect(body.params).toEqual({ name: "query", arguments: { tenant: "fixture" } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher);
  const rpc = { request: vi.fn(async (method: string) => method === "config.getAgent" ? { status: "active" } :
    { user_id: "u", mcp: { transport: "streamable-http", url: "https://fixture.example/mcp" } }) };
  const broker = new ReadOnlyScriptBroker(rpc, config());
  const call: ScriptToolCall = { id: "1", tool: "mcp.call", arguments: { server: "metrics", tool: "query", arguments: {} }, delivery: "file" };
  const value: any = await broker.call(principal(), scope, call, signal());
  expect(value.content[0].text.startsWith(rows)).toBe(true);
  expect(value.content[0].text).toContain("last-node");
  expect(JSON.stringify(value)).not.toMatch(/private-value|siclaw-output|truncated/);
  await expect(broker.call(principal(), scope, { ...call, delivery: undefined }, signal())).rejects.toThrow();
  text = "x".repeat(4 * 1024 * 1024);
  await expect(broker.call(principal(), scope, call, signal())).rejects.toThrow();
});

it("keeps the fixed SDK MCP result shape and original tool name, with service arguments supplied outside the runner", async () => {
  const calls: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    if (init.method !== "POST") return new Response(null, { status: 405 });
    const body = JSON.parse(String(init.body));
    if (body.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    else {
      expect(body.method).toBe("tools/call");
      calls.push(body.params);
      result = { content: [{ type: "text", text: '{"count":2}' }], structuredContent: { count: 2 }, isError: false };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  }));
  const rpc = { request: vi.fn(async (method: string) => method === "config.getAgent" ? { status: "active" } :
    { user_id: "u", mcp: { transport: "streamable-http", url: "https://fixture.example/mcp", headers: { Authorization: "Bearer private-fixture-credential" } } }) };
  const broker = new ReadOnlyScriptBroker(rpc, config());
  for (const delivery of [undefined, "file"] as const) {
    const result = await broker.call(principal(), scope, { id: "query", tool: "mcp.call", arguments: { server: "metrics", tool: "query", arguments: { query: "up" } }, delivery }, signal());
    expect(result).toEqual({ content: [{ type: "text", text: '{"count":2}' }], structuredContent: { count: 2 }, isError: false });
    expect(JSON.stringify(result)).not.toMatch(/private-fixture|tenant|fixture.example/);
  }
  expect(calls).toEqual(Array(2).fill({ name: "query", arguments: { query: "up", tenant: "fixture" } }));
});
