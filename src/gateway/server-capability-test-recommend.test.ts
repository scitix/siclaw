import { afterEach, describe, expect, it, vi } from "vitest";

const posts = vi.hoisted(() => [] as Array<{ path: string; body: unknown; timeoutMs?: number }>);

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
    async postJson(path: string, body: unknown, timeoutMs?: number) {
      posts.push({ path, body, timeoutMs });
      if (path.startsWith("/test-recommendation/")) {
        return {
          question: "What is the retry limit?",
          reference_answer: "Three attempts.",
          evidence_paths: ["raw/policy.md"],
        };
      }
      return { ok: true };
    }
    async getJson() { return {}; }
    async *streamPath() { await new Promise(() => {}); }
  },
}));
vi.mock("./capability/materialize.js", () => ({
  materializeCapabilityInputs: vi.fn(async () => ({ locale: "en", llm: undefined, settings: undefined })),
}));

const { startRuntime } = await import("./server.js");

function fakeFrontendClient() {
  return {
    request: vi.fn(async () => ({})), onCommand: vi.fn(), emitEvent: vi.fn(), close: vi.fn(),
  } as any;
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

describe("capability.testRecommend", () => {
  it("runs an explicit recommendation on the authoring box with a bounded long timeout", async () => {
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: fakeAgentBoxManager(), frontendClient: fakeFrontendClient(), credentialService: {} as any,
    });
    const start = server.rpcMethods.get("capability.start")!;
    const started = await start({ profile: "kb-compile", org_id: "org-1", correlation_id: "attempt-1" }) as { run_id: string };
    const recommend = server.rpcMethods.get("capability.testRecommend")!;

    await expect(recommend({ run_id: started.run_id })).resolves.toEqual({
      run_id: started.run_id,
      question: "What is the retry limit?",
      reference_answer: "Three attempts.",
      evidence_paths: ["raw/policy.md"],
    });
    expect(posts).toContainEqual({
      path: `/test-recommendation/${started.run_id}`,
      body: {},
      timeoutMs: 210_000,
    });
  });
});
