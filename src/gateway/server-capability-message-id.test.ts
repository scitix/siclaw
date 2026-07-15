import { afterEach, describe, expect, it, vi } from "vitest";

const box = vi.hoisted(() => ({
  posts: vi.fn(async () => ({})),
}));

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

vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    endpoint: string;
    constructor(endpoint: string) { this.endpoint = endpoint; }
    postJson = box.posts;
    getJson = vi.fn(async () => ({}));
    streamPath = async function* () {
      await new Promise<never>(() => {});
    };
  },
}));

vi.mock("./capability/materialize.js", () => ({
  materializeCapabilityInputs: vi.fn(async () => ({ locale: undefined, llm: undefined, settings: undefined })),
}));

const { startRuntime } = await import("./server.js");

function fakeFrontendClient() {
  return {
    request: vi.fn(async () => ({ ok: true })),
    onCommand: vi.fn(), emitEvent: vi.fn(), close: vi.fn(),
  } as any;
}

function fakeAgentBoxManager() {
  return {
    setCertManager: vi.fn(), setSpawnEnvResolver: vi.fn(), setPersistenceResolver: vi.fn(),
    getAsync: vi.fn(async () => null),
    getOrCreate: vi.fn(async () => ({ boxId: "agentbox-x", endpoint: "https://10.0.0.9:3000", agentId: "x" })),
    stop: vi.fn(async () => {}), list: vi.fn(() => []), cleanup: vi.fn(async () => {}),
  } as any;
}

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;
afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  vi.clearAllMocks();
});

describe("capability.message idempotency", () => {
  it("forwards message_id to the box once and acknowledges a retry", async () => {
    const frontend = fakeFrontendClient();
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: fakeAgentBoxManager(),
      frontendClient: frontend,
      credentialService: {} as any,
    });
    const start = server.rpcMethods.get("capability.start")!;
    const message = server.rpcMethods.get("capability.message")!;
    const started = await start({ profile: "kb-compile" }) as { run_id: string };

    const first = await message({ run_id: started.run_id, message_id: "op-1", message: "compile once" });
    const retry = await message({ run_id: started.run_id, message_id: "op-1", message: "compile twice" });

    expect(first).toMatchObject({ ok: true, run_id: started.run_id });
    expect(retry).toMatchObject({ ok: true, run_id: started.run_id, duplicate: true });
    const messagePosts = box.posts.mock.calls.filter(([path]) => path === `/message/${started.run_id}`);
    expect(messagePosts).toHaveLength(1);
    expect(messagePosts[0]?.[1]).toEqual({ message: "compile once", message_id: "op-1" });
    const runningPersistIndex = frontend.request.mock.calls.findIndex(([, payload]: any[]) => payload?.status === "running");
    const messagePostIndex = box.posts.mock.calls.findIndex(([path]) => path === `/message/${started.run_id}`);
    expect(runningPersistIndex).toBeGreaterThanOrEqual(0);
    expect(messagePostIndex).toBeGreaterThanOrEqual(0);
    expect(frontend.request.mock.invocationCallOrder[runningPersistIndex]).toBeLessThan(box.posts.mock.invocationCallOrder[messagePostIndex]!);
  });

  it("restores an idle run when the box acknowledges a replay as duplicate", async () => {
    const frontend = fakeFrontendClient();
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: fakeAgentBoxManager(),
      frontendClient: frontend,
      credentialService: {} as any,
    });
    const start = server.rpcMethods.get("capability.start")!;
    const message = server.rpcMethods.get("capability.message")!;
    const started = await start({ profile: "kb-compile" }) as { run_id: string };
    box.posts.mockResolvedValueOnce({ ok: true, duplicate: true });

    await expect(message({
      run_id: started.run_id,
      message_id: "op-replayed-by-box",
      message: "compile once",
    })).resolves.toMatchObject({
      ok: true,
      run_id: started.run_id,
      duplicate: true,
    });

    const persisted = frontend.request.mock.calls.filter((call: any[]) => call[0] === "capability.persistRunState");
    expect(persisted.at(-1)?.[1]).toMatchObject({
      status: "idle",
      checkpoint: { message_ids: ["op-replayed-by-box"] },
    });
  });

  it("restores the previous running status when the box rejects a message", async () => {
    const frontend = fakeFrontendClient();
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: fakeAgentBoxManager(),
      frontendClient: frontend,
      credentialService: {} as any,
    });
    const start = server.rpcMethods.get("capability.start")!;
    const message = server.rpcMethods.get("capability.message")!;
    const started = await start({
      profile: "kb-compile",
      input: { instruction: "compile once" },
    }) as { run_id: string };
    box.posts.mockRejectedValueOnce(new Error("box rejected message"));

    await expect(message({
      run_id: started.run_id,
      message_id: "op-rejected",
      message: "follow up",
    })).rejects.toThrow("box rejected message");

    const persisted = frontend.request.mock.calls.filter((call: any[]) => call[0] === "capability.persistRunState");
    expect(persisted.at(-1)?.[1]).toMatchObject({ status: "running" });
  });
});
