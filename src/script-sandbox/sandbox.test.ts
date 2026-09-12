import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { loadScriptSandboxConfig } from "./config.js";
import { validateScriptRequest, resolveScriptLimits } from "./validation.js";
import { ScriptFrameParser, encodeScriptFrame } from "./protocol.js";
import { ScriptSandboxService, type ScriptBroker } from "./service.js";
import { ScriptSandboxPool } from "./pool.js";
import { ReadyScriptSandboxProvider } from "./ready-provider.js";
import type { ScriptChannel, ScriptSandboxProvider } from "./types.js";

const config = () => loadScriptSandboxConfig({ SICLAW_SCRIPT_SANDBOX_ENABLED: "true", SICLAW_SCRIPT_SANDBOX_IMAGE: "test@sha256:abc" });
const principal = () => ({ agentId: "agent", userId: "user", sessionId: "session", boxId: "box" });
const request = { language: "python", code: "print(1)" };
function channel(id = "instance"): ScriptChannel {
  let end!: (code: number) => void;
  return { instanceId: id, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    done: new Promise(resolve => { end = resolve; }), close: vi.fn(async () => { end(0); }) };
}
const emit = (c: ScriptChannel, frame: unknown) => (c.stdout as PassThrough).write(encodeScriptFrame(frame));
const broker = (): ScriptBroker => ({ authorize: vi.fn(async () => {}), call: vi.fn(async () => ({ ok: true })) });
afterEach(() => vi.restoreAllMocks());

describe("script contract", () => {
  it("defaults off, including optional network isolation", () => {
    const c = loadScriptSandboxConfig({});
    expect(c.enabled).toBe(false); expect(c.networkIsolation).toBe(false); expect(c.warmPoolSize).toBe(1);
    expect(resolveScriptLimits({ ...request, language: "python", network_isolation: false }, { ...c, requireNetworkIsolation: true }).isolated).toBe(true);
  });
  it.each(["credentials", "userId", "sessionId", "image", "url", "env", "kubeconfig"])("rejects authority injection: %s", key => {
    expect(() => validateScriptRequest({ ...request, [key]: "injected" })).toThrow();
  });
  it("rejects unsupported scope fields and duplicate resources", () => {
    expect(() => validateScriptRequest({ ...request, clusters: [{ name: "prod", namespaces: [] }] })).toThrow();
    expect(() => validateScriptRequest({ ...request, hosts: ["host", "host"] })).toThrow();
    expect(() => validateScriptRequest({ ...request, code: "a".repeat(131073) })).toThrow();
    expect(() => validateScriptRequest({ ...request, clusters: [{ name: "prod", namespaces: ["../secrets"] }] })).toThrow();
  });
  it("declares whole bound clusters and rejects legacy scopes rather than silently broadening them", () => {
    const scoped = { ...request, clusters: [{ name: "prod" }] };
    expect(validateScriptRequest(scoped)).toEqual(scoped);
    for (const cluster of [{ name: "prod", nodes: true }, { name: "prod", namespaces: ["team"] },
      { name: "prod", resources: ["pods"] }]) {
      expect(() => validateScriptRequest({ ...request, clusters: [cluster] })).toThrow();
    }
    expect(() => validateScriptRequest({ ...request, clusters: [{ name: "prod" }, { name: "prod" }] })).toThrow();
  });
  it("frames split UTF-8 and rejects oversized/incomplete protocol", () => {
    const parser = new ScriptFrameParser(); const raw = Buffer.from('{"text":"测试"}\n');
    expect(parser.push(raw.subarray(0, 11))).toEqual([]);
    expect(parser.push(raw.subarray(11))).toEqual([{ text: "测试" }]); parser.finish();
    expect(() => new ScriptFrameParser().push(Buffer.alloc(300000, 97))).toThrow();
    const partial = new ScriptFrameParser(); partial.push("{"); expect(() => partial.finish()).toThrow();
  });
});

