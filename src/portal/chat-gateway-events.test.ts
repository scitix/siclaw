import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import jwt from "jsonwebtoken";
import { createRestRouter } from "../gateway/rest-router.js";
import { registerChatRoutes } from "./chat-gateway.js";

// The /events route authorizes via a chat_sessions ownership lookup. Mock the DB so each
// test controls what the session row looks like ([] = brand-new/none, [{user_id}] = owned).
// vi.hoisted so the (hoisted) vi.mock factory can reference the shared state.
const dbState = vi.hoisted(() => ({ sessionRows: [] as Array<{ user_id: string }> }));
vi.mock("../gateway/db.js", () => ({
  getDb: () => ({ query: async () => [dbState.sessionRows] }),
}));
beforeEach(() => { dbState.sessionRows = []; });

/**
 * Focused tests for the persistent per-session SSE endpoint
 *   GET /api/v1/siclaw/agents/:id/chat/sessions/:sessionId/events
 * which delivers server-pushed turns (e.g. a background job's completion) to an idle
 * frontend. Auth is via ?token= (EventSource can't set headers); the stream stays open
 * (it must NOT close on prompt_done) and forwards chat.event filtered by sessionId.
 */

const SECRET = "test-secret";
const EVENTS_PATH = "/api/v1/siclaw/agents/a1/chat/sessions/s1/events";

function fakeReq(url: string): any {
  const req = new EventEmitter() as any;
  req.method = "GET";
  req.url = url;
  req.headers = {};
  return req;
}

function fakeRes(): any {
  const writes: string[] = [];
  return {
    writes,
    statusCode: 0,
    headers: null as Record<string, string> | null,
    writableEnded: false,
    destroyed: false,
    socket: { setNoDelay: vi.fn() },
    on() { return this; }, // res 'close'/'error' cleanup hooks — no-op in tests
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers ?? null;
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end(body?: string) {
      if (body) writes.push(body);
      this.writableEnded = true;
    },
  };
}

function fakeConnectionMap() {
  let captured: ((data: unknown) => void) | null = null;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((_agentId: string, _channel: string, cb: (d: unknown) => void) => {
    captured = cb;
    return unsubscribe;
  });
  return { subscribe, unsubscribe, push: (d: unknown) => captured?.(d) } as any;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("chat-gateway SSE events endpoint", () => {
  it("rejects with 401 when no token is supplied", async () => {
    const router = createRestRouter();
    const cm = fakeConnectionMap();
    registerChatRoutes(router, cm, SECRET);

    const req = fakeReq(EVENTS_PATH);
    const res = fakeRes();
    expect(router.handle(req, res)).toBe(true);
    await tick();

    expect(res.statusCode).toBe(401);
    expect(cm.subscribe).not.toHaveBeenCalled();
  });

  it("rejects with 401 when the token is invalid", async () => {
    const router = createRestRouter();
    const cm = fakeConnectionMap();
    registerChatRoutes(router, cm, SECRET);

    const req = fakeReq(`${EVENTS_PATH}?token=not-a-jwt`);
    const res = fakeRes();
    router.handle(req, res);
    await tick();

    expect(res.statusCode).toBe(401);
    expect(cm.subscribe).not.toHaveBeenCalled();
  });

  it("rejects with 403 when the session is owned by another user", async () => {
    const router = createRestRouter();
    const cm = fakeConnectionMap();
    registerChatRoutes(router, cm, SECRET);

    dbState.sessionRows = [{ user_id: "someone-else" }]; // session exists, owned by another tenant
    const token = jwt.sign({ sub: "u1" }, SECRET);
    const req = fakeReq(`${EVENTS_PATH}?token=${token}`);
    const res = fakeRes();
    router.handle(req, res);
    await tick();

    expect(res.statusCode).toBe(403);
    expect(cm.subscribe).not.toHaveBeenCalled();
  });

  it("allows when the session is owned by the caller", async () => {
    const router = createRestRouter();
    const cm = fakeConnectionMap();
    registerChatRoutes(router, cm, SECRET);

    dbState.sessionRows = [{ user_id: "u1" }];
    const token = jwt.sign({ sub: "u1" }, SECRET);
    const req = fakeReq(`${EVENTS_PATH}?token=${token}`);
    const res = fakeRes();
    router.handle(req, res);
    await tick();

    expect(res.statusCode).toBe(200);
    expect(cm.subscribe).toHaveBeenCalledTimes(1);
    req.emit("close");
  });

  it("opens an SSE stream and forwards chat.event filtered by sessionId", async () => {
    const router = createRestRouter();
    const cm = fakeConnectionMap();
    registerChatRoutes(router, cm, SECRET);

    const token = jwt.sign({ sub: "u1" }, SECRET);
    const req = fakeReq(`${EVENTS_PATH}?token=${token}`);
    const res = fakeRes();
    router.handle(req, res);
    await tick();

    // SSE headers + subscription established.
    expect(res.statusCode).toBe(200);
    expect(res.headers?.["Content-Type"]).toBe("text/event-stream");
    expect(cm.subscribe).toHaveBeenCalledTimes(1);
    expect(cm.subscribe.mock.calls[0][1]).toBe("chat.event");

    // An event for THIS session is forwarded.
    cm.push({ sessionId: "s1", event: { type: "background_turn_done", sessionId: "s1" } });
    const forwarded = res.writes.filter((w: string) => w.startsWith("event: chat.event"));
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toContain("background_turn_done");

    // An event for a DIFFERENT session is filtered out.
    cm.push({ sessionId: "other", event: { type: "background_turn_done", sessionId: "other" } });
    expect(res.writes.filter((w: string) => w.startsWith("event: chat.event"))).toHaveLength(1);

    // Closing the request unsubscribes (no leak).
    req.emit("close");
    expect(cm.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does NOT close the stream on prompt_done (unlike /send)", async () => {
    const router = createRestRouter();
    const cm = fakeConnectionMap();
    registerChatRoutes(router, cm, SECRET);

    const token = jwt.sign({ sub: "u1" }, SECRET);
    const req = fakeReq(`${EVENTS_PATH}?token=${token}`);
    const res = fakeRes();
    router.handle(req, res);
    await tick();

    cm.push({ sessionId: "s1", event: { type: "prompt_done" } });
    expect(res.writableEnded).toBe(false); // stream stays open for later async turns

    req.emit("close");
  });
});
