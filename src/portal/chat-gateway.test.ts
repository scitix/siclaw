import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import { createRestRouter } from "../gateway/rest-router.js";
import { signToken } from "./auth.js";
import { registerChatRoutes } from "./chat-gateway.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";

const JWT_SECRET = "test-chat-secret";
const USER_TOKEN = signToken("u1", "alice", "user", JWT_SECRET);

function fakeReq(opts: { url: string; method: string; headers?: Record<string, string>; body?: unknown }): any {
  const em = new EventEmitter() as any;
  em.url = opts.url;
  em.method = opts.method;
  em.headers = { ...(opts.headers ?? {}) };
  const originalOn = em.on.bind(em);
  em.on = (ev: string, listener: any) => {
    originalOn(ev, listener);
    if (ev === "data" && !em._emitted) {
      em._emitted = true;
      setImmediate(() => {
        if (opts.body !== undefined) em.emit("data", Buffer.from(JSON.stringify(opts.body)));
        em.emit("end");
      });
    }
    return em;
  };
  return em;
}

function fakeRes() {
  const r: any = new EventEmitter();
  r._status = 0;
  r._body = null;
  r._chunks = [] as string[];
  r.headersSent = false;
  r.writableEnded = false;
  r.destroyed = false;
  r.writeHead = vi.fn((s: number, h?: any) => { r._status = s; r._headers = h; r.headersSent = true; return r; });
  r.write = vi.fn((chunk: string) => { r._chunks.push(chunk); return true; });
  r.end = vi.fn((body?: string) => { r._body = body; r.writableEnded = true; r.emit("finish"); return r; });
  return r;
}

function runRoute(router: ReturnType<typeof createRestRouter>, req: any, res?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const r = res ?? fakeRes();
    r.on("finish", () => resolve(r));
    const origEnd = r.end;
    r.end = (body?: string) => { origEnd.call(r, body); resolve(r); return r; };
    try { if (!router.handle(req, r)) reject(new Error("no route")); } catch (err) { reject(err); }
  });
}

