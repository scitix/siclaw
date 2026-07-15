/**
 * Tests for the chat.sessionStatus RPC (Portal reconnect-after-refresh liveness probe).
 *
 * Contract: never spawn a box just to check liveness (getAsync, not getOrCreate); fail-safe to
 * running:false on a missing box or any client error, so a transient hiccup makes the page show
 * static history rather than a stuck spinner.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

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

// sessionStatus behaviour is swapped per-test via this hook.
let statusImpl: (sessionId: string) => Promise<{ running: boolean }>;
vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    endpoint: string;
    constructor(endpoint: string) { this.endpoint = endpoint; }
    sessionStatus = vi.fn((sessionId: string) => statusImpl(sessionId));
    streamEvents = async function* () {};
  },
}));

const { startRuntime } = await import("./server.js");

function fakeFrontendClient() {
  return { request: vi.fn(async () => ({ found: false })), onCommand: vi.fn(), emitEvent: vi.fn(), close: vi.fn() } as any;
}

// getAsync is what chat.sessionStatus uses (non-spawning). Returns the handle this test sets.
let nextHandle: { endpoint: string } | null;
function fakeAgentBoxManager() {
  return {
    setCertManager: vi.fn(),
    setSpawnEnvResolver: vi.fn(),
    setPersistenceResolver: vi.fn(),
    getAsync: vi.fn(async () => nextHandle),
    getOrCreate: vi.fn(async () => { throw new Error("getOrCreate must not be called for liveness"); }),
    list: vi.fn(() => []),
    cleanup: vi.fn(async () => {}),
  } as any;
}

async function bootRuntime() {
  return startRuntime({
    config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
    agentBoxManager: fakeAgentBoxManager(),
    frontendClient: fakeFrontendClient(),
    credentialService: {} as any,
  });
}

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;
afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  nextHandle = null;
  vi.clearAllMocks();
});

describe("startRuntime — chat.sessionStatus", () => {
  it("returns running:false (without spawning) when no box exists", async () => {
    nextHandle = null;
    server = await bootRuntime();
    const status = server.rpcMethods.get("chat.sessionStatus")!;
    const res = await status({ agentId: "a", sessionId: "S" });
    expect(res).toMatchObject({ ok: true, running: false });
  });

  it("returns the agentbox running flag when a box exists", async () => {
    nextHandle = { endpoint: "https://fake.internal" };
    statusImpl = async () => ({ running: true });
    server = await bootRuntime();
    const status = server.rpcMethods.get("chat.sessionStatus")!;
    const res = await status({ agentId: "a", sessionId: "S" });
    expect(res).toMatchObject({ ok: true, running: true });
  });

  it("fails safe to running:false when the agentbox probe throws", async () => {
    nextHandle = { endpoint: "https://fake.internal" };
    statusImpl = async () => { throw new Error("ECONNREFUSED"); };
    server = await bootRuntime();
    const status = server.rpcMethods.get("chat.sessionStatus")!;
    const res = await status({ agentId: "a", sessionId: "S" });
    expect(res).toMatchObject({ ok: true, running: false });
  });

  it("rejects when agentId/sessionId are missing", async () => {
    server = await bootRuntime();
    const status = server.rpcMethods.get("chat.sessionStatus")!;
    await expect(status({ agentId: "a" })).rejects.toThrow(/required/);
  });
});
