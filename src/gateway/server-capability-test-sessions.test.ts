import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getJsonMock = vi.hoisted(() => vi.fn());

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
    async postJson() { return {}; }
    getJson = getJsonMock;
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
  getJsonMock.mockReset();
});

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  vi.clearAllMocks();
});

describe("capability.testSessions", () => {
  it("lists the box's sessions verbatim (tid field preserved) without spawning a box", async () => {
    const rows = [
      {
        tid: "test-1",
        parent_run_id: "run-live",
        created_at: "2026-07-22T09:30:00Z",
        last_activity_at: "2026-07-22T09:31:00Z",
        done: false,
      },
    ];
    getJsonMock.mockResolvedValue({ sessions: rows });
    const manager = fakeAgentBoxManager({
      boxId: "agentbox-run-live",
      endpoint: "https://10.0.0.10:3000",
      agentId: "run-live",
    });
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: fakeFrontendClient(),
      credentialService: {} as any,
    });

    const list = server.rpcMethods.get("capability.testSessions")!;
    await expect(list({ run_id: "run-live" })).resolves.toEqual({
      run_id: "run-live",
      sessions: rows, // passed through byte-for-byte: `tid`, not renamed
    });
    expect(manager.getAsync).toHaveBeenCalledWith("run-live");
    expect(getJsonMock).toHaveBeenCalledWith("/test-sessions");
    expect(manager.getOrCreate).not.toHaveBeenCalled(); // never spawn to list
  });

  it("scopes the list to the requested run — a shared box's other runs stay invisible", async () => {
    // A shared box (SICLAW_COMPILE_BOX_ENDPOINT) hosts sessions for many runs;
    // the box returns them all, and the runtime must filter to the caller's run
    // so one run can never see (or reap) another's session.
    process.env.SICLAW_COMPILE_BOX_ENDPOINT = "https://10.0.0.20:3000";
    const iso = "2026-07-22T09:30:00Z";
    getJsonMock.mockResolvedValue({
      sessions: [
        { tid: "a-1", parent_run_id: "run-A", created_at: iso, last_activity_at: iso, done: false },
        { tid: "b-1", parent_run_id: "run-B", created_at: iso, last_activity_at: iso, done: false },
        { tid: "a-2", parent_run_id: "run-A", created_at: iso, last_activity_at: iso, done: true },
      ],
    });
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: fakeAgentBoxManager(null),
      frontendClient: fakeFrontendClient(),
      credentialService: {} as any,
    });
    try {
      const list = server.rpcMethods.get("capability.testSessions")!;
      const a = (await list({ run_id: "run-A" })) as any;
      expect(a.sessions.map((s: any) => s.tid)).toEqual(["a-1", "a-2"]); // only run-A's
      const b = (await list({ run_id: "run-B" })) as any;
      expect(b.sessions.map((s: any) => s.tid)).toEqual(["b-1"]); // run-A's stay invisible
    } finally {
      delete process.env.SICLAW_COMPILE_BOX_ENDPOINT;
    }
  });

  it("returns an empty list when the box is absent — never spawns/rehydrates", async () => {
    const manager = fakeAgentBoxManager(null);
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: fakeFrontendClient(),
      credentialService: {} as any,
    });

    const list = server.rpcMethods.get("capability.testSessions")!;
    await expect(list({ run_id: "run-gone" })).resolves.toEqual({ run_id: "run-gone", sessions: [] });
    expect(getJsonMock).not.toHaveBeenCalled();
    expect(manager.getOrCreate).not.toHaveBeenCalled();
  });

  it("requires run_id", async () => {
    const manager = fakeAgentBoxManager(null);
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: fakeFrontendClient(),
      credentialService: {} as any,
    });

    const list = server.rpcMethods.get("capability.testSessions")!;
    await expect(list({} as any)).rejects.toThrow("run_id is required");
  });
});
