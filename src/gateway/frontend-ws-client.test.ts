import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { FrontendWsClientOptions } from "./frontend-ws-client.js";

// ── Mock WebSocket ──────────────────────────────────────────

/**
 * Fake WebSocket class that mimics the `ws` library interface.
 * Backed by EventEmitter so we can simulate open/close/message/error.
 */
class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  _sent: string[] = [];

  constructor(
    public _url: string,
    public _options: any,
  ) {
    super();
    // Simulate async open — caller triggers it explicitly in tests.
  }

  send(data: string): void {
    this._sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  removeAllListeners(): this {
    super.removeAllListeners();
    return this;
  }
}

/** Track all FakeWebSocket instances created during a test. */
let wsInstances: FakeWebSocket[] = [];

// ── Module mocking ──────────────────────────────────────────

vi.mock("ws", () => {
  return {
    default: class MockWS extends FakeWebSocket {
      constructor(url: string, options: any) {
        super(url, options);
        wsInstances.push(this);
      }
    },
    __esModule: true,
  };
});

// ── Helpers ─────────────────────────────────────────────────

const defaultOpts: FrontendWsClientOptions = {
  serverUrl: "http://portal:3003",
  portalSecret: "test-secret",
  agentId: "agent-42",
  timeoutMs: 500,
};

/** Import the client after mocking ws */
async function createClient(opts?: Partial<FrontendWsClientOptions>) {
  const { FrontendWsClient } = await import("./frontend-ws-client.js");
  return new FrontendWsClient({ ...defaultOpts, ...opts });
}

/** Simulate the WS connection opening. */
function openLatestWs(): FakeWebSocket {
  const ws = wsInstances[wsInstances.length - 1];
  ws.emit("open");
  return ws;
}

// ── Tests ───────────────────────────────────────────────────

