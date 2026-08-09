/**
 * Regression test for turns left hanging by a Runtime restart.
 *
 * Bug: close() dropped the consumer WS without a word, so a turn that was
 * streaming at that moment simply stopped. Termination is `prompt_done`
 * (docs/design/2026-08-02-error-surfacing-contract.md), and no later event could
 * ever arrive — the process that owned the turn was gone, and its replacement does
 * not adopt turns it did not start. The chat sat at "still working" until reload,
 * so every rolling deploy stranded whoever was mid-conversation.
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

// A turn that is mid-stream: it ends only when its abort signal fires.
let capturedSignal: AbortSignal | undefined;
vi.mock("./sse-consumer.js", () => ({
  consumeAgentSse: vi.fn((opts: { signal?: AbortSignal }) => {
    capturedSignal = opts.signal;
    return new Promise((resolve) => {
      const done = () =>
        resolve({ resultText: "", taskReportText: "", errorMessage: "", eventCount: 0, durationMs: 0 });
      if (opts.signal?.aborted) return done();
      opts.signal?.addEventListener("abort", done, { once: true });
    });
  }),
}));

vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    constructor(public endpoint: string) {}
    prompt = vi.fn(async (opts: { sessionId: string }) => ({
      sessionId: opts.sessionId,
      traceId: "0123456789abcdef0123456789abcdef",
    }));
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

/** Captures the terminator the Runtime hands the manager, so a test can fire it. */
let terminateTurns: ((sessionIds: string[], reason: "box_rolled") => void) | undefined;

async function bootRuntime(frontendClient: any) {
  terminateTurns = undefined;
  return startRuntime({
    config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
    agentBoxManager: {
      setCertManager: vi.fn(),
      setSpawnEnvResolver: vi.fn(),
      setPersistenceResolver: vi.fn(),
      setTurnTerminator: vi.fn((fn: any) => { terminateTurns = fn; }),
      getOrCreate: vi.fn(async () => ({ endpoint: "https://fake.internal" })),
      list: vi.fn(() => []),
      cleanup: vi.fn(async () => {}),
    } as any,
    frontendClient,
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

/** chat.event payloads emitted for `sessionId`, in order. */
function chatEvents(client: any, sessionId: string): Array<Record<string, unknown>> {
  return client.emitEvent.mock.calls
    .filter(([channel, payload]: [string, any]) => channel === "chat.event" && payload?.sessionId === sessionId)
    .map(([, payload]: [string, any]) => payload.event);
}

afterEach(() => {
  capturedSignal = undefined;
  vi.clearAllMocks();
});

describe("startRuntime — shutdown ends in-flight turns", () => {
  it("reports and terminates a streaming turn before the consumer WS closes", async () => {
    const client = fakeFrontendClient();
    const server = await bootRuntime(client);
    const send = server.rpcMethods.get("chat.send")!;

    await send({ agentId: "a", userId: "u", text: "hi", sessionId: "S" }, { sendEvent: vi.fn() });
    await waitFor(() => capturedSignal !== undefined);
    expect(capturedSignal!.aborted).toBe(false);

    await server.close();

    const events = chatEvents(client, "S");
    const kinds = events.map((e) => e.type);
    expect(kinds).toEqual(["stream_error", "prompt_done"]);
    // Retriable, so a consumer can tell the user to resend rather than reporting a fault.
    expect(events[0]).toMatchObject({ type: "stream_error", error: { retriable: true } });
    // Additive fields: a consumer that reads them names the cause instead of showing a
    // generic connection failure; one that does not still sees the terminal it handles.
    expect(events[1]).toMatchObject({ type: "prompt_done", aborted: true, reason: "runtime_restart" });
    // The consumer is broken too, so its own finalization runs (partial text persisted,
    // running tool rows closed) instead of the turn ending only when the box hangs up.
    expect(capturedSignal!.aborted).toBe(true);
    // ...and the terminal goes out while the WS is still usable.
    expect(client.emitEvent.mock.invocationCallOrder.at(-1)!)
      .toBeLessThan(client.close.mock.invocationCallOrder[0]!);
  });

  it("reports each in-flight turn exactly once — the abort it causes must not double-report", async () => {
    const client = fakeFrontendClient();
    const server = await bootRuntime(client);
    const send = server.rpcMethods.get("chat.send")!;

    await send({ agentId: "a", userId: "u", text: "hi", sessionId: "S" }, { sendEvent: vi.fn() });
    await waitFor(() => capturedSignal !== undefined);

    await server.close();
    // The aborted consumer settles asynchronously; give its catch/finally a turn to run.
    await new Promise((r) => setTimeout(r, 20));

    expect(chatEvents(client, "S").filter((e) => e.type === "prompt_done")).toHaveLength(1);
  });

  it("names a turn cut by a box removal, and lets the broken stream report nothing more", async () => {
    const client = fakeFrontendClient();
    const server = await bootRuntime(client);
    const send = server.rpcMethods.get("chat.send")!;

    await send({ agentId: "a", userId: "u", text: "hi", sessionId: "S" }, { sendEvent: vi.fn() });
    await waitFor(() => capturedSignal !== undefined);

    // What the manager does when the drain deadline forces out a box still holding work.
    terminateTurns!(["S", "not-streaming-here"], "box_rolled");
    await new Promise((r) => setTimeout(r, 20)); // let the abort settle the consumer

    const events = chatEvents(client, "S");
    expect(events.map((e) => e.type)).toEqual(["stream_error", "prompt_done"]);
    expect(events[1]).toMatchObject({ aborted: true, reason: "box_rolled" });
    // A session this Runtime is not streaming has no turn to end.
    expect(chatEvents(client, "not-streaming-here")).toEqual([]);
    expect(capturedSignal!.aborted).toBe(true);

    await server.close();
    // Shutdown must not report it a second time — it was already ended and deregistered.
    expect(chatEvents(client, "S")).toHaveLength(2);
  });

  it("does not report a turn that started too late to be registered", async () => {
    // The hazard a blanket "we are shutting down" flag creates: this turn is not in the
    // registry when close() runs, so shutdown cannot report it — and it must therefore be
    // left free to report itself, or it is exactly the hang this file exists to prevent.
    const client = fakeFrontendClient();
    const server = await bootRuntime(client);
    await server.close();
    expect(chatEvents(client, "late-session")).toEqual([]);

    const send = server.rpcMethods.get("chat.send")!;
    await send({ agentId: "a", userId: "u", text: "hi", sessionId: "late-session" }, { sendEvent: vi.fn() });
    await waitFor(() => capturedSignal !== undefined);
    capturedSignal!.dispatchEvent?.(new Event("abort"));
  });
});
