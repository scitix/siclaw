import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import http from "node:http";
import { createRestRouter } from "../gateway/rest-router.js";
import { registerSandboxIngress } from "./sandbox-ingress.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";
import { SANDBOX_LEASE_CLOSE, SANDBOX_LEASE_OPEN, SANDBOX_TOOL_PATH } from "../script-sandbox/external-protocol.js";

const token = "a".repeat(64), hash = createHash("sha256").update(token).digest("hex");
const call = { id: "1", tool: "bash", arguments: { cluster: "test", command: "kubectl get nodes -o json" } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); });
async function setup(publicUrl: string | undefined = "https://portal.example") {
  const router = createRestRouter();
  const authorize = vi.fn(async () => ({ user_id: "user-1" }));
  const handlers = new Map<string, (p: any, id: string) => Promise<any>>([["sandbox.resolve", authorize]]);
  const sendCommandToRuntime = vi.fn(async () => ({ ok: true, payload: { id: "1", result: { nodes: [] } } }));
  const sendCommand = vi.fn();
  registerSandboxIngress(router, handlers, { sendCommandToRuntime, sendCommand } as unknown as RuntimeConnectionMap, publicUrl);
  const server = http.createServer((req, res) => { if (!router.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as any).port}${SANDBOX_TOOL_PATH}`;
  const grant = () => ({ token_hash: hash, run_id: "run-1", agent_id: "agent-1", session_id: "session-1", expires_at: Date.now() + 30_000 });
  const post = (body: unknown, auth = `Bearer ${token}`) => fetch(url, { method: "POST", headers: { Authorization: auth }, body: JSON.stringify(body) });
  return { handlers, authorize, sendCommandToRuntime, sendCommand, post, grant };
}

describe("public sandbox tool ingress", () => {
  it("authorizes private registration and routes only to its original Runtime", async () => {
    const s = await setup();
    expect((await s.post({ call })).status).toBe(403);
    expect(await s.handlers.get(SANDBOX_LEASE_OPEN)!(s.grant(), "runtime-1")).toEqual({ endpoint: "https://portal.example" + SANDBOX_TOOL_PATH });
    expect(s.authorize).toHaveBeenCalledWith({ agent_id: "agent-1", session_id: "session-1", source: "", name: "" }, "runtime-1");
    const response = await s.post({ call });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ id: "1", result: { nodes: [] } });
    expect(s.sendCommandToRuntime).toHaveBeenCalledWith("runtime-1", "sandbox.tool", { run_id: "run-1", token, call }, 65_000);
    expect(s.sendCommand).not.toHaveBeenCalled();
    await expect(s.handlers.get(SANDBOX_LEASE_CLOSE)!({ token_hash: hash, run_id: "run-1" }, "wrong-runtime")).rejects.toThrow();
    await s.handlers.get(SANDBOX_LEASE_CLOSE)!({ token_hash: hash, run_id: "run-1" }, "runtime-1");
    expect((await s.post({ call })).status).toBe(403);
  });
  it("rejects expired, duplicate, denied and missing-URL registration", async () => {
    const s = await setup();
    for (const patch of [{ expires_at: Date.now() - 1 }, { expires_at: Date.now() + 611_000 }, { runtime_id: "injected" }, { token_hash: token + "x" }]) {
      await expect(s.handlers.get(SANDBOX_LEASE_OPEN)!({ ...s.grant(), ...patch }, "runtime-1")).rejects.toThrow();
    }
    await s.handlers.get(SANDBOX_LEASE_OPEN)!(s.grant(), "runtime-1");
    await expect(s.handlers.get(SANDBOX_LEASE_OPEN)!(s.grant(), "runtime-1")).rejects.toThrow();
    const disabled = await setup("");
    await expect(disabled.handlers.get(SANDBOX_LEASE_OPEN)!(disabled.grant(), "runtime-1")).rejects.toThrow();
    expect((await disabled.post({ call })).status).toBe(401);
  });
  it("rejects identity/method/scope injection and oversize input, hiding upstream errors", async () => {
    const s = await setup(); await s.handlers.get(SANDBOX_LEASE_OPEN)!(s.grant(), "runtime-1");
    for (const body of [{ call, runtime_id: "other" }, { call, method: "sandbox.resolve" }, { call, scope: {} }, { call: { large: "x".repeat(256 * 1024) } }]) {
      try { expect((await s.post(body)).status).not.toBe(200); } catch (error) { expect(String(error)).toContain("fetch failed"); }
    }
    expect(s.sendCommandToRuntime).not.toHaveBeenCalled();
    s.sendCommandToRuntime.mockRejectedValue(new Error("fake-upstream-secret"));
    const response = await s.post({ call }); expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("fake-upstream-secret");
  });
});


it("forwards file metadata and bounded chunks without widening the public response limit", async () => {
  const s = await setup(); await s.handlers.get(SANDBOX_LEASE_OPEN)!(s.grant(), "runtime-1");
  const transfer = "b".repeat(64);
  for (const request of [{ ...call, delivery: "file" },
    { id: "2", tool: "result.read", arguments: { transfer_id: transfer, offset: 0 } },
    { id: "3", tool: "result.discard", arguments: { transfer_id: transfer } }]) {
    const payload = { id: request.id, result: { data: Buffer.alloc(48 * 1024).toString("base64"), next_offset: 49152, done: false } };
    s.sendCommandToRuntime.mockResolvedValueOnce({ ok: true, payload } as any);
    const response = await s.post({ call: request });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(payload);
    expect(s.sendCommandToRuntime).toHaveBeenLastCalledWith("runtime-1", "sandbox.tool", { run_id: "run-1", token, call: request }, 65_000);
  }
  s.sendCommandToRuntime.mockResolvedValueOnce({ ok: true, payload: { result: "x".repeat(256 * 1024) } } as any);
  expect(await (await s.post({ call: { ...call, id: "oversize" } })).json()).toMatchObject({ code: "UNAUTHORIZED" });
  await s.handlers.get(SANDBOX_LEASE_CLOSE)!({ token_hash: hash, run_id: "run-1" }, "runtime-1");
  expect((await s.post({ call: { id: "4", tool: "result.read", arguments: { transfer_id: transfer, offset: 49152 } } })).status).toBe(403);
  expect(s.sendCommandToRuntime).toHaveBeenCalledTimes(4);
});

it("allows diagnostic startup without broadening other callback deadlines", async () => {
  const s = await setup(); await s.handlers.get(SANDBOX_LEASE_OPEN)!(s.grant(), "runtime-1");
  const request = { id: "node", tool: "node_exec", arguments: { cluster: "test", node: "node-a", command: "uname" } };
  expect((await s.post({ call: request })).status).toBe(200);
  expect(s.sendCommandToRuntime).toHaveBeenLastCalledWith("runtime-1", "sandbox.tool", { run_id: "run-1", token, call: request }, 135_000);
});

it("relays ten independent callbacks, rejects the eleventh and never releases an uncertain slot", async () => {
  const s = await setup(); await s.handlers.get(SANDBOX_LEASE_OPEN)!(s.grant(), "runtime-1");
  const finish: Array<() => void> = [];
  s.sendCommandToRuntime.mockImplementation(() => new Promise(resolve => finish.push(() => resolve({ ok: true, payload: {} } as any))));
  const pending = Array.from({ length: 10 }, (_, i) => s.post({ call: { ...call, id: String(i) } }));
  await vi.waitFor(() => expect(finish).toHaveLength(10));
  expect((await s.post({ call: { ...call, id: "extra" } })).status).toBe(403);
  finish[0](); expect((await pending[0]).status).toBe(200);
  s.sendCommandToRuntime.mockRejectedValueOnce(new Error("transport lost"));
  expect(await (await s.post({ call: { ...call, id: "uncertain" } })).json()).toMatchObject({ code: "EXECUTION_UNKNOWN", execution: "UNKNOWN" });
  expect((await s.post({ call: { ...call, id: "next" } })).status).toBe(403);
  expect(s.sendCommandToRuntime).toHaveBeenCalledTimes(11);
  finish.slice(1).reverse().forEach(f => f());
  expect((await Promise.all(pending)).every(r => r.status === 200)).toBe(true);
  expect((await s.post({ call: { ...call, id: "0" } })).status).toBe(403);
});
