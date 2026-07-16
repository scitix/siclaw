import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const box = vi.hoisted(() => ({
  posts: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./chat-repo.js", () => ({
  ensureChatSession: vi.fn(async () => {}),
  appendMessage: vi.fn(async () => "msg-id"),
  incrementMessageCount: vi.fn(async () => {}),
}));
vi.mock("./output-redactor.js", () => ({ buildRedactionConfigForModelConfig: vi.fn(() => ({})) }));
vi.mock("./sse-consumer.js", () => ({
  consumeAgentSse: vi.fn(async () => ({ resultText: "", taskReportText: "", errorMessage: "", eventCount: 0, durationMs: 0 })),
}));
vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    postJson = box.posts;
    async getJson() { return {}; }
    async *streamPath() { await new Promise(() => {}); }
  },
}));
vi.mock("./capability/materialize.js", () => ({
  materializeCapabilityInputs: vi.fn(async () => ({ locale: undefined, llm: undefined, settings: undefined })),
}));

const { startRuntime } = await import("./server.js");

function fakeFrontendClient(options: {
  rows?: Array<Record<string, unknown>>;
  listActive?: boolean;
} = {}) {
  const rows = new Map(
    (options.rows ?? []).map((row) => [String(row.id), { ...row }]),
  );
  const request = vi.fn(async (method: string, params: any) => {
    if (method === "capability.persistRunState") {
      rows.set(params.run_id, { id: params.run_id, ...params });
      return { ok: true };
    }
    if (method === "capability.getRun") return rows.get(params.run_id) ?? null;
    if (method === "capability.listActiveRuns") {
      if (options.listActive === false) return { runs: [] };
      return {
        runs: [...rows.values()].filter((row) => row.status !== "done" && row.status !== "failed"),
      };
    }
    return { ok: true };
  });
  return {
    request,
    rows,
    onCommand: vi.fn(),
    emitEvent: vi.fn(),
    close: vi.fn(),
  } as any;
}

function fakeAgentBoxManager(stop = vi.fn(async () => {})) {
  return {
    setCertManager: vi.fn(),
    setSpawnEnvResolver: vi.fn(),
    setPersistenceResolver: vi.fn(),
    getAsync: vi.fn(async () => null),
    getOrCreate: vi.fn(async (runId: string) => ({
      boxId: `agentbox-${runId}`,
      endpoint: "https://10.0.0.9:3000",
      agentId: runId,
    })),
    stop,
    list: vi.fn(() => []),
    cleanup: vi.fn(async () => {}),
  } as any;
}

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;

beforeEach(() => {
  box.posts.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  vi.restoreAllMocks();
});

describe("capability.cancel", () => {
  it("terminalizes the run before stopping its box and rejects later messages", async () => {
    let releaseStop!: () => void;
    let markStopStarted!: () => void;
    const stopStarted = new Promise<void>((resolve) => { markStopStarted = resolve; });
    const stopReleased = new Promise<void>((resolve) => { releaseStop = resolve; });
    const stop = vi.fn(async () => {
      markStopStarted();
      await stopReleased;
    });
    const frontend = fakeFrontendClient();
    const manager = fakeAgentBoxManager(stop);
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: frontend,
      credentialService: {} as any,
    });
    const start = server.rpcMethods.get("capability.start")!;
    const cancel = server.rpcMethods.get("capability.cancel")!;
    const message = server.rpcMethods.get("capability.message")!;
    const started = await start({ profile: "kb-compile" }) as { run_id: string };

    const cancelling = cancel({ run_id: `  ${started.run_id}  ` });
    await stopStarted;

    const terminalPersistIndex = frontend.request.mock.calls.findIndex(
      ([method, params]: any[]) => method === "capability.persistRunState" && params.status === "done",
    );
    expect(terminalPersistIndex).toBeGreaterThanOrEqual(0);
    expect(frontend.request.mock.invocationCallOrder[terminalPersistIndex]).toBeLessThan(
      stop.mock.invocationCallOrder[0]!,
    );
    await expect(message({ run_id: started.run_id, message: "compile again" })).rejects.toThrow(
      `unknown capability run: ${started.run_id}`,
    );

    releaseStop();
    await expect(cancelling).resolves.toEqual({
      ok: true,
      run_id: started.run_id,
      stop_confirmed: true,
    });
    expect(stop).toHaveBeenCalledWith(started.run_id);
  });

  it("surfaces uncertain cleanup and lets an idempotent retry confirm the stop", async () => {
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error("pod deletion timed out"))
      .mockResolvedValueOnce(undefined);
    const frontend = fakeFrontendClient();
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: fakeAgentBoxManager(stop),
      frontendClient: frontend,
      credentialService: {} as any,
    });
    const start = server.rpcMethods.get("capability.start")!;
    const cancel = server.rpcMethods.get("capability.cancel")!;
    const started = await start({ profile: "kb-compile" }) as { run_id: string };

    await expect(cancel({ run_id: started.run_id })).rejects.toThrow("pod deletion timed out");
    expect(frontend.rows.get(started.run_id)).toMatchObject({ status: "done" });
    await expect(cancel({ run_id: started.run_id })).resolves.toMatchObject({
      ok: true,
      stop_confirmed: true,
    });
    expect(stop).toHaveBeenCalledTimes(2);
    const terminalPersists = frontend.request.mock.calls.filter(
      ([method, params]: any[]) => method === "capability.persistRunState" && params.status === "done",
    );
    expect(terminalPersists).toHaveLength(1);
  });

  it("terminalizes a store-only run without reattaching or respawning its box", async () => {
    const frontend = fakeFrontendClient({
      rows: [{ id: "run-after-restart", profile: "kb-compile", org_id: "org-1", status: "running" }],
      listActive: false,
    });
    const manager = fakeAgentBoxManager();
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: frontend,
      credentialService: {} as any,
    });
    const cancel = server.rpcMethods.get("capability.cancel")!;

    await expect(cancel({ run_id: "run-after-restart" })).resolves.toMatchObject({
      ok: true,
      stop_confirmed: true,
    });
    expect(frontend.rows.get("run-after-restart")).toMatchObject({ status: "done" });
    expect(manager.getAsync).not.toHaveBeenCalled();
    expect(manager.getOrCreate).not.toHaveBeenCalled();
    expect(manager.stop).toHaveBeenCalledWith("run-after-restart");
  });

  it("rejects a blank run id before touching the run store or box", async () => {
    const frontend = fakeFrontendClient();
    const manager = fakeAgentBoxManager();
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: frontend,
      credentialService: {} as any,
    });
    const cancel = server.rpcMethods.get("capability.cancel")!;

    await expect(cancel({ run_id: "   " })).rejects.toThrow("run_id is required");
    expect(manager.stop).not.toHaveBeenCalled();
  });
});
