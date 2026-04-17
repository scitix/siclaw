import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ErrorCode,
  RpcError,
  errorShape,
  parseFrame,
  sendResponse,
  buildEvent,
  resetSeq,
  createBroadcaster,
  dispatchRpc,
  MAX_BUFFERED_BYTES,
  type RpcHandler,
  type WsRequest,
} from "./ws-protocol.js";
import type { WebSocket } from "ws";

// ── Fake WS ───────────────────────────────────────────────────

interface FakeWs {
  OPEN: number;
  CLOSED: number;
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  send(frame: string): void;
}

function makeWs(overrides: Partial<FakeWs> = {}): FakeWs & WebSocket {
  const ws: FakeWs = {
    OPEN: 1,
    CLOSED: 3,
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(frame: string) { this.sent.push(frame); },
    ...overrides,
  };
  return ws as unknown as FakeWs & WebSocket;
}

// ── ErrorCode + RpcError + errorShape ─────────────────────────

describe("errorShape / RpcError / ErrorCode", () => {
  it("errorShape spreads optional fields", () => {
    expect(errorShape("X", "msg")).toEqual({ code: "X", message: "msg" });
    expect(errorShape("Y", "m", { retryable: true, retryAfterMs: 100 })).toEqual({
      code: "Y", message: "m", retryable: true, retryAfterMs: 100,
    });
  });

  it("RpcError carries code/retryable/retryAfterMs", () => {
    const err = new RpcError("RATE_LIMITED", "slow down", true, 2000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RpcError");
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(2000);
  });

  it("ErrorCode enum has the documented values", () => {
    expect(ErrorCode.UNAUTHORIZED).toBe("UNAUTHORIZED");
    expect(ErrorCode.FORBIDDEN).toBe("FORBIDDEN");
    expect(ErrorCode.NOT_FOUND).toBe("NOT_FOUND");
    expect(ErrorCode.INVALID_REQUEST).toBe("INVALID_REQUEST");
    expect(ErrorCode.AGENT_TIMEOUT).toBe("AGENT_TIMEOUT");
    expect(ErrorCode.INTERNAL).toBe("INTERNAL");
  });
});

// ── parseFrame ────────────────────────────────────────────────

describe("parseFrame", () => {
  it("returns the request when type=req and required fields present", () => {
    const frame = JSON.stringify({ type: "req", id: "a1", method: "cfg.get", params: { k: 1 } });
    expect(parseFrame(frame)).toEqual({ type: "req", id: "a1", method: "cfg.get", params: { k: 1 } });
  });
  it("returns null for malformed JSON", () => {
    expect(parseFrame("not-json")).toBeNull();
  });
  it("returns null when type is not 'req'", () => {
    expect(parseFrame(JSON.stringify({ type: "event", id: "x", method: "m" }))).toBeNull();
  });
  it("returns null when id is missing", () => {
    expect(parseFrame(JSON.stringify({ type: "req", method: "m" }))).toBeNull();
  });
  it("returns null when method is missing", () => {
    expect(parseFrame(JSON.stringify({ type: "req", id: "x" }))).toBeNull();
  });
});

// ── sendResponse ──────────────────────────────────────────────

describe("sendResponse", () => {
  it("sends success response with payload", () => {
    const ws = makeWs();
    sendResponse(ws, "id-1", true, { ok: 1 });
    expect(ws.sent).toHaveLength(1);
    const parsed = JSON.parse(ws.sent[0]);
    expect(parsed).toEqual({ type: "res", id: "id-1", ok: true, payload: { ok: 1 } });
  });

  it("sends error response with error shape", () => {
    const ws = makeWs();
    sendResponse(ws, "id-2", false, undefined, errorShape("X", "bad"));
    const parsed = JSON.parse(ws.sent[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toEqual({ code: "X", message: "bad" });
  });

  it("omits payload and error when not supplied", () => {
    const ws = makeWs();
    sendResponse(ws, "id-3", true);
    const parsed = JSON.parse(ws.sent[0]);
    expect(parsed.payload).toBeUndefined();
    expect(parsed.error).toBeUndefined();
  });
});

// ── buildEvent / resetSeq ─────────────────────────────────────

describe("buildEvent + resetSeq", () => {
  beforeEach(() => { resetSeq(); });

  it("assigns monotonically increasing seq starting from 1", () => {
    const a = JSON.parse(buildEvent("e.one", { n: 1 }));
    const b = JSON.parse(buildEvent("e.two", { n: 2 }));
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.type).toBe("event");
    expect(a.event).toBe("e.one");
    expect(a.payload).toEqual({ n: 1 });
  });

  it("resetSeq rewinds the counter", () => {
    buildEvent("x", {});
    buildEvent("x", {});
    resetSeq();
    const f = JSON.parse(buildEvent("x", { n: 0 }));
    expect(f.seq).toBe(1);
  });
});

// ── createBroadcaster ─────────────────────────────────────────

describe("createBroadcaster", () => {
  beforeEach(() => { resetSeq(); });

  it("broadcasts to all OPEN clients", () => {
    const a = makeWs();
    const b = makeWs();
    const clients = new Set<WebSocket>([a as unknown as WebSocket, b as unknown as WebSocket]);
    const broadcast = createBroadcaster(clients);
    broadcast("ping", { t: 1 });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it("skips clients that aren't OPEN", () => {
    const open = makeWs();
    const closed = makeWs({ readyState: 3 });
    const clients = new Set<WebSocket>([open as unknown as WebSocket, closed as unknown as WebSocket]);
    const broadcast = createBroadcaster(clients);
    broadcast("e", {});
    expect(open.sent).toHaveLength(1);
    expect(closed.sent).toHaveLength(0);
  });

  it("skips clients whose buffered amount exceeds MAX_BUFFERED_BYTES (backpressure)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const slow = makeWs({ bufferedAmount: MAX_BUFFERED_BYTES + 1 });
    const ok = makeWs();
    const broadcast = createBroadcaster(
      new Set<WebSocket>([slow as unknown as WebSocket, ok as unknown as WebSocket]),
    );
    broadcast("e", {});
    expect(slow.sent).toHaveLength(0);
    expect(ok.sent).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ── dispatchRpc ───────────────────────────────────────────────

describe("dispatchRpc", () => {
  beforeEach(() => { resetSeq(); });

  it("calls handler and sends success response with its result", async () => {
    const ws = makeWs();
    const handlers = new Map<string, RpcHandler>();
    handlers.set("cfg.get", async (params) => ({ got: params }));
    const req: WsRequest = { type: "req", id: "1", method: "cfg.get", params: { k: 2 } };
    await dispatchRpc(handlers, req, ws as unknown as WebSocket, { sendEvent: () => {} });
    const parsed = JSON.parse(ws.sent[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.payload).toEqual({ got: { k: 2 } });
  });

  it("responds INVALID_REQUEST when method is unknown", async () => {
    const ws = makeWs();
    await dispatchRpc(new Map(), { type: "req", id: "1", method: "x" }, ws as unknown as WebSocket, { sendEvent: () => {} });
    const parsed = JSON.parse(ws.sent[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe(ErrorCode.INVALID_REQUEST);
    expect(parsed.error.message).toMatch(/Unknown method/);
  });

  it("classifies handler errors by message content", async () => {
    const ws = makeWs();
    const handlers = new Map<string, RpcHandler>();
    handlers.set("m", async () => { throw new Error("not found: x"); });
    await dispatchRpc(handlers, { type: "req", id: "1", method: "m" }, ws as unknown as WebSocket, { sendEvent: () => {} });
    const parsed = JSON.parse(ws.sent[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("maps 'Unauthorized' → UNAUTHORIZED, 'Forbidden' → FORBIDDEN, 'timed out' → AGENT_TIMEOUT", async () => {
    async function dispatch(msg: string) {
      const ws = makeWs();
      const handlers = new Map<string, RpcHandler>();
      handlers.set("m", async () => { throw new Error(msg); });
      await dispatchRpc(handlers, { type: "req", id: "1", method: "m" }, ws as unknown as WebSocket, { sendEvent: () => {} });
      return JSON.parse(ws.sent[0]).error.code;
    }
    expect(await dispatch("Unauthorized")).toBe(ErrorCode.UNAUTHORIZED);
    expect(await dispatch("Forbidden")).toBe(ErrorCode.FORBIDDEN);
    expect(await dispatch("timed out after 5000ms")).toBe(ErrorCode.AGENT_TIMEOUT);
    expect(await dispatch("something weird")).toBe(ErrorCode.INTERNAL);
  });

  it("preserves RpcError code and retry metadata", async () => {
    const ws = makeWs();
    const handlers = new Map<string, RpcHandler>();
    handlers.set("m", async () => { throw new RpcError("RATE_LIMITED", "slow", true, 1000); });
    await dispatchRpc(handlers, { type: "req", id: "1", method: "m" }, ws as unknown as WebSocket, { sendEvent: () => {} });
    const parsed = JSON.parse(ws.sent[0]);
    expect(parsed.error.code).toBe("RATE_LIMITED");
    expect(parsed.error.retryable).toBe(true);
    expect(parsed.error.retryAfterMs).toBe(1000);
  });

  it("passes empty params object when request has none", async () => {
    const ws = makeWs();
    let seen: unknown = null;
    const handlers = new Map<string, RpcHandler>();
    handlers.set("m", async (params) => { seen = params; return 1; });
    await dispatchRpc(handlers, { type: "req", id: "1", method: "m" }, ws as unknown as WebSocket, { sendEvent: () => {} });
    expect(seen).toEqual({});
  });
});
