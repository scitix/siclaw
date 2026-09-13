import { afterEach, describe, expect, it, vi } from "vitest";
import { E2bClient } from "./e2b-client.js";
import { E2bScriptSandboxProvider } from "./e2b-provider.js";
import { ExternalScriptTools } from "./external-tools.js";
import { ReadyScriptSandboxProvider } from "../../script-sandbox/ready-provider.js";
import { ScriptSandboxService } from "../../script-sandbox/service.js";
import { loadScriptSandboxConfig } from "../../script-sandbox/config.js";
import { SANDBOX_LEASE_OPEN, SANDBOX_TOOL_PATH } from "../../script-sandbox/external-protocol.js";

const env = { SICLAW_SCRIPT_SANDBOX_ENABLED: "true", SICLAW_SCRIPT_SANDBOX_PROVIDER: "e2b", E2B_API_KEY: "service-key-fixture", SICLAW_SCRIPT_SANDBOX_E2B_TEMPLATE: "siclaw-runner-v1" };
const config = () => loadScriptSandboxConfig(env);
const principal = { agentId: "agent-1", sessionId: "session-1", userId: "user-1", boxId: "box-1", callbackToken: "agentbox-grant-fixture" };
const envelope = (value: unknown, flags = 0) => { const data = Buffer.from(JSON.stringify(value)); const h = Buffer.alloc(5); h[0] = flags; h.writeUInt32BE(data.length, 1); return Buffer.concat([h, data]); };
afterEach(() => vi.restoreAllMocks());

