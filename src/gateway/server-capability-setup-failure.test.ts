/**
 * Capability session setup boundaries: clean up a newly-created box on failure,
 * preserve a reused/adopted live box, count typed materialization stages, and
 * deliver Runtime's standalone Helm LLM fallback through /session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const materializeMock = vi.hoisted(() => vi.fn());
const postJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./chat-repo.js", () => ({
  ensureChatSession: vi.fn(async () => {}),
  appendMessage: vi.fn(async () => "msg-id"),
  bindMessageTraceId: vi.fn(async () => {}),
  incrementMessageCount: vi.fn(async () => {}),
}));

vi.mock("./output-redactor.js", () => ({
  buildRedactionConfigForModelConfig: vi.fn(() => ({})),
}));

vi.mock("./sse-consumer.js", () => ({
  consumeAgentSse: vi.fn(async () => ({ resultText: "", taskReportText: "", errorMessage: "", eventCount: 0, durationMs: 0 })),
}));

// Session setup fails at the box boundary: POST /session/<runId> throws.
vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    endpoint: string;
    constructor(endpoint: string) { this.endpoint = endpoint; }
    postJson = postJsonMock;
    getJson = vi.fn(async () => ({}));
    streamEvents = async function* () {};
    streamPath = async function* () {};
  },
}));

vi.mock("./capability/materialize.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./capability/materialize.js")>()),
  materializeCapabilityInputs: materializeMock,
}));

const { startRuntime } = await import("./server.js");
const { CapabilityMaterializationError } = await import("./capability/materialize.js");
const { federationSelfRegistry } = await import("./federation-self-metrics.js");

function fakeFrontendClient() {
  return { request: vi.fn(async () => ({})), onCommand: vi.fn(), emitEvent: vi.fn(), close: vi.fn() } as any;
}

function fakeAgentBoxManager(created = true) {
  const manager = {
    setCertManager: vi.fn(),
    setSpawnEnvResolver: vi.fn(),
    setPersistenceResolver: vi.fn(),
    getAsync: vi.fn(async () => null),
    getOrCreate: vi.fn(async () => ({ boxId: "agentbox-x", endpoint: "https://10.0.0.9:3000", agentId: "x" })),
    stop: vi.fn(async () => {}),
    list: vi.fn(() => []),
    cleanup: vi.fn(async () => {}),
  } as any;
  manager.getOrCreateWithDisposition = vi.fn(async (...args: any[]) => ({
    handle: await manager.getOrCreate(...args),
    created,
  }));
  return manager;
}

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;
beforeEach(() => {
  federationSelfRegistry.resetMetrics();
  materializeMock.mockReset();
  postJsonMock.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  federationSelfRegistry.resetMetrics();
  vi.clearAllMocks();
});

describe("startRuntime — capability session setup", () => {
  it("stops the just-spawned box when session setup fails (no leak until the sweep)", async () => {
    materializeMock.mockResolvedValueOnce({ locale: undefined, llm: undefined, settings: undefined });
    postJsonMock.mockRejectedValueOnce(new Error("box unreachable during setup"));
    const manager = fakeAgentBoxManager();
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: fakeFrontendClient(),
      credentialService: {} as any,
    });
    const start = server.rpcMethods.get("capability.start")!;
    await expect(start({ profile: "kb-compile", input: { instruction: "go" } })).rejects.toThrow(/box unreachable/);
    // The pod WAS spawned…
    expect(manager.getOrCreate).toHaveBeenCalledTimes(1);
    // …and the setup-failure path stopped it with the SAME runId it spawned under.
    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(manager.stop.mock.calls[0][0]).toBe(manager.getOrCreate.mock.calls[0][0]);
    expect(await federationSelfRegistry.metrics()).not.toContain(
      "siclaw_gateway_capability_materialization_failures_total{stage=",
    );
  });

  it("stops the just-spawned box when fail-closed materialization rejects", async () => {
    materializeMock.mockRejectedValueOnce(
      new CapabilityMaterializationError("workspace-fetch", new Error("store unavailable")),
    );
    const manager = fakeAgentBoxManager();
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: fakeFrontendClient(),
      credentialService: {} as any,
    });

    const start = server.rpcMethods.get("capability.start")!;
    await expect(start({ profile: "kb-compile", input: { instruction: "go" } })).rejects.toThrow(/workspace-fetch/);
    expect(manager.getOrCreate).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(manager.stop.mock.calls[0][0]).toBe(manager.getOrCreate.mock.calls[0][0]);
    expect(await federationSelfRegistry.metrics()).toContain(
      'siclaw_gateway_capability_materialization_failures_total{stage="workspace-fetch"} 1',
    );
  });

  it("preserves a reused live box when reattachment materialization fails", async () => {
    materializeMock.mockRejectedValueOnce(
      new CapabilityMaterializationError("source-fetch", new Error("consumer reconnecting")),
    );
    const manager = fakeAgentBoxManager(false);
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: fakeFrontendClient(),
      credentialService: {} as any,
    });

    const start = server.rpcMethods.get("capability.start")!;
    await expect(start({ profile: "kb-compile", input: { instruction: "go" } })).rejects.toThrow(/source-fetch/);
    expect(manager.getOrCreateWithDisposition).toHaveBeenCalledTimes(1);
    expect(manager.stop).not.toHaveBeenCalled();
    expect(await federationSelfRegistry.metrics()).toContain(
      'siclaw_gateway_capability_materialization_failures_total{stage="source-fetch"} 1',
    );
  });

  it("delivers the Runtime Helm LLM fallback through /session without mixing credential modes", async () => {
    materializeMock.mockResolvedValueOnce({ locale: "en", llm: undefined, settings: undefined });
    const previous = {
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      authToken: process.env.ANTHROPIC_AUTH_TOKEN,
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL,
    };
    process.env.ANTHROPIC_BASE_URL = "https://runtime.example/v1";
    process.env.ANTHROPIC_AUTH_TOKEN = "runtime-secret";
    process.env.ANTHROPIC_API_KEY = "lower-precedence-key";
    process.env.ANTHROPIC_MODEL = "runtime-model";
    try {
      const manager = fakeAgentBoxManager(true);
      server = await startRuntime({
        config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
        agentBoxManager: manager,
        frontendClient: fakeFrontendClient(),
        credentialService: {} as any,
      });

      const start = server.rpcMethods.get("capability.start")!;
      await expect(start({ profile: "kb-compile", input: { instruction: "go" } })).resolves.toHaveProperty("run_id");
      const sessionPost = postJsonMock.mock.calls.find(([path]) => String(path).startsWith("/session/"));
      expect(sessionPost?.[1]).toMatchObject({
        locale: "en",
        llm: {
          base_url: "https://runtime.example/v1",
          auth_token: "runtime-secret",
          model: "runtime-model",
        },
      });
      expect(sessionPost?.[1].llm.api_key).toBeUndefined();
    } finally {
      for (const [name, value] of Object.entries({
        ANTHROPIC_BASE_URL: previous.baseUrl,
        ANTHROPIC_AUTH_TOKEN: previous.authToken,
        ANTHROPIC_API_KEY: previous.apiKey,
        ANTHROPIC_MODEL: previous.model,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
