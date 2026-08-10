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
const abortSessionTurnIds: Array<string | undefined> = [];
const promptCalls: unknown[] = [];
let promptError: Error | undefined;
// Blocks inside prompt() so a test can hold the /api/prompt round-trip open (and
// then fail it) while the box is already running the turn.
let promptBlocker: Promise<void> | undefined;
// Set to make the fake box refuse the abort.
let abortSessionError: Error | undefined;
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
    abortSession = vi.fn(async (sessionId: string, turnId?: string) => {
      abortSessionCalls.push(sessionId);
      abortSessionTurnIds.push(turnId);
      if (abortSessionError) throw abortSessionError;
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
  abortSessionCalls.length = 0;
  abortSessionTurnIds.length = 0;
  abortSessionError = undefined;
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

  it("names the turn in every abort it sends, so a stale one cannot reach a successor", async () => {
    const manager = fakeAgentBoxManager();
    manager.getOrCreate.mockResolvedValue({ boxId: "box-a", endpoint: "https://fake.internal" });
    server = await bootRuntime(manager);
    const send = server.rpcMethods.get("chat.send")!;
    const abort = server.rpcMethods.get("chat.abort")!;

    const ack = await send({ agentId: "a", userId: "u", text: "hi", sessionId: "S" }, { sendEvent: vi.fn() }) as { turnId?: string };
    expect(ack.turnId).toEqual(expect.any(String));
    await waitFor(() => capturedSignal !== undefined);

    // An abort naming a DIFFERENT turn is stale: it must not touch the running one.
    await expect(abort({ agentId: "a", sessionId: "S", turnId: "some-earlier-turn" }))
      .resolves.toMatchObject({ ok: true, stale: true });
    expect(capturedSignal!.aborted).toBe(false);
    expect(abortSessionCalls).toEqual([]);

    // The user's Stop names no turn and stops what is running, tagged with it.
    await expect(abort({ agentId: "a", sessionId: "S" })).resolves.toMatchObject({ ok: true });
    expect(capturedSignal!.aborted).toBe(true);
    expect(abortSessionCalls).toEqual(["S"]);
    expect(abortSessionTurnIds).toEqual([ack.turnId]);
  });

  it("stops a turn whose prompt ack was lost, with or without a Stop", async () => {
    // AgentBox starts the run before acknowledging /api/prompt, so a lost ack strands
    // a turn nobody consumes. Naming the turn makes compensation unconditional: if
    // the box never started it the abort is a no-op it cannot confuse with a later
    // turn, so there is nothing left to probe for.
    let failPrompt: ((err: Error) => void) | undefined;
    promptBlocker = new Promise<void>((_resolve, reject) => { failPrompt = reject; });

    const manager = fakeAgentBoxManager();
    manager.getOrCreate.mockResolvedValue({ boxId: "box-a", endpoint: "https://fake.internal" });
    server = await bootRuntime(manager);
    const send = server.rpcMethods.get("chat.send")!;
    const ctx = { sendEvent: vi.fn() };

    const ack = await send({ agentId: "a", userId: "u", text: "hi", sessionId: "orphan" }, ctx) as { turnId?: string };
    await waitFor(() => promptCalls.length === 1);
    expect(promptCalls[0]).toMatchObject({ sessionId: "orphan", turnId: ack.turnId });

    failPrompt?.(new Error("socket hang up"));
    await waitFor(() => ctx.sendEvent.mock.calls.some(
      ([channel, data]) => channel === "chat.event" && data?.event?.type === "prompt_done",
    ));

    expect(abortSessionCalls).toEqual(["orphan"]);
    expect(abortSessionTurnIds).toEqual([ack.turnId]);
  });

  it("lets a retry run after a cold-start Stop, because the latch is turn-scoped", async () => {
    let releaseColdSpawn: (() => void) | undefined;
    let getOrCreateCalls = 0;
    const manager = fakeAgentBoxManager();
    manager.getOrCreate.mockImplementation(async () => {
      getOrCreateCalls += 1;
      if (getOrCreateCalls === 1) {
        await new Promise<void>((resolve) => { releaseColdSpawn = resolve; });
      }
      return { boxId: "box-a", endpoint: "https://fake.internal" };
    });

    server = await bootRuntime(manager);
    const send = server.rpcMethods.get("chat.send")!;
    const abort = server.rpcMethods.get("chat.abort")!;
    const ctx = { sendEvent: vi.fn() };

    const first = await send({ agentId: "a", userId: "u", text: "hi", sessionId: "S" }, ctx) as { turnId?: string };
    await waitFor(() => getOrCreateCalls === 1);

    // Stop lands while the turn exists only in the pending-start registry. The box is
    // asked to stop that TURN — previously this call was skipped entirely, because a
    // session-wide latch would have cancelled the retry below.
    await expect(abort({ agentId: "a", sessionId: "S" })).resolves.toMatchObject({ ok: true });
    expect(abortSessionTurnIds).toEqual([first.turnId]);
    releaseColdSpawn?.();
    await waitFor(() => ctx.sendEvent.mock.calls.some(
      ([channel, data]) => channel === "chat.event" && data?.event?.type === "prompt_done",
    ));
    expect(promptCalls).toHaveLength(0);

    const second = await send({ agentId: "a", userId: "u", text: "try again", sessionId: "S" }, ctx) as { turnId?: string };
    await waitFor(() => promptCalls.length === 1);
    expect(second.turnId).not.toBe(first.turnId);
    expect(promptCalls[0]).toMatchObject({ sessionId: "S", text: "try again", turnId: second.turnId });
  });

  it("surfaces a failed abort instead of reporting the Stop as done", async () => {
    // ok:true tells the control plane to stop retrying and tear down supervision.
    const manager = fakeAgentBoxManager();
    manager.getOrCreate.mockResolvedValue({ boxId: "box-a", endpoint: "https://fake.internal" });
    server = await bootRuntime(manager);
    const send = server.rpcMethods.get("chat.send")!;
    const abort = server.rpcMethods.get("chat.abort")!;

    await send({ agentId: "a", userId: "u", text: "hi", sessionId: "S" }, { sendEvent: vi.fn() });
    await waitFor(() => capturedSignal !== undefined);

    abortSessionError = new Error("box unreachable");
    await expect(abort({ agentId: "a", sessionId: "S" })).rejects.toThrow(/box unreachable/);
  });

  it("reports a delegated turn's terminal over an acknowledged RPC, and retries it", async () => {
    // The chat.event lane is fire-and-forget. A human-facing turn survives losing its
    // terminal (the frontend refetches); a delegated turn has a machine waiting on it
    // and nobody to retry, so the terminal gets an acknowledgement of its own.
    const frontendClient = fakeFrontendClient();
    let terminalAttempts = 0;
    frontendClient.request = vi.fn(async (method: string) => {
      if (method !== "delegation.terminal") return { found: false };
      terminalAttempts += 1;
      if (terminalAttempts === 1) throw new Error("write failed");
      return { ok: true };
    });

    server = await bootRuntime(fakeAgentBoxManager(), frontendClient);
    const send = server.rpcMethods.get("chat.send")!;
    const abort = server.rpcMethods.get("chat.abort")!;
    const ctx = { sendEvent: vi.fn() };

    const ack = await send({
      agentId: "a", userId: "u", text: "inspect", sessionId: "delegated",
      delegation: { delegationId: "d1", parentAgentId: "coord", readOnly: false },
    }, ctx) as { turnId?: string };
    await waitFor(() => capturedSignal !== undefined);
    await abort({ agentId: "a", sessionId: "delegated" });

    await waitFor(() => terminalAttempts >= 2);
    const call = frontendClient.request.mock.calls.find(([method]: any[]) => method === "delegation.terminal");
    expect(call?.[1]).toMatchObject({
      delegationId: "d1",
      sessionId: "delegated",
      turnId: ack.turnId,
      event: { type: "prompt_done" },
    });
  });

  it("does not ask for an acknowledgement on an ordinary turn", async () => {
    const frontendClient = fakeFrontendClient();
    server = await bootRuntime(fakeAgentBoxManager(), frontendClient);
    const send = server.rpcMethods.get("chat.send")!;
    const abort = server.rpcMethods.get("chat.abort")!;
    const ctx = { sendEvent: vi.fn() };

    await send({ agentId: "a", userId: "u", text: "hi", sessionId: "plain" }, ctx);
    await waitFor(() => capturedSignal !== undefined);
    await abort({ agentId: "a", sessionId: "plain" });
    await waitFor(() => ctx.sendEvent.mock.calls.some(
      ([channel, data]) => channel === "chat.event" && data?.event?.type === "prompt_done",
    ));

    expect(frontendClient.request.mock.calls.some(([method]: any[]) => method === "delegation.terminal")).toBe(false);
  });

  it("stops the RUNNING turn when a second send has already queued behind it", async () => {
    // The second send registers its turn before it can acquire the session lock, so
    // two turns are live at once: one on the box, one queued. Remembering only the
    // newest would make Stop name the queued turn, the box would reject the mismatch,
    // and the running turn would keep going with its consumer already torn down.
    server = await bootRuntime();
    const send = server.rpcMethods.get("chat.send")!;
    const abort = server.rpcMethods.get("chat.abort")!;

    const first = await send({ agentId: "a", userId: "u", text: "one", sessionId: "S" }, { sendEvent: vi.fn() }) as { turnId?: string };
    await waitFor(() => capturedSignal !== undefined);
    const second = await send({ agentId: "a", userId: "u", text: "two", sessionId: "S" }, { sendEvent: vi.fn() }) as { turnId?: string };
    expect(second.turnId).not.toBe(first.turnId);

    await expect(abort({ agentId: "a", sessionId: "S" })).resolves.toMatchObject({ ok: true });
    // Both were live when Stop arrived, so both are named; the box stops the one it
    // is running and answers the other as already stopped.
    expect(abortSessionTurnIds).toContain(first.turnId);
    expect(abortSessionTurnIds).toContain(second.turnId);
  });

  it("uses a caller-supplied turn id so a lost ack still leaves it nameable", async () => {
    // A supervisor that will have to abort this turn later fixes its id BEFORE
    // dispatch; learning it from the ack would leave the lost-ack case with nothing
    // to name, and its compensation would fall back to stopping the session.
    server = await bootRuntime();
    const send = server.rpcMethods.get("chat.send")!;
    const abort = server.rpcMethods.get("chat.abort")!;

    const ack = await send({
      agentId: "a", userId: "u", text: "hi", sessionId: "supplied", turnId: "chosen-by-caller",
    }, { sendEvent: vi.fn() }) as { turnId?: string };
    expect(ack.turnId).toBe("chosen-by-caller");
    await waitFor(() => promptCalls.length === 1);
    expect(promptCalls[0]).toMatchObject({ turnId: "chosen-by-caller" });

    await abort({ agentId: "a", sessionId: "supplied", turnId: "chosen-by-caller" });
    expect(abortSessionTurnIds).toEqual(["chosen-by-caller"]);
  });

  it("reports a supervisor-interrupted delegated turn with an acknowledgement", async () => {
    // Shutdown and box removal bypass the turn's own reporting, so without this the
    // one terminal a delegated caller cannot do without went out fire-and-forget on
    // exactly the path where the transport is about to disappear.
    const frontendClient = fakeFrontendClient();
    const terminals: any[] = [];
    frontendClient.request = vi.fn(async (method: string, params: any) => {
      if (method === "delegation.terminal") {
        terminals.push(params);
        return { ok: true };
      }
      return { found: false };
    });

    server = await bootRuntime(fakeAgentBoxManager(), frontendClient);
    const send = server.rpcMethods.get("chat.send")!;
    const ack = await send({
      agentId: "a", userId: "u", text: "inspect", sessionId: "interrupted",
      delegation: { delegationId: "d9", parentAgentId: "coord", readOnly: false },
    }, { sendEvent: vi.fn() }) as { turnId?: string };
    await waitFor(() => capturedSignal !== undefined);

    // Shutdown must settle the delivery BEFORE it closes the connection it needs.
    await server.close();
    server = undefined;

    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      delegationId: "d9",
      sessionId: "interrupted",
      turnId: ack.turnId,
      event: { type: "prompt_done", aborted: true, reason: "runtime_restart" },
    });
    expect(frontendClient.close).toHaveBeenCalled();
    expect(frontendClient.request.mock.invocationCallOrder[0])
      .toBeLessThan(frontendClient.close.mock.invocationCallOrder[0]);
  });

  it("does not touch the running turn's consumer when the abort names a queued turn", async () => {
    // Aborting the session's controllers here would break A's consumer while the box
    // is only told about B — A would keep running with nobody reading it.
    server = await bootRuntime();
    const send = server.rpcMethods.get("chat.send")!;
    const abort = server.rpcMethods.get("chat.abort")!;

    await send({ agentId: "a", userId: "u", text: "one", sessionId: "S" }, { sendEvent: vi.fn() });
    await waitFor(() => capturedSignal !== undefined);
    const runningSignal = capturedSignal!;
    const queued = await send({ agentId: "a", userId: "u", text: "two", sessionId: "S" }, { sendEvent: vi.fn() }) as { turnId?: string };

    await expect(abort({ agentId: "a", sessionId: "S", turnId: queued.turnId })).resolves.toMatchObject({ ok: true });
    expect(runningSignal.aborted).toBe(false);
    expect(abortSessionTurnIds).toEqual([queued.turnId]);
  });

  it("cancels every turn a supervisor reports as interrupted", async () => {
    // Reporting a queued turn as terminated while leaving it runnable would let it
    // start after its caller had already been told it was over.
    const manager = fakeAgentBoxManager();
    // A real placement reports its box, which is what makes the session lock
    // observable below.
    manager.getOrCreate.mockResolvedValue({ boxId: "box-a", endpoint: "https://fake.internal" });
    server = await bootRuntime(manager);
    const send = server.rpcMethods.get("chat.send")!;

    await send({ agentId: "a", userId: "u", text: "one", sessionId: "S" }, { sendEvent: vi.fn() });
    await waitFor(() => capturedSignal !== undefined);
    const ctx = { sendEvent: vi.fn() };
    await send({ agentId: "a", userId: "u", text: "two", sessionId: "S" }, ctx);

    await server.close();
    server = undefined;

    // This is a NEGATIVE property, so give the queued turn a real chance to misbehave
    // instead of sampling straight after close(): left runnable it takes the lock the
    // streaming turn just released and dispatches within milliseconds. Sampling
    // immediately, or waiting on the lock, both race that hand-off.
    const dispatched = await waitFor(() => promptCalls.length > 1, 500).then(() => true, () => false);
    expect(dispatched).toBe(false);
    expect(promptCalls).toHaveLength(1);
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