describe("E2B service integration", () => {
  it("requires service configuration without requiring a Pod image", () => {
    expect(config()).toMatchObject({ enabled: true, provider: "e2b", networkIsolation: false, image: "" });
    for (const override of [{ E2B_API_KEY: "" }, { SICLAW_SCRIPT_SANDBOX_E2B_TEMPLATE: "" }, { SICLAW_SCRIPT_SANDBOX_E2B_API_URL: "http://api.e2b.app" }]) {
      expect(() => loadScriptSandboxConfig({ ...env, ...override })).toThrow();
    }
    expect(loadScriptSandboxConfig({ SICLAW_SCRIPT_SANDBOX_PROVIDER: "e2b" }).enabled).toBe(false);
  });
  it("keeps API keys in the service and run grants in relay stdin, preserving the shared broker", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    let runId = "";
    const cp = { request: vi.fn(async (method, params) => { if (method === SANDBOX_LEASE_OPEN) runId = params.run_id; return { endpoint: "https://portal.example" + SANDBOX_TOOL_PATH }; }) };
    const tools = new ExternalScriptTools(cp);
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { output = c; } });
    const frames: any[] = [], requests: Array<{ url: string; init: RequestInit }> = [];
    const emit = (frame: unknown) => output.enqueue(envelope({ event: { data: { stdout: Buffer.from(JSON.stringify(frame) + "\n").toString("base64") } } }));
    let token = "";
    const http = vi.fn(async (url, init) => {
      requests.push({ url: String(url), init: init! });
      if (String(url).endsWith("/sandboxes") && init?.method === "POST") return Response.json({ sandboxID: "instance-1", envdAccessToken: "envd-fixture", domain: "e2b.app" });
      if (String(url).endsWith("/Start")) {
        output.enqueue(envelope({ event: { start: { pid: 123 } } }));
        return new Response(stream, { headers: { "Content-Type": "application/connect+json" } });
      }
      if (String(url).endsWith("/SendInput")) {
        const body = JSON.parse(init!.body as string);
        expect(body.process).toEqual({ pid: 123 });
        const frame = JSON.parse(Buffer.from(body.input.stdin, "base64").toString()); frames.push(frame);
        if (frame.type === "hello") emit({ type: "ready", version: 3 });
        else {
          token = frame.token;
          const call = { id: "tool-1", tool: "bash", arguments: { cluster: "test", command: "kubectl get nodes -o json" } };
          const response = await tools.call({ run_id: runId, token, call });
          emit({ type: "stdout", data: Buffer.from(JSON.stringify(response)).toString("base64") });
          emit({ type: "exit", code: 0 });
          output.enqueue(envelope({ event: { end: { exitCode: 0 } } }));
          output.enqueue(envelope({}, 2)); output.close();
        }
        return Response.json({});
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error("Unexpected E2B API");
    }) as unknown as typeof fetch;
    const c = config();
    const provider = new ReadyScriptSandboxProvider(new E2bScriptSandboxProvider(c, tools, new E2bClient(c.e2b!, http)));
    const broker = { authorize: vi.fn(async () => {}), call: vi.fn(async () => ({ nodes: [{ name: "node-1" }] })) };
    const result = await new ScriptSandboxService(c, provider, broker).run({ language: "python", code: "from siclaw import call", network_isolation: true, clusters: [{ name: "test" }] }, principal);
    expect(result.status).toBe("completed"); expect(result.tool_calls).toBe(1); expect(result.stdout).toContain("node-1");
    expect(broker.call.mock.calls[0][1]).toMatchObject({ clusters: [{ name: "test" }] });
    const create = JSON.parse(requests[0].init.body as string);
    expect(create).toMatchObject({ secure: true, network: { allowPublicTraffic: false }, templateID: "siclaw-runner-v1" });
    expect(create.envVars).toBeUndefined(); expect(create.mcp).toBeUndefined();
    const start = requests.find(r => r.url.endsWith("/Start"))!;
    const command = JSON.parse(Buffer.from(start.init.body as Buffer).subarray(5).toString());
    expect(command.process.args).toContain("isolated");
    expect(JSON.stringify(command)).not.toContain(token);
    for (const r of requests.filter(r => r.url.includes("49983-"))) {
      expect(JSON.stringify(r.init.headers)).not.toContain(env.E2B_API_KEY);
      expect(r.init.redirect).toBe("error");
    }
    expect(JSON.stringify(frames)).not.toContain(env.E2B_API_KEY);
    expect(JSON.stringify(frames)).not.toContain(principal.callbackToken);
    expect(frames[1].start).toEqual({ type: "start", language: "python", code: "from siclaw import call", input: null });
    expect(JSON.stringify({ result, logs: log.mock.calls })).not.toContain(token);
    await expect(tools.call({ run_id: runId, token, call: {} })).rejects.toThrow();
    expect(requests.filter(r => r.init.method === "DELETE")).toHaveLength(1);
  });
  it.each([{ sandboxID: "id-1" }, { sandboxID: "id-1", envdAccessToken: "envd", domain: "attacker.example" }])("fails closed and destroys insecure/unexpected instances", async response => {
    const http = vi.fn(async (_url, init) => init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(response));
    await expect(new E2bClient(config().e2b!, http as typeof fetch).create(60, new AbortController().signal)).rejects.toThrow();
    expect(http.mock.calls.some(c => c[1]?.method === "DELETE")).toBe(true);
  });
  it("prewarms without a task grant, binds on claim, and destroys/revokes on cancellation", async () => {
    const cp = { request: vi.fn(async () => ({ endpoint: "https://portal.example" + SANDBOX_TOOL_PATH })) };
    const tools = new ExternalScriptTools(cp), c = config();
    let hello!: () => void, stop!: () => void, configured!: () => void;
    const helloReceived = new Promise<void>(r => { hello = r; });
    const stopped = new Promise<void>(r => { stop = r; });
    const configuredPromise = new Promise<void>(r => { configured = r; });
    let runToken = "";
    const client = {
      create: vi.fn(async () => ({ id: "warm-instance", url: "https://envd.example", accessToken: "envd-token" })),
      kill: vi.fn(async () => {}),
      input: vi.fn(async (_instance, _pid, text) => { const f = JSON.parse(text); if (f.type === "hello") hello(); else { runToken = f.token; configured(); } }),
      async *start(_instance, _isolated, _lifetime, signal: AbortSignal) {
        signal.addEventListener("abort", stop, { once: true });
        yield { start: { pid: 123 } };
        await helloReceived;
        yield { data: { stdout: Buffer.from('{"type":"ready","version":3}\n').toString("base64") } };
        await stopped;
      },
    };
    const provider = new ReadyScriptSandboxProvider(new E2bScriptSandboxProvider(c, tools, client as unknown as E2bClient));
    const warm = await provider.start("warm-preallocated-id", true, 300, new AbortController().signal);
    expect(cp.request).not.toHaveBeenCalled();
    const broker = { authorize: vi.fn(async () => {}), call: vi.fn(async () => ({})) };
    const service = new ScriptSandboxService(c, { start: async () => ({ ...warm, warm: true }) }, broker);
    const controller = new AbortController();
    const pending = service.run({ language: "python", code: "while True: pass", network_isolation: true }, principal, controller.signal);
    await configuredPromise; controller.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled"); expect(result.warm).toBe(true);
    expect(client.kill).toHaveBeenCalledExactlyOnceWith("warm-instance");
    expect(client.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(cp.request.mock.calls)).not.toContain("warm-preallocated-id");
    await expect(tools.call({ run_id: result.run_id, token: runToken, call: {} })).rejects.toThrow();
  });
  it("parses fragmented Connect streams and rejects truncation/compression/oversize", async () => {
    const instance = { id: "id-1", url: "https://49983-id-1.e2b.app", accessToken: "token" };
    for (const bad of [envelope({ event: { start: { pid: 1 } } }), envelope({}, 1), Buffer.from([0, 0, 32, 0, 0])]) {
      const client = new E2bClient(config().e2b!, vi.fn(async () => new Response(bad, { headers: { "Content-Type": "application/connect+json" } })));
      await expect((async () => { for await (const _ of client.start(instance, true, 60, new AbortController().signal)) {} })()).rejects.toThrow();
    }
    const payload = Buffer.concat([envelope({ event: { start: { pid: 42 } } }), envelope({}, 2)]);
    const body = new ReadableStream({ start(c) { for (const byte of payload) c.enqueue(new Uint8Array([byte])); c.close(); } });
    const client = new E2bClient(config().e2b!, vi.fn(async () => new Response(body, { headers: { "Content-Type": "application/connect+json" } })));
    const events = []; for await (const event of client.start(instance, true, 60, new AbortController().signal)) events.push(event);
    expect(events).toEqual([{ start: { pid: 42 } }]);
  });
});