function makeConnMap(overrides: Partial<RuntimeConnectionMap> = {}): RuntimeConnectionMap {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    sendCommand: vi.fn().mockResolvedValue({ ok: true, payload: {} }),
    notify: vi.fn(),
    notifyMany: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    connectedAgentIds: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("chat-gateway routes", () => {
  let router: ReturnType<typeof createRestRouter>;
  let connMap: RuntimeConnectionMap;
  let query: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router = createRestRouter();
    connMap = makeConnMap();
    registerChatRoutes(router, connMap, JWT_SECRET);
    query = vi.fn();
    (getDb as any).mockReturnValue({ query });
  });

  // ── chat.send ────────────────────────────────────────────
  describe("POST /api/v1/siclaw/agents/:id/chat/send", () => {
    it("returns 401 without auth", async () => {
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/send",
        method: "POST",
        body: { text: "hi" },
      }));
      expect(res._status).toBe(401);
    });

    it("returns 400 without text", async () => {
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/send",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: {},
      }));
      expect(res._status).toBe(400);
    });

    it("returns 503 when runtime not connected", async () => {
      connMap.isConnected = vi.fn().mockReturnValue(false);
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/send",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: { text: "hi" },
      }));
      expect(res._status).toBe(503);
    });

    it("returns 400 when agent has no model configured", async () => {
      // resolveAgentModelBinding queries agents row → returns undefined model_provider
      query.mockResolvedValueOnce([[{ model_provider: null, model_id: null }], []]);
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/send",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: { text: "hi" },
      }));
      expect(res._status).toBe(400);
    });

    it("returns 400 when provider row is missing", async () => {
      query
        .mockResolvedValueOnce([[{ model_provider: "openai", model_id: "gpt-4" }], []])
        .mockResolvedValueOnce([[], []]);  // provider lookup empty
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/send",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: { text: "hi" },
      }));
      expect(res._status).toBe(400);
    });

    it("opens SSE stream and sends chat.send command when model is configured", async () => {
      query
        .mockResolvedValueOnce([[{ model_provider: "openai", model_id: "gpt-4" }], []])
        .mockResolvedValueOnce([[{ id: "p1", name: "openai", base_url: "u", api_key: "k", api_type: "openai" }], []])
        .mockResolvedValueOnce([[{ model_id: "gpt-4", name: "GPT-4", reasoning: 0, context_window: 128000, max_tokens: 4096 }], []]);

      const res = fakeRes();
      const req = fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/send",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: { text: "hi", session_id: "s1" },
      });

      router.handle(req, res);

      // Wait for async chain
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      expect(res._status).toBe(200);
      expect(res._headers["Content-Type"]).toBe("text/event-stream");
      expect(connMap.sendCommand).toHaveBeenCalledWith("a1", "chat.send", expect.objectContaining({
        agentId: "a1",
        userId: "u1",
        text: "hi",
        sessionId: "s1",
      }));
    });
  });

  // ── chat.steer ───────────────────────────────────────────
  describe("POST /api/v1/siclaw/agents/:id/chat/steer", () => {
    it("returns 401 without auth", async () => {
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/steer",
        method: "POST",
        body: { session_id: "s1", text: "x" },
      }));
      expect(res._status).toBe(401);
    });

    it("returns 400 without required fields", async () => {
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/steer",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: {},
      }));
      expect(res._status).toBe(400);
    });

    it("forwards to runtime and returns 200 on ok", async () => {
      connMap.sendCommand = vi.fn().mockResolvedValue({ ok: true });
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/steer",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: { session_id: "s1", text: "redirect" },
      }));
      expect(res._status).toBe(200);
      expect(connMap.sendCommand).toHaveBeenCalledWith("a1", "chat.steer", expect.objectContaining({
        sessionId: "s1", text: "redirect",
      }));
    });

    it("returns 502 when runtime RPC fails", async () => {
      connMap.sendCommand = vi.fn().mockResolvedValue({ ok: false, error: "nope" });
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/steer",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: { session_id: "s1", text: "x" },
      }));
      expect(res._status).toBe(502);
    });
  });

  // ── chat.abort ───────────────────────────────────────────
  describe("POST /api/v1/siclaw/agents/:id/chat/abort", () => {
    it("returns 400 without session_id", async () => {
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/abort",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: {},
      }));
      expect(res._status).toBe(400);
    });

    it("forwards abort command", async () => {
      await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/abort",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: { session_id: "s1" },
      }));
      expect(connMap.sendCommand).toHaveBeenCalledWith("a1", "chat.abort", expect.objectContaining({ sessionId: "s1" }));
    });
  });

  // ── chat.clearQueue ──────────────────────────────────────
  describe("POST /api/v1/siclaw/agents/:id/chat/clear-queue", () => {
    it("returns 400 without session_id", async () => {
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/clear-queue",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: {},
      }));
      expect(res._status).toBe(400);
    });

    it("forwards clearQueue command", async () => {
      await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/clear-queue",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: { session_id: "s1" },
      }));
      expect(connMap.sendCommand).toHaveBeenCalledWith("a1", "chat.clearQueue", expect.any(Object));
    });
  });

  // ── clearMemory ──────────────────────────────────────────
  describe("POST /api/v1/siclaw/agents/:id/clear-memory", () => {
    it("returns 401 without auth", async () => {
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/clear-memory",
        method: "POST",
        body: {},
      }));
      expect(res._status).toBe(401);
    });

    it("forwards agent.clearMemory command", async () => {
      await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/clear-memory",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: {},
      }));
      expect(connMap.sendCommand).toHaveBeenCalledWith("a1", "agent.clearMemory", expect.objectContaining({ userId: "u1" }));
    });
  });

  // ── /api/v1/run (API key) ────────────────────────────────
  describe("POST /api/v1/run", () => {
    it("returns 401 when Authorization header missing", async () => {
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/run",
        method: "POST",
        body: { text: "x" },
      }));
      expect(res._status).toBe(401);
    });

    it("returns 401 when API key not found", async () => {
      query.mockResolvedValueOnce([[], []]);
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/run",
        method: "POST",
        headers: { authorization: "Bearer sk-deadbeef" },
        body: { text: "x" },
      }));
      expect(res._status).toBe(401);
    });

    it("returns 401 when API key is expired", async () => {
      const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      query.mockResolvedValueOnce([[
        { id: "k1", agent_id: "a1", name: "key", expires_at: yesterday, created_by: "u1" },
      ], []]);
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/run",
        method: "POST",
        headers: { authorization: "Bearer sk-abcd" },
        body: { text: "x" },
      }));
      expect(res._status).toBe(401);
    });

    it("returns 400 without text", async () => {
      // Valid API key
      query
        .mockResolvedValueOnce([[
          { id: "k1", agent_id: "a1", name: "key", expires_at: null, created_by: "u1" },
        ], []]);
      // last_used_at update is fire-and-forget; mock its query too so it doesn't error
      query.mockResolvedValueOnce([undefined, []]);

      const res = await runRoute(router, fakeReq({
        url: "/api/v1/run",
        method: "POST",
        headers: { authorization: "Bearer sk-abcd" },
        body: {},
      }));
      expect(res._status).toBe(400);
    });

    it("returns 503 when runtime disconnected", async () => {
      connMap.isConnected = vi.fn().mockReturnValue(false);
      query
        .mockResolvedValueOnce([[
          { id: "k1", agent_id: "a1", name: "key", expires_at: null, created_by: "u1" },
        ], []])
        .mockResolvedValueOnce([undefined, []]);

      const res = await runRoute(router, fakeReq({
        url: "/api/v1/run",
        method: "POST",
        headers: { authorization: "Bearer sk-abcd" },
        body: { text: "x" },
      }));
      expect(res._status).toBe(503);
    });

    it("accepts non-sk-prefixed Bearer tokens as unauthenticated", async () => {
      const res = await runRoute(router, fakeReq({
        url: "/api/v1/run",
        method: "POST",
        headers: { authorization: "Bearer not-an-sk-key" },
        body: { text: "hi" },
      }));
      expect(res._status).toBe(401);
    });
  });
});