describe("runner lifecycle", () => {
  it("sanitizes final script stdout and stderr with the shared document pipeline", async () => {
    const c = channel();
    c.stdin.on("data", () => {
      emit(c, { type: "stdout", data: Buffer.from('{"password":"private-input","count":3}').toString("base64") });
      emit(c, { type: "stderr", data: Buffer.from("-----BEGIN PRIVATE KEY-----\nprivate-body\n-----END PRIVATE KEY-----").toString("base64") });
      emit(c, { type: "exit", code: 0 });
    });
    const result = await new ScriptSandboxService(config(), { start: async () => c }, broker()).run(request, principal());
    expect(result.status).toBe("completed");
    expect(JSON.parse(result.stdout).count).toBe(3);
    expect(JSON.stringify(result)).not.toMatch(/private-input|private-body/);
    expect(result.notices?.length).toBeGreaterThan(0);
  });
  it.each([false, true])("a terminated idle instance is closed even if its channel rejects=%s", async rejects => {
    let done!: () => void;
    const c = channel();
    c.done = new Promise((resolve, reject) => { done = () => rejects ? reject(new Error("disconnected")) : resolve(null); });
    const pool = new ScriptSandboxPool({ start: async () => c }, config());
    await pool.waitForWarmup();
    done();
    await vi.waitFor(() => expect(c.close).toHaveBeenCalledOnce());
    await pool.shutdown();
    expect(c.close).toHaveBeenCalledOnce();
  });
  it("authorizes before starting and bounds stdout without corrupting UTF-8", async () => {
    const c = channel(); const b = broker();
    const start = vi.fn(async () => { expect(b.authorize).toHaveBeenCalledOnce(); return c; });
    c.stdin.on("data", () => {
      const raw = Buffer.from("测试");
      emit(c, { type: "stdout", data: raw.subarray(0, 2).toString("base64") });
      emit(c, { type: "stdout", data: raw.subarray(2).toString("base64") });
      emit(c, { type: "exit", code: 0 });
    });
    const result = await new ScriptSandboxService(config(), { start }, b).run(request, principal());
    expect(result.status).toBe("completed"); expect(result.stdout).toBe("测试"); expect(c.close).toHaveBeenCalledOnce();
  });
  it("keeps the private callback grant out of runner frames, results and audit", async () => {
    const c = channel(); const seen: string[] = [];
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    c.stdin.on("data", raw => { seen.push(String(raw)); emit(c, { type: "exit", code: 0 }); });
    const result = await new ScriptSandboxService(config(), { start: async () => c }, broker())
      .run(request, { ...principal(), callbackToken: "private-callback-grant" });
    expect(JSON.stringify({ seen, result, audit: log.mock.calls })).not.toContain("private-callback-grant");
    expect(JSON.parse(seen[0])).toEqual({ type: "start", language: "python", code: "print(1)", input: null });
  });
  it("never starts on failed authorization", async () => {
    const start = vi.fn(); const b = broker(); vi.mocked(b.authorize).mockRejectedValue(new Error("secret"));
    const result = await new ScriptSandboxService(config(), { start }, b).run(request, principal());
    expect(start).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("caps encoded output without splitting a multibyte codepoint", async () => {
    const c = channel();
    c.stdin.on("data", () => {
      emit(c, { type: "stdout", data: Buffer.from("测试").toString("base64") });
      emit(c, { type: "exit", code: 0 });
    });
    const result = await new ScriptSandboxService({ ...config(), maxOutputBytes: 4 }, { start: async () => c }, broker()).run(request, principal());
    expect(result.stdout).toBe("测"); expect(result.output_truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(4);
  });
  it("rechecks scope through the broker and does not expose connector errors", async () => {
    const c = channel(); const b = broker(); vi.mocked(b.call).mockRejectedValue(new Error("Bearer production-secret"));
    c.stdin.on("data", raw => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "start") emit(c, { type: "tool", call: { id: "one", tool: "ssh", arguments: { command: "rm" } } });
      else {
        expect(frame.response.error).toBe("Tool request denied or unavailable");
        expect(JSON.stringify(frame)).not.toContain("production-secret"); emit(c, { type: "exit", code: 0 });
      }
    });
    await new ScriptSandboxService(config(), { start: async () => c }, b).run(request, principal());
    expect(b.call).toHaveBeenCalledOnce();
  });
  it("rejects concurrent RPC floods and closes the instance", async () => {
    const c = channel(); const b = broker(); vi.mocked(b.call).mockImplementation(() => new Promise(() => {}));
    c.stdin.on("data", () => {
      for (let i = 0; i < 11; i++) emit(c, { type: "tool", call: { id: String(i), tool: "test", arguments: {} } });
    });
    const result = await new ScriptSandboxService(config(), { start: async () => c }, b).run(request, principal());
    expect(result.status).toBe("failed"); expect(b.call).toHaveBeenCalledTimes(10); expect(c.close).toHaveBeenCalledOnce();
  });
  it("cancels a running script and releases quota", async () => {
    const c = channel(); const controller = new AbortController();
    c.stdin.on("data", () => controller.abort());
    const result = await new ScriptSandboxService(config(), { start: async () => c }, broker()).run(request, principal(), controller.signal);
    expect(result.status).toBe("cancelled"); expect(c.close).toHaveBeenCalledOnce();
  });
  it("times out and truncates output", async () => {
    vi.useFakeTimers();
    try {
      const c = channel();
      c.stdin.on("data", () => emit(c, { type: "stdout", data: Buffer.alloc(200, 97).toString("base64") }));
      const promise = new ScriptSandboxService({ ...config(), maxOutputBytes: 10 }, { start: async () => c }, broker()).run({ ...request, timeout_seconds: 1 }, principal());
      await vi.advanceTimersByTimeAsync(1001);
      const result = await promise;
      expect(result.status).toBe("timed_out"); expect(result.stdout).toHaveLength(10); expect(result.output_truncated).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("requires a ready handshake before putting an instance in the warm pool", async () => {
    const c = channel(); let ready = false;
    c.stdin.on("data", raw => { expect(JSON.parse(String(raw))).toEqual({ type: "hello", version: 3 }); ready = true; emit(c, { type: "ready", version: 3 }); });
    await new ReadyScriptSandboxProvider({ start: async () => c }).start("r", true, 30, new AbortController().signal);
    expect(ready).toBe(true); await c.close();
  });
  it("rejects an old SDK before sending task data", async () => {
    const c = channel(); const received: unknown[] = [];
    c.stdin.on("data", raw => { received.push(JSON.parse(String(raw))); emit(c, { type: "ready", version: 1 }); });
    await expect(new ReadyScriptSandboxProvider({ start: async () => c }).start("r", true, 30, new AbortController().signal)).rejects.toThrow("handshake");
    expect(received).toEqual([{ type: "hello", version: 3 }]); expect(c.close).toHaveBeenCalledOnce();
  });
  it("uses fresh warm instances once, with separate isolation profiles", async () => {
    let id = 0; const channels: ScriptChannel[] = [];
    const provider: ScriptSandboxProvider = { start: vi.fn(async () => { const c = channel(String(++id)); channels.push(c); return c; }) };
    const pool = new ScriptSandboxPool(provider, config()); pool.prewarm();
    await vi.waitFor(() => expect(channels.length).toBe(1));
    const signal = new AbortController().signal;
    const first = await pool.start("a", false, 30, signal); expect(first.warm).toBe(true);
    await first.close();
    const second = await pool.start("b", false, 30, signal); expect(second.instanceId).not.toBe(first.instanceId);
    const isolated = await pool.start("c", true, 30, signal); expect(isolated.instanceId).not.toBe(second.instanceId);
    await second.close(); await isolated.close(); await pool.shutdown();
    expect(channels.every(c => vi.mocked(c.close).mock.calls.length === 1)).toBe(true);
  });
  it("gives a cold run capacity before provisioning a speculative replacement", async () => {
    let ready!: (c: ScriptChannel) => void;
    const start = vi.fn().mockImplementationOnce(() => new Promise<ScriptChannel>(resolve => { ready = resolve; }))
      .mockImplementation(async () => channel("replacement"));
    const pool = new ScriptSandboxPool({ start }, config());
    const running = pool.start("foreground", true, 30, new AbortController().signal);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0][0]).toBe("foreground");
    const c = channel("foreground"); ready(c);
    expect(await running).toBe(c);
    await c.close(); await pool.shutdown();
  });
  it("keeps the configured warm profile across occasional requests for another profile", async () => {
    const standard = channel("standard");
    const start = vi.fn(async (_id: string, isolated: boolean) => {
      if (isolated) expect(standard.close).not.toHaveBeenCalled();
      return isolated ? channel("isolated") : standard;
    });
    const pool = new ScriptSandboxPool({ start }, config()); await pool.waitForWarmup();
    const isolated = await pool.start("foreground", true, 30, new AbortController().signal);
    expect(isolated.instanceId).toBe("isolated");
    expect((await pool.start("standard", false, 30, new AbortController().signal)).instanceId).toBe("standard");
    await standard.close();
    await isolated.close(); await pool.shutdown();
  });
  it("joins in-flight prewarming without a competing Pod or misleading warm timing", async () => {
    let ready!: (c: ScriptChannel) => void;
    const start = vi.fn().mockImplementationOnce(() => new Promise<ScriptChannel>(resolve => { ready = resolve; }))
      .mockImplementation(async () => channel("replacement"));
    const pool = new ScriptSandboxPool({ start }, config()); pool.prewarm();
    const running = pool.start("foreground", false, 30, new AbortController().signal);
    expect(start).toHaveBeenCalledOnce();
    ready(channel("warming"));
    const c = await running;
    expect(c.instanceId).toBe("warming"); expect(c.warm).toBe(false);
    await c.close(); await pool.shutdown();
  });
  it("cancels waiting for shared prewarming without starting a second Pod", async () => {
    let ready!: (c: ScriptChannel) => void;
    const start = vi.fn(() => new Promise<ScriptChannel>(resolve => { ready = resolve; }));
    const pool = new ScriptSandboxPool({ start }, config()); pool.prewarm();
    const controller = new AbortController();
    const running = pool.start("foreground", false, 30, controller.signal); controller.abort();
    await expect(running).rejects.toThrow("cancelled"); expect(start).toHaveBeenCalledOnce();
    ready(channel("warming")); await pool.shutdown();
  });
});

it("admits ten runs, each with ten tools, routes out-of-order replies and cleans up on cancel", async () => {
  const channels = Array.from({ length: 10 }, (_, i) => channel(String(i)));
  const completions: Array<() => void> = [];
  const b = broker();
  vi.mocked(b.call).mockImplementation(async (_, __, call, signal) => new Promise(resolve => {
    const finish = () => resolve({ identity: call.id });
    completions.push(finish); signal.addEventListener("abort", finish, { once: true });
  }));
  const replies: string[][] = channels.map(() => []);
  channels.forEach((c, i) => c.stdin.on("data", raw => {
    const f = JSON.parse(String(raw));
    if (f.type === "start") {
      for (let j = 0; j < 10; j++) emit(c, { type: "tool", call: { id: `${i}-${j}`, tool: "bash", arguments: {} } });
    } else {
      expect(f.response.result.identity).toBe(f.response.id);
      replies[i].push(f.response.id);
      if (replies[i].length === 10) emit(c, { type: "exit", code: 0 });
    }
  }));
  let next = 0;
  const service = new ScriptSandboxService(config(), { start: async () => channels[next++] }, b);
  const controllers = channels.map(() => new AbortController());
  const runs = channels.map((_, i) => service.run(request, principal(), controllers[i].signal));
  await vi.waitFor(() => expect(b.call).toHaveBeenCalledTimes(100));
  await expect(service.run(request, principal())).rejects.toThrow("busy");
  controllers[0].abort();
  expect((await runs[0]).status).toBe("cancelled");
  completions.slice(10).reverse().forEach(f => f());
  const results = await Promise.all(runs.slice(1));
  expect(results.every(r => r.status === "completed" && r.tool_calls === 10)).toBe(true);
  expect(replies[0]).toEqual([]);
  expect(replies[9][0]).toBe("9-9");
  channels.forEach(c => expect(c.close).toHaveBeenCalledOnce());
  await service.shutdown();
});