describe("FrontendWsClient", () => {
  beforeEach(() => {
    wsInstances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── 1. connected is false before connect ──────────────────

  it("connected is false before connect", async () => {
    const client = await createClient();
    expect(client.connected).toBe(false);
    client.close();
  });

  // ── 2. request() throws when not connected ────────────────

  it("request() throws when not connected", async () => {
    const client = await createClient();
    await expect(client.request("test.method")).rejects.toThrow("not connected");
    client.close();
  });

  // ── 3. request() resolves when response received ──────────

  it("request() resolves when response received", async () => {
    const client = await createClient();

    const connectPromise = client.connect();
    const ws = openLatestWs();
    await connectPromise;

    expect(client.connected).toBe(true);

    const requestPromise = client.request("config.getSettings", { agentId: "a" });

    // Extract the sent frame to get the RPC id
    expect(ws._sent).toHaveLength(1);
    const frame = JSON.parse(ws._sent[0]);
    expect(frame.type).toBe("req");
    expect(frame.method).toBe("config.getSettings");
    expect(frame.params).toEqual({ agentId: "a" });

    // Simulate Portal responding
    ws.emit("message", JSON.stringify({
      type: "res",
      id: frame.id,
      ok: true,
      payload: { model: "gpt-4" },
    }));

    const result = await requestPromise;
    expect(result).toEqual({ model: "gpt-4" });

    client.close();
  });

  // ── 4. request() rejects on timeout ───────────────────────

  it("request() rejects on timeout", async () => {
    const client = await createClient({ timeoutMs: 200 });

    const connectPromise = client.connect();
    openLatestWs();
    await connectPromise;

    const requestPromise = client.request("slow.method");

    // Advance time past the timeout
    vi.advanceTimersByTime(300);

    await expect(requestPromise).rejects.toThrow("timed out");

    client.close();
  });

  // ── 5. onCommand() dispatches and sends response ──────────

  it("onCommand() dispatches inbound command and sends response", async () => {
    const client = await createClient();

    client.onCommand(async (method, params) => {
      if (method === "chat.send") {
        return { received: true, echo: params.msg };
      }
      throw new Error("Unknown command");
    });

    const connectPromise = client.connect();
    const ws = openLatestWs();
    await connectPromise;

    // Simulate Portal sending a command to Runtime
    ws.emit("message", JSON.stringify({
      type: "req",
      id: "cmd-1",
      method: "chat.send",
      params: { msg: "hello" },
    }));

    // Give the async handler time to run
    await vi.advanceTimersByTimeAsync(0);

    // Check the response was sent back
    // ws._sent[0] might be from other calls; find the response
    const responses = ws._sent.map((s) => JSON.parse(s));
    const cmdResponse = responses.find((r) => r.type === "res" && r.id === "cmd-1");
    expect(cmdResponse).toBeDefined();
    expect(cmdResponse.ok).toBe(true);
    expect(cmdResponse.payload).toEqual({ received: true, echo: "hello" });

    client.close();
  });

  it("onCommand() sends error response when handler throws", async () => {
    const client = await createClient();

    client.onCommand(async () => {
      throw new Error("handler boom");
    });

    const connectPromise = client.connect();
    const ws = openLatestWs();
    await connectPromise;

    ws.emit("message", JSON.stringify({
      type: "req",
      id: "cmd-err",
      method: "fail.method",
      params: {},
    }));

    await vi.advanceTimersByTimeAsync(0);

    const responses = ws._sent.map((s) => JSON.parse(s));
    const cmdResponse = responses.find((r) => r.type === "res" && r.id === "cmd-err");
    expect(cmdResponse).toBeDefined();
    expect(cmdResponse.ok).toBe(false);
    expect(cmdResponse.error).toContain("handler boom");

    client.close();
  });

  // ── 6. emitEvent() sends event frame ──────────────────────

  it("emitEvent() sends event frame", async () => {
    const client = await createClient();

    const connectPromise = client.connect();
    const ws = openLatestWs();
    await connectPromise;

    client.emitEvent("chat.stream", { chunk: "hello" });

    expect(ws._sent).toHaveLength(1);
    const frame = JSON.parse(ws._sent[0]);
    expect(frame.type).toBe("event");
    expect(frame.channel).toBe("chat.stream");
    expect(frame.data).toEqual({ chunk: "hello" });

    client.close();
  });

  it("emitEvent() does nothing when not connected", async () => {
    const client = await createClient();
    // Should not throw
    client.emitEvent("chat.stream", { chunk: "hello" });
    client.close();
  });

  // ── 7. Auto-reconnect on disconnect ───────────────────────

  it("schedules reconnect on close", async () => {
    const client = await createClient();

    const connectPromise = client.connect();
    const ws = openLatestWs();
    await connectPromise;

    expect(client.connected).toBe(true);

    // Simulate disconnect
    ws.emit("close");
    expect(client.connected).toBe(false);

    // Advance past reconnect delay (base 1s + up to 2s jitter)
    vi.advanceTimersByTime(4_000);

    // A new WS instance should have been created for the reconnect attempt
    expect(wsInstances.length).toBeGreaterThanOrEqual(2);

    client.close();
  });

  it("does not reconnect after close()", async () => {
    const client = await createClient();

    const connectPromise = client.connect();
    const ws = openLatestWs();
    await connectPromise;

    const instanceCount = wsInstances.length;

    client.close();

    // Simulate disconnect (after close was called)
    ws.emit("close");

    vi.advanceTimersByTime(60_000);

    // No new WS instances should have been created
    expect(wsInstances.length).toBe(instanceCount);
  });

  // ── URL conversion ────────────────────────────────────────

  it("converts http:// to ws:// in URL", async () => {
    const client = await createClient({ serverUrl: "http://portal:3003" });
    const connectPromise = client.connect();
    const ws = wsInstances[wsInstances.length - 1];
    expect(ws._url).toBe("ws://portal:3003/ws/runtime");
    ws.emit("open");
    await connectPromise;
    client.close();
  });

  it("converts https:// to wss:// in URL", async () => {
    const client = await createClient({ serverUrl: "https://portal:3003" });
    const connectPromise = client.connect();
    const ws = wsInstances[wsInstances.length - 1];
    expect(ws._url).toBe("wss://portal:3003/ws/runtime");
    ws.emit("open");
    await connectPromise;
    client.close();
  });

  it("passes auth headers to WebSocket constructor", async () => {
    const client = await createClient({
      portalSecret: "my-secret",
      agentId: "agent-99",
    });
    const connectPromise = client.connect();
    const ws = wsInstances[wsInstances.length - 1];
    expect(ws._options.headers["X-Auth-Token"]).toBe("my-secret");
    expect(ws._options.headers["X-Agent-Id"]).toBe("agent-99");
    ws.emit("open");
    await connectPromise;
    client.close();
  });

  // ── RPC error response ────────────────────────────────────

  it("request() rejects when response has ok=false", async () => {
    const client = await createClient();

    const connectPromise = client.connect();
    const ws = openLatestWs();
    await connectPromise;

    const requestPromise = client.request("bad.method");

    const frame = JSON.parse(ws._sent[0]);
    ws.emit("message", JSON.stringify({
      type: "res",
      id: frame.id,
      ok: false,
      error: "not found",
    }));

    await expect(requestPromise).rejects.toThrow("not found");

    client.close();
  });

  // ── close() rejects pending RPCs ─────────────────────────────

  it("close() rejects all pending RPCs", async () => {
    const client = await createClient();

    const connectPromise = client.connect();
    openLatestWs();
    await connectPromise;

    // Send two requests but don't simulate any response
    const p1 = client.request("method.one");
    const p2 = client.request("method.two");

    // Close before any response arrives
    client.close();

    await expect(p1).rejects.toThrow("closed");
    await expect(p2).rejects.toThrow("closed");
  });
});
