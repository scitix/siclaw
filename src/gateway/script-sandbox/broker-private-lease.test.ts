import { expect, it, vi } from "vitest";
import { ReadOnlyScriptBroker } from "./broker.js";
import { loadScriptSandboxConfig } from "../../script-sandbox/config.js";

const principal = { agentId: "agent", userId: "user", sessionId: "session", boxId: "box", callbackToken: "grant" };
const scope = { language: "python" as const, code: "pass", mcp: [{ server: "metrics", tools: ["query"] }] };
const call = { id: "call", tool: "mcp.call", arguments: { server: "metrics", tool: "query", arguments: {} } };
const config = () => ({ ...loadScriptSandboxConfig({}), mcpPolicy: { metrics: { query: {} } } });

it("waits for private lease validation before resolving MCP credentials", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const rpc = { request: vi.fn() };
  const validate = vi.fn(async () => { await pending; throw new Error("lease revoked"); });
  const broker = new ReadOnlyScriptBroker(rpc, config(), undefined, validate);
  const result = broker.call({ ...principal }, scope, call, new AbortController().signal);
  const rejected = expect(result).rejects.toThrow("lease revoked");
  await Promise.resolve();
  expect(rpc.request).not.toHaveBeenCalled();
  release(); await rejected;
  expect(rpc.request).not.toHaveBeenCalled();
});

it("rechecks the private lease after authorization and on result reads", async () => {
  const rpc = { request: vi.fn(async (method: string) => method === "config.getAgent" ? { status: "active" } : { user_id: "user" }) };
  let checks = 0;
  const broker = new ReadOnlyScriptBroker(rpc, config(), undefined, async () => {
    if (++checks === 2) throw new Error("lease revoked during authorization");
  });
  await expect(broker.authorize({ ...principal }, new AbortController().signal)).rejects.toThrow("lease revoked during authorization");
  expect(checks).toBe(2);
  const deny = new ReadOnlyScriptBroker(rpc, config(), undefined, async () => { throw new Error("lease lost"); });
  rpc.request.mockClear();
  await expect(deny.authorizeResult({ ...principal }, scope, call, new AbortController().signal)).rejects.toThrow("lease lost");
  expect(rpc.request).not.toHaveBeenCalled();
});
