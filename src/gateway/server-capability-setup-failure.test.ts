/**
 * capability.start — a pod spawned but whose session SETUP fails (materialize /
 * POST /session throwing) must be stopped right there (review): the relay's
 * finally — the normal stop owner — never attaches on that path, so without
 * the setup-failure stop the pod + cert Secret leak until the orphan sweep.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const materializeMock = vi.hoisted(() => vi.fn());

vi.mock("./chat-repo.js", () => ({
  ensureChatSession: vi.fn(async () => {}),
  appendMessage: vi.fn(async () => "msg-id"),
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
    postJson = vi.fn(async () => { throw new Error("box unreachable during setup"); });
    getJson = vi.fn(async () => ({}));
    streamEvents = async function* () {};
  },
}));

vi.mock("./capability/materialize.js", () => ({
  materializeCapabilityInputs: materializeMock,
}));

const { startRuntime } = await import("./server.js");

function fakeFrontendClient() {
  return { request: vi.fn(async () => ({})), onCommand: vi.fn(), emitEvent: vi.fn(), close: vi.fn() } as any;
}

function fakeAgentBoxManager() {
  return {
    setCertManager: vi.fn(),
    setSpawnEnvResolver: vi.fn(),
    setPersistenceResolver: vi.fn(),
    getAsync: vi.fn(async () => null),
    getOrCreate: vi.fn(async () => ({ boxId: "agentbox-x", endpoint: "https://10.0.0.9:3000", agentId: "x" })),
    stop: vi.fn(async () => {}),
    list: vi.fn(() => []),
    cleanup: vi.fn(async () => {}),
  } as any;
}

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;
afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  vi.clearAllMocks();
});

describe("startRuntime — capability.start setup failure", () => {
  it("stops the just-spawned box when session setup fails (no leak until the sweep)", async () => {
    materializeMock.mockResolvedValueOnce({ locale: undefined, llm: undefined, settings: undefined });
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
  });

  it("stops the just-spawned box when fail-closed materialization rejects", async () => {
    materializeMock.mockRejectedValueOnce(new Error("capability input materialization failed at workspace-fetch"));
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
  });
});
