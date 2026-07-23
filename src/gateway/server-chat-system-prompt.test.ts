/**
 * Regression test for the custom-system-prompt fallback in chat.send.
 *
 * Bug: sicore's web-chat proxy sends chat.send WITHOUT a systemPrompt param, so
 * the runtime's handler (which only read params.systemPrompt) handed the box
 * `undefined` and a custom-prompt agent silently got AgentBox's built-in default
 * SRE persona. Channel paths (dingtalk/lark) already resolved the agent's own
 * template via config.getAgent and worked — only the web path was unwired.
 *
 * The fix: when the caller does not forward systemPrompt, chat.send falls back to
 * resolveAgentSystemPrompt(agentId, frontendClient). An explicitly forwarded
 * prompt (portal-standalone) still wins as-is; a resolve failure / no custom
 * prompt falls back to undefined = built-in default.
 *
 * This test drives the real chat.send handler from startRuntime (data-layer +
 * agentbox mocked) and asserts what systemPromptTemplate the box prompt receives.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("./chat-repo.js", () => ({
  ensureChatSession: vi.fn(async () => {}),
  appendMessage: vi.fn(async () => "msg-id"),
  bindMessageTraceId: vi.fn(async () => {}),
  updateMessage: vi.fn(async () => {}),
  incrementMessageCount: vi.fn(async () => {}),
}));

vi.mock("./output-redactor.js", () => ({
  buildRedactionConfigForModelConfig: vi.fn(() => ({})),
}));

// The mocked consumer hangs (the IIFE never settles) — we only need it to reach
// prompt(), whose opts we capture below.
vi.mock("./sse-consumer.js", () => ({
  consumeAgentSse: vi.fn((opts: { signal?: AbortSignal }) => {
    return new Promise((resolve) => {
      const done = () =>
        resolve({ resultText: "", taskReportText: "", errorMessage: "", eventCount: 0, durationMs: 0 });
      if (opts.signal?.aborted) return done();
      opts.signal?.addEventListener("abort", done, { once: true });
    });
  }),
}));

const promptCalls: Array<{ systemPromptTemplate?: string; sessionId: string }> = [];
vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    endpoint: string;
    constructor(endpoint: string) {
      this.endpoint = endpoint;
    }
    prompt = vi.fn(async (opts: { sessionId: string; systemPromptTemplate?: string }) => {
      promptCalls.push(opts);
      return { sessionId: opts.sessionId, traceId: "0123456789abcdef0123456789abcdef" };
    });
    abortSession = vi.fn(async () => {});
    steerSession = vi.fn(async () => ({ ok: true, traceId: "fedcba9876543210fedcba9876543210" }));
    streamEvents = async function* () {};
  },
}));

const { startRuntime } = await import("./server.js");

// getAgentResult drives what config.getAgent resolves to (or throws when set to
// an Error), letting each test model "custom prompt present / absent / lookup
// failed". Other RPC methods resolve empty so unrelated wiring stays inert.
let getAgentResult: unknown = undefined;
let getAgentError: Error | undefined;
const getAgentCalls: unknown[] = [];
function fakeFrontendClient() {
  return {
    request: vi.fn(async (method: string, params: unknown) => {
      if (method === "config.getAgent") {
        getAgentCalls.push(params);
        if (getAgentError) throw getAgentError;
        return getAgentResult;
      }
      return { found: false };
    }),
    onCommand: vi.fn(),
    emitEvent: vi.fn(),
    close: vi.fn(),
  } as any;
}

function fakeAgentBoxManager() {
  return {
    setCertManager: vi.fn(),
    setSpawnEnvResolver: vi.fn(),
    setPersistenceResolver: vi.fn(),
    getOrCreate: vi.fn(async () => ({ endpoint: "https://fake.internal" })),
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;
afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  promptCalls.length = 0;
  getAgentCalls.length = 0;
  getAgentResult = undefined;
  getAgentError = undefined;
  vi.clearAllMocks();
});

describe("startRuntime — chat.send custom system prompt", () => {
  it("uses an explicitly forwarded systemPrompt as-is (portal-standalone) and skips the lookup", async () => {
    // config.getAgent would resolve a DIFFERENT prompt; the explicit param must win
    // and the fallback lookup must not even run.
    getAgentResult = { system_prompt: "should-not-be-used" };
    server = await bootRuntime();
    const send = server.rpcMethods.get("chat.send")!;

    await send(
      { agentId: "a", userId: "u", text: "hi", sessionId: "S", systemPrompt: "explicit-portal-prompt" },
      { sendEvent: vi.fn() },
    );
    await waitFor(() => promptCalls.length > 0);

    expect(promptCalls[0].systemPromptTemplate).toBe("explicit-portal-prompt");
    expect(getAgentCalls).toEqual([]);
  });

  it("falls back to the agent's custom prompt when the caller omits systemPrompt (sicore web path)", async () => {
    getAgentResult = { system_prompt: "custom agent persona" };
    server = await bootRuntime();
    const send = server.rpcMethods.get("chat.send")!;

    await send({ agentId: "a", userId: "u", text: "hi", sessionId: "S" }, { sendEvent: vi.fn() });
    await waitFor(() => promptCalls.length > 0);

    expect(getAgentCalls).toEqual([{ agentId: "a" }]);
    expect(promptCalls[0].systemPromptTemplate).toBe("custom agent persona");
  });

  it("falls back to undefined (built-in default) when the agent has no custom prompt", async () => {
    getAgentResult = { system_prompt: null };
    server = await bootRuntime();
    const send = server.rpcMethods.get("chat.send")!;

    await send({ agentId: "a", userId: "u", text: "hi", sessionId: "S" }, { sendEvent: vi.fn() });
    await waitFor(() => promptCalls.length > 0);

    expect(promptCalls[0].systemPromptTemplate).toBeUndefined();
  });

  it("falls back to undefined (built-in default) when the prompt lookup fails — never a chat failure", async () => {
    getAgentError = new Error("config.getAgent RPC exploded");
    server = await bootRuntime();
    const send = server.rpcMethods.get("chat.send")!;

    const ack = await send({ agentId: "a", userId: "u", text: "hi", sessionId: "S" }, { sendEvent: vi.fn() });
    // The ack still returns ok — a resolve failure must not fail the send.
    expect(ack).toMatchObject({ ok: true, sessionId: "S" });
    await waitFor(() => promptCalls.length > 0);

    expect(promptCalls[0].systemPromptTemplate).toBeUndefined();
  });
});
