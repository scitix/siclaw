import { afterEach, describe, expect, it, vi } from "vitest";

const materializeMock = vi.hoisted(() => vi.fn());
const effects = vi.hoisted(() => [] as string[]);
const boxPosts = vi.hoisted(() => [] as Array<{ path: string; body: unknown }>);

vi.mock("./chat-repo.js", () => ({
  ensureChatSession: vi.fn(async () => {}),
  appendMessage: vi.fn(async () => "msg-id"),
  incrementMessageCount: vi.fn(async () => {}),
}));

vi.mock("./output-redactor.js", () => ({
  buildRedactionConfigForModelConfig: vi.fn(() => ({})),
}));

vi.mock("./sse-consumer.js", () => ({
  consumeAgentSse: vi.fn(async () => ({
    resultText: "",
    taskReportText: "",
    errorMessage: "",
    eventCount: 0,
    durationMs: 0,
  })),
}));

vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    endpoint: string;
    constructor(endpoint: string) { this.endpoint = endpoint; }
    async postJson(path: string, body: unknown) {
      effects.push(`post:${path}`);
      boxPosts.push({ path, body });
      return { ok: true };
    }
    async getJson() { return {}; }
    async *streamPath() {
      await new Promise(() => {});
    }
  },
}));

vi.mock("./capability/materialize.js", () => ({
  materializeCapabilityInputs: materializeMock,
}));

const { startRuntime } = await import("./server.js");

function fakeFrontendClient(opts: { rejectRevision?: string; activeRuns?: any[] } = {}) {
  return {
    request: vi.fn(async (method: string, params: any) => {
      if (method === "capability.listActiveRuns") {
        return { runs: opts.activeRuns ?? [] };
      }
      if (method === "capability.persistRunState") {
        const revision = params?.checkpoint?.input_revision ?? "none";
        effects.push(`persist:${revision}`);
      }
      if (method === "capability.persistRunState" && params?.checkpoint?.input_revision === opts.rejectRevision) {
        throw new Error("checkpoint rejected");
      }
      return {};
    }),
    onCommand: vi.fn(),
    emitEvent: vi.fn(),
    close: vi.fn(),
  } as any;
}

function fakeAgentBoxManager(opts: { alive?: boolean } = {}) {
  const handle = (runId: string) => ({
    boxId: `agentbox-${runId}`,
    endpoint: "https://10.0.0.9:3000",
    agentId: runId,
  });
  return {
    setCertManager: vi.fn(),
    setSpawnEnvResolver: vi.fn(),
    setPersistenceResolver: vi.fn(),
    getAsync: vi.fn(async (runId: string) => opts.alive ? handle(runId) : null),
    getOrCreate: vi.fn(async (runId: string) => {
      effects.push("spawn");
      return handle(runId);
    }),
    stop: vi.fn(async () => {}),
    list: vi.fn(() => []),
    cleanup: vi.fn(async () => {}),
  } as any;
}

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  effects.length = 0;
  boxPosts.length = 0;
  vi.clearAllMocks();
});

describe("capability.start immutable input revision", () => {
  it("rejects an invalid revision before persisting or touching a box", async () => {
    const frontend = fakeFrontendClient();
    const manager = fakeAgentBoxManager();
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: frontend,
      credentialService: {} as any,
    });

    const start = server.rpcMethods.get("capability.start")!;
    await expect(start({
      profile: "kb-compile",
      input_revision: "   ",
    })).rejects.toThrow("input_revision must be a non-empty string");

    expect(manager.getOrCreate).not.toHaveBeenCalled();
    expect(materializeMock).not.toHaveBeenCalled();
    expect(effects).not.toContainEqual(expect.stringMatching(/^persist:/));
  });

  it("fails before spawning or materializing when the initial revision checkpoint is rejected", async () => {
    materializeMock.mockResolvedValue({ inputRevision: "manifest-7" });
    const frontend = fakeFrontendClient({ rejectRevision: "manifest-7" });
    const manager = fakeAgentBoxManager();
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: frontend,
      credentialService: {} as any,
    });

    const start = server.rpcMethods.get("capability.start")!;
    await expect(start({
      profile: "kb-compile",
      org_id: "org-1",
      correlation_id: "attempt-1",
      input_revision: "manifest-7",
      input: { instruction: "compile" },
    })).rejects.toThrow("checkpoint rejected");

    expect(manager.getOrCreate).not.toHaveBeenCalled();
    expect(materializeMock).not.toHaveBeenCalled();
    const persists = frontend.request.mock.calls.filter(
      (call: any[]) => call[0] === "capability.persistRunState",
    );
    expect(persists).toHaveLength(1);
    expect(persists[0][1]).toMatchObject({
      correlation_id: "attempt-1",
      checkpoint: { input_revision: "manifest-7" },
    });
  });

  it("persists the pinned revision before materialization and installs that exact revision", async () => {
    materializeMock.mockImplementation(async (opts: any) => {
      effects.push(`materialize:${opts.inputRevision ?? "none"}`);
      return { inputRevision: opts.inputRevision };
    });
    const frontend = fakeFrontendClient();
    const manager = fakeAgentBoxManager();
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: frontend,
      credentialService: {} as any,
    });

    const start = server.rpcMethods.get("capability.start")!;
    const started = await start({
      profile: "kb-compile",
      org_id: "org-1",
      correlation_id: "attempt-1",
      input_revision: " manifest-7 ",
    }) as { run_id: string };

    expect(effects.slice(0, 4)).toEqual([
      "persist:manifest-7",
      "spawn",
      "materialize:manifest-7",
      `post:/session/${started.run_id}`,
    ]);
    expect(materializeMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: started.run_id,
      inputRevision: "manifest-7",
    }));
    expect(boxPosts.at(-1)?.body).toMatchObject({ instruction: "" });
  });

  it("restores the pinned revision on restart before reattaching a live box", async () => {
    materializeMock.mockImplementation(async (opts: any) => {
      effects.push(`materialize:${opts.inputRevision ?? "none"}`);
      return { inputRevision: opts.inputRevision };
    });
    const frontend = fakeFrontendClient({
      activeRuns: [{
        id: "run-restored",
        profile: "kb-compile",
        org_id: "org-1",
        correlation_id: "attempt-1",
        status: "idle",
        checkpoint: JSON.stringify({ input_revision: "manifest-7" }),
      }],
    });
    const manager = fakeAgentBoxManager({ alive: true });
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager,
      frontendClient: frontend,
      credentialService: {} as any,
    });

    await vi.waitFor(() => {
      expect(materializeMock).toHaveBeenCalledWith(expect.objectContaining({
        runId: "run-restored",
        inputRevision: "manifest-7",
      }));
    });
    expect(effects).toContain("materialize:manifest-7");
    expect(boxPosts).toContainEqual(expect.objectContaining({ path: "/session/run-restored" }));
  });
});
