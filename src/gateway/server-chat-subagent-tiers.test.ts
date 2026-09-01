/**
 * Regression test: `chat.send` must relay `subagentTiers` into the box prompt.
 *
 * It did not, and that single omission was the whole feature under a control
 * plane. The two channels are independent by design — the tier MENU rides the
 * tools sync channel and arrived fine, so the lead saw `model_tier`, chose `fast`,
 * and every child then fell back because the CANDIDATES never left the Runtime.
 * The failure is silent by construction: falling back is the documented behaviour
 * for missing tier state, so nothing errored, latency and cost looked normal, and
 * only the persisted `fallback_reason: candidate_missing` gave it away.
 *
 * Why no existing test caught it: every unit test fed the Portal-standalone HTTP
 * path (`portal/chat-gateway.ts`), which forwards the field correctly. `chat.send`
 * is the WS entry point a control plane uses, and it had no coverage for this field
 * at all. The source-scanning invariant test missed it too — see
 * `portal/subagent-tier-invariants.test.ts`, which read a curated file list.
 *
 * Drives the real handler from startRuntime with the data layer and the box mocked,
 * and asserts on the PromptOptions the box actually receives.
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

const promptCalls: Array<Record<string, unknown>> = [];
vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    endpoint: string;
    constructor(endpoint: string) {
      this.endpoint = endpoint;
    }
    prompt = vi.fn(async (opts: Record<string, unknown>) => {
      promptCalls.push(opts);
      return { sessionId: opts.sessionId as string, traceId: "0123456789abcdef0123456789abcdef" };
    });
    abortSession = vi.fn(async () => {});
    steerSession = vi.fn(async () => ({ ok: true, traceId: "fedcba9876543210fedcba9876543210" }));
    streamEvents = async function* () {};
  },
}));

const { startRuntime } = await import("./server.js");

function fakeFrontendClient() {
  return {
    request: vi.fn(async () => ({ found: false })),
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

/** The candidate payload as a control plane sends it: self-contained, with credentials. */
const TIERS = {
  revision: "a".repeat(64),
  candidates: [
    {
      tier: "fast",
      provider: "prov-fast",
      modelId: "small-model",
      modelConfig: { apiKey: "sk-secret", baseUrl: "https://api.example.invalid", models: [] },
    },
  ],
};

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;
afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  promptCalls.length = 0;
  vi.clearAllMocks();
});

describe("startRuntime — chat.send forwards sub-agent tier candidates", () => {
  it("relays subagentTiers to the box verbatim", async () => {
    server = await bootRuntime();
    const send = server.rpcMethods.get("chat.send")!;

    await send(
      { agentId: "a", userId: "u", text: "hi", sessionId: "S1", subagentTiers: TIERS },
      { sendEvent: vi.fn() },
    );
    await waitFor(() => promptCalls.length > 0);

    // Verbatim: the AgentBox is what normalizes and resolves wire-compat, so the
    // Runtime editing the payload here would just be a second, divergent copy of
    // rules that already live at the boundary.
    expect(promptCalls[0].subagentTiers).toEqual(TIERS);
  });

  it("passes undefined when the caller sends no tiers, rather than inventing state", async () => {
    // The paired negative. Without it the assertion above would also pass on a
    // handler that spread the whole params object into PromptOptions — which would
    // forward every unvalidated caller-supplied field into the box.
    server = await bootRuntime();
    const send = server.rpcMethods.get("chat.send")!;

    await send({ agentId: "a", userId: "u", text: "hi", sessionId: "S2" }, { sendEvent: vi.fn() });
    await waitFor(() => promptCalls.length > 0);

    expect(promptCalls[0].subagentTiers).toBeUndefined();
    // Absent, not null: the box treats both as "no tiers this turn", but sending a
    // key the caller never set would misreport a clear as a decision.
    expect("subagentTiers" in promptCalls[0]).toBe(true);
  });
});
