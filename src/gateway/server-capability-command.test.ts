import { afterEach, describe, expect, it, vi } from "vitest";

const posts = vi.hoisted(() => [] as Array<{ path: string; body: unknown }>);

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
    endpoint: string;
    constructor(endpoint: string) { this.endpoint = endpoint; }
    async postJson(path: string, body: unknown) {
      posts.push({ path, body });
      return path.startsWith("/command/") && (body as any)?.command_id === "cmd-duplicate"
        ? { ok: true, duplicate: true }
        : { ok: true };
    }
    async getJson() { return {}; }
    async *streamPath() { await new Promise(() => {}); }
  },
}));
vi.mock("./capability/materialize.js", () => ({
  materializeCapabilityInputs: vi.fn(async () => ({ locale: "zh", llm: undefined, settings: undefined })),
}));

const { startRuntime } = await import("./server.js");

function fakeFrontendClient() {
  return { request: vi.fn(async () => ({})), onCommand: vi.fn(), emitEvent: vi.fn(), close: vi.fn() } as any;
}

function fakeAgentBoxManager() {
  return {
    setCertManager: vi.fn(), setSpawnEnvResolver: vi.fn(), setPersistenceResolver: vi.fn(),
    getAsync: vi.fn(async () => null),
    getOrCreate: vi.fn(async (runId: string) => ({ boxId: `agentbox-${runId}`, endpoint: "https://10.0.0.9:3000", agentId: runId })),
    stop: vi.fn(async () => {}), list: vi.fn(() => []), cleanup: vi.fn(async () => {}),
  } as any;
}

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;
afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  posts.length = 0;
  vi.clearAllMocks();
});

describe("capability.command", () => {
  it("validates the common envelope and forwards the command opaquely", async () => {
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: fakeAgentBoxManager(), frontendClient: fakeFrontendClient(), credentialService: {} as any,
    });
    const start = server.rpcMethods.get("capability.start")!;
    const started = await start({ profile: "kb-compile", org_id: "org-1", correlation_id: "attempt-1" }) as { run_id: string };
    const command = server.rpcMethods.get("capability.command")!;
    const payload = {
      run_id: started.run_id,
      command_id: "cmd-1",
      command: {
        version: 1,
        action: "compile.generate",
        operation_id: "op-1",
        generation: 7,
        parameters: { brief: { content_locale: "auto" } },
      },
    };
    await expect(command(payload)).resolves.toMatchObject({ ok: true, run_id: started.run_id, command_id: "cmd-1" });
    expect(posts).toContainEqual({ path: `/command/${started.run_id}`, body: { command_id: "cmd-1", command: payload.command } });
  });

  it("rejects malformed common fields before touching the box", async () => {
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: fakeAgentBoxManager(), frontendClient: fakeFrontendClient(), credentialService: {} as any,
    });
    const before = posts.length;
    const command = server.rpcMethods.get("capability.command")!;
    await expect(command({
      run_id: "run-x", command_id: "cmd-x",
      command: { version: 1, action: "compile.generate", operation_id: "op-x", generation: 0 },
    })).rejects.toThrow(/generation must be a positive integer/);
    expect(posts).toHaveLength(before);
  });

  it("does not turn an idle run into a phantom running run for a duplicate receipt", async () => {
    const frontend = fakeFrontendClient();
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: fakeAgentBoxManager(), frontendClient: frontend, credentialService: {} as any,
    });
    const start = server.rpcMethods.get("capability.start")!;
    const started = await start({ profile: "kb-compile", org_id: "org-1", correlation_id: "attempt-1" }) as { run_id: string };
    const command = server.rpcMethods.get("capability.command")!;
    await expect(command({
      run_id: started.run_id, command_id: "cmd-duplicate",
      command: { version: 1, action: "compile.generate", operation_id: "op-1", generation: 1, parameters: {} },
    })).resolves.toMatchObject({ duplicate: true });
    // start persisted idle; a duplicate command must not persist a running state.
    const persisted = frontend.request.mock.calls.filter((call: any[]) => call[0] === "capability.persistRunState");
    expect(persisted.at(-1)?.[1]).toMatchObject({ status: "idle" });
  });
});
