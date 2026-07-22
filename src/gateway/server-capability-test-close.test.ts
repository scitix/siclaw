import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./chat-repo.js", () => ({
  ensureChatSession: vi.fn(async () => {}),
  appendMessage: vi.fn(async () => "msg-id"),
  bindMessageTraceId: vi.fn(async () => {}),
  updateMessage: vi.fn(async () => {}),
  incrementMessageCount: vi.fn(async () => {}),
}));
vi.mock("./output-redactor.js", () => ({ buildRedactionConfigForModelConfig: vi.fn(() => ({})) }));
vi.mock("./sse-consumer.js", () => ({
  consumeAgentSse: vi.fn(async () => ({ resultText: "", taskReportText: "", errorMessage: "", eventCount: 0, durationMs: 0 })),
}));
vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    endpoint: string;
    constructor(endpoint: string) { this.endpoint = endpoint; }
    postJson = postJsonMock;
    async getJson() { return {}; }
    async *streamPath() {}
  },
}));
vi.mock("./capability/materialize.js", () => ({
  materializeCapabilityInputs: vi.fn(async () => ({ locale: undefined, llm: undefined, settings: undefined })),
}));

const { startRuntime } = await import("./server.js");

function fakeFrontendClient() {
  return {
    request: vi.fn(async () => ({})),
    onCommand: vi.fn(),
    emitEvent: vi.fn(),
    close: vi.fn(),
  } as any;
}

function fakeAgentBoxManager(box: { boxId: string; endpoint: string; agentId: string } | null) {
  return {
    setCertManager: vi.fn(),
    setSpawnEnvResolver: vi.fn(),
    setPersistenceResolver: vi.fn(),
    getAsync: vi.fn(async () => box),
    getOrCreate: vi.fn(async () => box),
    stop: vi.fn(async () => {}),
    list: vi.fn(() => []),
    cleanup: vi.fn(async () => {}),
  } as any;
}

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;

beforeEach(() => {
  postJsonMock.mockReset().mockResolvedValue({ ok: true });
});

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  vi.clearAllMocks();
});

describe("capability.testClose", () => {
  it("closes an existing box session even when the Runtime has no in-memory run", async () => {
    const manager = fakeAgentBoxManager({
      boxId: "agentbox-run-lost",
      endpoint: "https://10.0.0.9:3000",
      agentId: "run-lost",
    });
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: fakeFrontendClient(),
      credentialService: {} as any,
    });

    const close = server.rpcMethods.get("capability.testClose")!;
    await expect(close({ run_id: "run-lost", test_session_id: "test-1" })).resolves.toMatchObject({
      ok: true,
      close_confirmed: true,
      run_id: "run-lost",
      test_session_id: "test-1",
    });
    expect(manager.getAsync).toHaveBeenCalledWith("run-lost");
    expect(postJsonMock).toHaveBeenCalledWith("/test-session/test-1/close", {});
    expect(manager.getOrCreate).not.toHaveBeenCalled();
  });

  it("confirms closure without an RPC only after box discovery proves the pod is absent", async () => {
    const manager = fakeAgentBoxManager(null);
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: fakeFrontendClient(),
      credentialService: {} as any,
    });

    const close = server.rpcMethods.get("capability.testClose")!;
    await expect(close({ run_id: "run-gone", test_session_id: "test-2" })).resolves.toMatchObject({
      ok: true,
      already_closed: true,
      close_confirmed: true,
    });
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("does not claim confirmation when the box close RPC is uncertain", async () => {
    const manager = fakeAgentBoxManager({
      boxId: "agentbox-run-live",
      endpoint: "https://10.0.0.10:3000",
      agentId: "run-live",
    });
    postJsonMock.mockRejectedValueOnce(new Error("box close timed out"));
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: fakeFrontendClient(),
      credentialService: {} as any,
    });

    const close = server.rpcMethods.get("capability.testClose")!;
    await expect(close({ run_id: "run-live", test_session_id: "test-3" })).rejects.toThrow("box close timed out");
  });
});
