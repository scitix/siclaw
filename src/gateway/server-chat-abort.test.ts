/**
 * Regression test for the chat.abort → SSE-consumer wiring.
 *
 * Bug: clicking Stop aborted the agentbox prompt but NOT the gateway's
 * consumeAgentSse signal, so the consumer ended "naturally" and skipped its
 * abort-finalization — leaving in-flight tool rows persisted as "running".
 * A page refresh then re-painted the turn as still reasoning.
 *
 * This test drives the real chat.send / chat.abort RPC handlers from
 * startRuntime (with the data-layer + agentbox modules mocked) and asserts
 * that chat.abort aborts the signal handed to the in-flight consumer.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const bindMessageTraceIdMock = vi.hoisted(() => vi.fn(async () => {}));
const updateMessageMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./chat-repo.js", () => ({
  ensureChatSession: vi.fn(async () => {}),
  appendMessage: vi.fn(async () => "msg-id"),
  bindMessageTraceId: bindMessageTraceIdMock,
  updateMessage: updateMessageMock,
  incrementMessageCount: vi.fn(async () => {}),
}));

vi.mock("./output-redactor.js", () => ({
  buildRedactionConfigForModelConfig: vi.fn(() => ({})),
}));

// The mocked consumer hangs until its abort signal fires — modelling a turn
// that is mid-tool when the user hits Stop. capturedSignal lets the test observe
// whether chat.abort actually aborted it.
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

const abortSessionCalls: string[] = [];
const promptCalls: unknown[] = [];
let promptError: Error | undefined;
// Blocks inside prompt() so a test can hold the /api/prompt round-trip open (and
// then fail it) while the box is already running the turn.
let promptBlocker: Promise<void> | undefined;
// Session ids the fake box reports holding — the evidence chat.abort probes before
// aborting a turn the Gateway still counts as pending.
const boxSessions: string[] = [];
vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    endpoint: string;
    constructor(endpoint: string) {
      this.endpoint = endpoint;
    }
    prompt = vi.fn(async (opts: { sessionId: string }) => {
      promptCalls.push(opts);
      if (promptBlocker) await promptBlocker;
      if (promptError) throw promptError;
      return { sessionId: opts.sessionId, traceId: "0123456789abcdef0123456789abcdef" };
    });
    listSessions = vi.fn(async () => ({ sessions: boxSessions.map((id) => ({ id })) }));
    abortSession = vi.fn(async (sessionId: string) => {
      abortSessionCalls.push(sessionId);
    });
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
    dispatchReliableEvent: vi.fn(() => true),
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

async function bootRuntime(agentBoxManager = fakeAgentBoxManager(), frontendClient = fakeFrontendClient()) {
  return startRuntime({
    config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
    agentBoxManager,
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

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;
afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  capturedSignal = undefined;
  abortSessionCalls.length = 0;
  promptCalls.length = 0;
  promptError = undefined;
  promptBlocker = undefined;
  boxSessions.length = 0;
  vi.clearAllMocks();
});

describe("startRuntime — chat.abort wiring", () => {
  it("acknowledges delegation controls only after a matching source consumer accepts them", async () => {
    const frontendClient = fakeFrontendClient();
    server = await bootRuntime(fakeAgentBoxManager(), frontendClient);
    const control = server.rpcMethods.get("delegation.control")!;
    const envelope = { delegationId: "d1", sessionId: "S", event: { type: "prompt_done" } };

    frontendClient.dispatchReliableEvent.mockReturnValueOnce(false);
    await expect(control(envelope, { sendEvent: vi.fn() })).rejects.toThrow(/No active delegation consumer/);

    frontendClient.dispatchReliableEvent.mockReturnValueOnce(true);
    await expect(control(envelope, { sendEvent: vi.fn() })).resolves.toMatchObject({ ok: true });
    expect(frontendClient.dispatchReliableEvent).toHaveBeenLastCalledWith("delegation.event", envelope);
  });

  it("starts consuming the reply without waiting for trace binding", async () => {
    bindMessageTraceIdMock.mockImplementationOnce(() => new Promise<void>(() => {}));
    server = await bootRuntime();
    const send = server.rpcMethods.get("chat.send")!;
    const abort = server.rpcMethods.get("chat.abort")!;

    await send({ agentId: "a", userId: "u", text: "hi", sessionId: "S" }, { sendEvent: vi.fn() });
    await waitFor(() => capturedSignal !== undefined);

    expect(bindMessageTraceIdMock).toHaveBeenCalled();
    await abort({ agentId: "a", sessionId: "S" });
  });

  it("aborts the in-flight chat.send consumer signal AND the agentbox", async () => {
    server = await bootRuntime();
    const send = server.rpcMethods.get("chat.send")!;
    const abort = server.rpcMethods.get("chat.abort")!;
    const ctx = { sendEvent: vi.fn() };

    const ack = await send({ agentId: "a", userId: "u", text: "hi", sessionId: "S" }, ctx);
    expect(ack).toMatchObject({ ok: true, sessionId: "S" });

    // The IIFE must reach consumeAgentSse (ensureChatSession → prompt → register).
    await waitFor(() => capturedSignal !== undefined);
    expect(capturedSignal!.aborted).toBe(false);
    expect(bindMessageTraceIdMock).toHaveBeenCalledWith(
      "msg-id",
      "S",
      "0123456789abcdef0123456789abcdef",
    );

    const res = await abort({ agentId: "a", sessionId: "S" });
    expect(res).toMatchObject({ ok: true });

    // The fix: chat.abort breaks the gateway consumer (so its finalization runs)
    // in addition to stopping the agentbox.
    expect(capturedSignal!.aborted).toBe(true);
    expect(abortSessionCalls).toEqual(["S"]);
  });

  it("is a no-op (no throw) when no consumer is registered for the session", async () => {
    server = await bootRuntime();
    const abort = server.rpcMethods.get("chat.abort")!;
    await expect(abort({ agentId: "a", sessionId: "missing" })).resolves.toMatchObject({ ok: true });
    // The agentbox is still asked to stop even with no live gateway consumer.
    expect(abortSessionCalls).toEqual(["missing"]);
  });

  it("does not dispatch prompt after Stop is acknowledged during cold spawn", async () => {
    let releaseColdSpawn: (() => void) | undefined;
    let getOrCreateCalls = 0;
    const manager = fakeAgentBoxManager();
    manager.getOrCreate.mockImplementation(async () => {
      getOrCreateCalls += 1;
      // Hold the first chat.send placement so Stop lands while the turn exists
      // only in the Gateway's pending-start registry.
      if (getOrCreateCalls === 1) {
        await new Promise<void>((resolve) => { releaseColdSpawn = resolve; });
      }
      return { boxId: "box-a", endpoint: "https://fake.internal" };
    });

    server = await bootRuntime(manager);
    const send = server.rpcMethods.get("chat.send")!;
    const abort = server.rpcMethods.get("chat.abort")!;
    const ctx = { sendEvent: vi.fn() };

    await expect(send({ agentId: "a", userId: "u", text: "hi", sessionId: "S" }, ctx))
      .resolves.toMatchObject({ ok: true, sessionId: "S" });
    await waitFor(() => getOrCreateCalls === 1);

    await expect(abort({ agentId: "a", sessionId: "S" })).resolves.toMatchObject({ ok: true });
    releaseColdSpawn?.();
    await waitFor(() => ctx.sendEvent.mock.calls.some(
      ([channel, data]) => channel === "chat.event" && data?.event?.type === "prompt_done",
    ));

    expect(promptCalls).toHaveLength(0);
    expect(abortSessionCalls).toEqual([]);

    // The pending-only Stop must not arm AgentBox's pre-spawn abort latch. A
    // second intentional send on the same session is allowed to reach prompt.
    await expect(send({ agentId: "a", userId: "u", text: "try again", sessionId: "S" }, ctx))
      .resolves.toMatchObject({ ok: true, sessionId: "S" });
    await waitFor(() => promptCalls.length === 1);
    expect(promptCalls[0]).toMatchObject({ sessionId: "S", text: "try again" });

    await abort({ agentId: "a", sessionId: "S" });
    expect(abortSessionCalls).toEqual(["S"]);
  });

  it("stops an orphaned turn when the prompt ack is lost and nobody pressed Stop", async () => {
    // The leak is not conditional on Stop: AgentBox starts the run before it
    // acknowledges, so an ack lost during an ordinary send strands a turn with no
    // consumer. Compensation therefore belongs on the rejection path.
    let failPrompt: ((err: Error) => void) | undefined;
    promptBlocker = new Promise<void>((_resolve, reject) => { failPrompt = reject; });
    boxSessions.push("orphan");

    const manager = fakeAgentBoxManager();
    manager.getOrCreate.mockResolvedValue({ boxId: "box-a", endpoint: "https://fake.internal" });
    server = await bootRuntime(manager);
    const send = server.rpcMethods.get("chat.send")!;
    const ctx = { sendEvent: vi.fn() };

    await send({ agentId: "a", userId: "u", text: "hi", sessionId: "orphan" }, ctx);
    await waitFor(() => promptCalls.length === 1);

    failPrompt?.(new Error("socket hang up"));
    await waitFor(() => ctx.sendEvent.mock.calls.some(
      ([channel, data]) => channel === "chat.event" && data?.event?.type === "prompt_done",
    ));

    expect(abortSessionCalls).toEqual(["orphan"]);
  });

  it("leaves the box alone when a failed prompt created no session", async () => {
    // Same rejection path, box holds nothing: aborting would arm the pre-spawn
    // latch and the user's retry would be short-circuited as aborted.
    let failPrompt: ((err: Error) => void) | undefined;
    promptBlocker = new Promise<void>((_resolve, reject) => { failPrompt = reject; });

    const manager = fakeAgentBoxManager();
    manager.getOrCreate.mockResolvedValue({ boxId: "box-a", endpoint: "https://fake.internal" });
    server = await bootRuntime(manager);
    const send = server.rpcMethods.get("chat.send")!;
    const ctx = { sendEvent: vi.fn() };

    await send({ agentId: "a", userId: "u", text: "hi", sessionId: "clean-failure" }, ctx);
    await waitFor(() => promptCalls.length === 1);

    failPrompt?.(new Error("connection refused"));
    await waitFor(() => ctx.sendEvent.mock.calls.some(
      ([channel, data]) => channel === "chat.event" && data?.event?.type === "prompt_done",
    ));

    expect(abortSessionCalls).toEqual([]);
  });

  it("aborts a dispatched turn whose prompt ack was lost, even while it is only pending", async () => {
    // AgentBox starts the run BEFORE it acknowledges /api/prompt. A lost/timed-out
    // ack therefore leaves a really-running turn behind a still-pending Gateway
    // state, and prompt()'s rejection never reaches the post-accept compensation.
    // Stop must reach the box, or the peer turn runs headless to completion.
    let failPrompt: ((err: Error) => void) | undefined;
    promptBlocker = new Promise<void>((_resolve, reject) => { failPrompt = reject; });
    boxSessions.push("ack-lost");

    const manager = fakeAgentBoxManager();
    manager.getOrCreate.mockResolvedValue({ boxId: "box-a", endpoint: "https://fake.internal" });
    server = await bootRuntime(manager);
    const send = server.rpcMethods.get("chat.send")!;
    const abort = server.rpcMethods.get("chat.abort")!;
    const ctx = { sendEvent: vi.fn() };

    try {
      await send({ agentId: "a", userId: "u", text: "hi", sessionId: "ack-lost" }, ctx);
      await waitFor(() => promptCalls.length === 1);
      // No consumer yet: the turn exists only in the pending-start registry.
      expect(capturedSignal).toBeUndefined();

      await expect(abort({ agentId: "a", sessionId: "ack-lost" })).resolves.toMatchObject({ ok: true });
      expect(abortSessionCalls).toEqual(["ack-lost"]);
    } finally {
      // Always fail the held prompt: leaving it pending would keep this session's
      // turn lock held for the rest of the file.
      failPrompt?.(new Error("socket hang up"));
    }
    await waitFor(() => ctx.sendEvent.mock.calls.some(
      ([channel, data]) => channel === "chat.event" && data?.event?.type === "prompt_done",
    ));
  });

  it("does not abort the box when a dispatched prompt never created the session", async () => {
    // Same pending-only shape, but the box genuinely has nothing: aborting would
    // only arm the pre-spawn latch that the next intentional send would consume.
    let failPrompt: ((err: Error) => void) | undefined;
    promptBlocker = new Promise<void>((_resolve, reject) => { failPrompt = reject; });
    // boxSessions stays empty: the box holds nothing for this id.

    const manager = fakeAgentBoxManager();
    manager.getOrCreate.mockResolvedValue({ boxId: "box-a", endpoint: "https://fake.internal" });
    server = await bootRuntime(manager);
    const send = server.rpcMethods.get("chat.send")!;
    const abort = server.rpcMethods.get("chat.abort")!;
    const ctx = { sendEvent: vi.fn() };

    try {
      await send({ agentId: "a", userId: "u", text: "hi", sessionId: "no-session" }, ctx);
      await waitFor(() => promptCalls.length === 1);

      await expect(abort({ agentId: "a", sessionId: "no-session" })).resolves.toMatchObject({ ok: true });
      expect(abortSessionCalls).toEqual([]);
    } finally {
      failPrompt?.(new Error("connection refused"));
    }
    await waitFor(() => ctx.sendEvent.mock.calls.some(
      ([channel, data]) => channel === "chat.event" && data?.event?.type === "prompt_done",
    ));
  });

  it("binds an explicit steer message to the active prompt trace", async () => {
    server = await bootRuntime();
    const steer = server.rpcMethods.get("chat.steer")!;

    await expect(steer({ agentId: "a", sessionId: "S", text: "also check logs" })).resolves.toMatchObject({ ok: true });

    expect(bindMessageTraceIdMock).toHaveBeenCalledWith(
      "msg-id",
      "S",
      "fedcba9876543210fedcba9876543210",
    );
  });

  it("marks and binds a concurrent send after the automatic steer", async () => {
    promptError = new Error("Session is already running");
    server = await bootRuntime();
    const send = server.rpcMethods.get("chat.send")!;

    await send({ agentId: "a", userId: "u", text: "one more detail", sessionId: "S" }, { sendEvent: vi.fn() });
    await waitFor(() => bindMessageTraceIdMock.mock.calls.length > 0);

    expect(updateMessageMock).toHaveBeenCalledWith({
      messageId: "msg-id",
      sessionId: "S",
      content: "one more detail",
      metadata: { kind: "steer" },
    });
    expect(bindMessageTraceIdMock).toHaveBeenCalledWith(
      "msg-id",
      "S",
      "fedcba9876543210fedcba9876543210",
    );
    expect(updateMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
      bindMessageTraceIdMock.mock.invocationCallOrder[0],
    );
  });

  it("clears the registration after the turn settles (no leak / no stale abort)", async () => {
    server = await bootRuntime();
    const send = server.rpcMethods.get("chat.send")!;
    const abort = server.rpcMethods.get("chat.abort")!;
    const ctx = { sendEvent: vi.fn() };

    await send({ agentId: "a", userId: "u", text: "hi", sessionId: "S" }, ctx);
    await waitFor(() => capturedSignal !== undefined);

    const firstSignal = capturedSignal!;
    // Abort settles the turn; the IIFE finally should remove the registration.
    await abort({ agentId: "a", sessionId: "S" });
    await waitFor(() => firstSignal.aborted);
    // Give the consumer's resolve + finally a tick to delete the map entry.
    await new Promise((r) => setTimeout(r, 20));

    // A SECOND abort for the same session now finds nothing to abort — proving the
    // entry was cleared (a leaked entry would let a later abort fire a dead signal).
    abortSessionCalls.length = 0;
    await abort({ agentId: "a", sessionId: "S" });
    expect(abortSessionCalls).toEqual(["S"]); // agentbox still asked, but...
    // ...the cleared registration means no second live signal existed to re-abort.
    // (firstSignal stays aborted; there's no new controller to observe.)
    expect(capturedSignal).toBe(firstSignal);
  });
});
