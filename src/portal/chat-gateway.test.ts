import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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
        .mockResolvedValueOnce([[{ model_provider: "openai", model_id: "gpt-4", system_prompt: "You are an ops bot." }], []])
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
        systemPrompt: "You are an ops bot.",
      }));
    });

    it("forwards agent modelRouting to Runtime chat.send", async () => {
      query
        .mockResolvedValueOnce([[{
          model_provider: "openai",
          model_id: "gpt-4",
          model_routing: JSON.stringify({
            enabled: true,
            candidates: [{ provider: "anthropic", modelId: "claude" }],
          }),
        }], []])
        .mockResolvedValueOnce([[{ id: "p1", name: "openai", base_url: "u", api_key: "k", api_type: "openai" }], []])
        .mockResolvedValueOnce([[{ model_id: "gpt-4", name: "GPT-4", reasoning: 0, context_window: 128000, max_tokens: 4096 }], []])
        .mockResolvedValueOnce([[{ id: "p1", name: "openai", base_url: "u", api_key: "k", api_type: "openai" }], []])
        .mockResolvedValueOnce([[{ model_id: "gpt-4", name: "GPT-4", reasoning: 0, context_window: 128000, max_tokens: 4096 }], []])
        .mockResolvedValueOnce([[{ id: "p2", name: "anthropic", base_url: "a", api_key: "ak", api_type: "anthropic" }], []])
        .mockResolvedValueOnce([[{ model_id: "claude", name: "Claude", reasoning: 1, context_window: 200000, max_tokens: 8192 }], []]);

      const res = fakeRes();
      const req = fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/send",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: { text: "hi", session_id: "s1" },
      });

      router.handle(req, res);

      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      const command = (connMap.sendCommand as any).mock.calls[0][2];
      expect(command.modelRouting.candidates).toEqual([
        expect.objectContaining({ provider: "openai", modelId: "gpt-4" }),
        expect.objectContaining({ provider: "anthropic", modelId: "claude" }),
      ]);
      expect(command.modelRouting.candidates[1].modelConfig.apiKey).toBe("ak");
    });

    it("calls OCR backend for chat attachments and forwards extracted evidence", async () => {
      vi.stubEnv("SICLAW_OCR_BACKEND_URL", "http://siclaw-ocr-backend:8088/parse");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          kind: "terminal",
          language: "en",
          route: "text",
          confidence: 0.93,
          text: "kubectl get pods\npod-a Running",
          warnings: [],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);
      query
        .mockResolvedValueOnce([[{ model_provider: "openai", model_id: "gpt-4" }], []])
        .mockResolvedValueOnce([[{ id: "p1", name: "openai", base_url: "u", api_key: "k", api_type: "openai" }], []])
        .mockResolvedValueOnce([[{ model_id: "gpt-4", name: "GPT-4", reasoning: 0, context_window: 128000, max_tokens: 4096 }], []]);

      const res = fakeRes();
      const req = fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/send",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: {
          text: "这个终端截图是什么问题",
          session_id: "s1",
          attachments: [{
            kind: "image",
            filename: "terminal.png",
            mimeType: "image/png",
            data: "aGVsbG8=",
          }],
        },
      });

      router.handle(req, res);

      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      expect(fetchMock).toHaveBeenCalledWith(
        "http://siclaw-ocr-backend:8088/parse",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "content-type": "application/json",
            "x-request-id": expect.any(String),
          }),
        }),
      );
      const ocrBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(ocrBody.request_id).toBe(fetchMock.mock.calls[0][1].headers["x-request-id"]);
      expect(ocrBody.kind_hint).toBe("auto");
      const command = (connMap.sendCommand as any).mock.calls[0][2];
      expect(command.text).toContain("这个终端截图是什么问题");
      expect(command.text).toContain("OCR evidence extracted by Siclaw");
      expect(command.text).toContain("kubectl get pods");
    });

    it("truncates OCR evidence before injecting it into the prompt", async () => {
      vi.stubEnv("SICLAW_OCR_BACKEND_URL", "http://siclaw-ocr-backend:8088/parse");
      vi.stubEnv("SICLAW_OCR_MAX_EVIDENCE_TEXT_CHARS", "12");
      vi.stubEnv("SICLAW_OCR_MAX_TOTAL_EVIDENCE_TEXT_CHARS", "2000");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          kind: "document",
          language: "en",
          route: "text",
          confidence: 0.95,
          text: "abcdefghijklmnopqrstuvwxyz",
          warnings: [],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);
      query
        .mockResolvedValueOnce([[{ model_provider: "openai", model_id: "gpt-4" }], []])
        .mockResolvedValueOnce([[{ id: "p1", name: "openai", base_url: "u", api_key: "k", api_type: "openai" }], []])
        .mockResolvedValueOnce([[{ model_id: "gpt-4", name: "GPT-4", reasoning: 0, context_window: 128000, max_tokens: 4096 }], []]);

      const res = fakeRes();
      const req = fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/send",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: {
          text: "read this",
          session_id: "s1",
          attachments: [{
            kind: "pdf",
            filename: "long.pdf",
            mimeType: "application/pdf",
            data: "aGVsbG8=",
          }],
        },
      });

      router.handle(req, res);

      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      const command = (connMap.sendCommand as any).mock.calls[0][2];
      expect(command.text).toContain("abcdefghijkl");
      expect(command.text).toContain("OCR text truncated after 12 characters; original length 26 characters.");
      expect(command.text).not.toContain("mnopqrstuvwxyz");
    });

    it("truncates aggregate OCR evidence before injecting it into the prompt", async () => {
      vi.stubEnv("SICLAW_OCR_BACKEND_URL", "http://siclaw-ocr-backend:8088/parse");
      vi.stubEnv("SICLAW_OCR_MAX_EVIDENCE_TEXT_CHARS", "2000");
      vi.stubEnv("SICLAW_OCR_MAX_TOTAL_EVIDENCE_TEXT_CHARS", "180");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          kind: "document",
          language: "en",
          route: "text",
          confidence: 0.95,
          text: "x".repeat(500),
          warnings: [],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);
      query
        .mockResolvedValueOnce([[{ model_provider: "openai", model_id: "gpt-4" }], []])
        .mockResolvedValueOnce([[{ id: "p1", name: "openai", base_url: "u", api_key: "k", api_type: "openai" }], []])
        .mockResolvedValueOnce([[{ model_id: "gpt-4", name: "GPT-4", reasoning: 0, context_window: 128000, max_tokens: 4096 }], []]);

      const res = fakeRes();
      const req = fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/send",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: {
          text: "read this",
          session_id: "s1",
          attachments: [{
            kind: "pdf",
            filename: "long.pdf",
            mimeType: "application/pdf",
            data: "aGVsbG8=",
          }],
        },
      });

      router.handle(req, res);

      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      const command = (connMap.sendCommand as any).mock.calls[0][2];
      expect(command.text).toContain("OCR evidence truncated after 180 total characters");
      expect(command.text.length).toBeLessThan(600);
    });

    it("starts the SSE response before waiting for OCR", async () => {
      vi.stubEnv("SICLAW_OCR_BACKEND_URL", "http://siclaw-ocr-backend:8088/parse");
      let resolveFetch: ((value: unknown) => void) | undefined;
      const fetchMock = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
      vi.stubGlobal("fetch", fetchMock);
      query
        .mockResolvedValueOnce([[{ model_provider: "openai", model_id: "gpt-4" }], []])
        .mockResolvedValueOnce([[{ id: "p1", name: "openai", base_url: "u", api_key: "k", api_type: "openai" }], []])
        .mockResolvedValueOnce([[{ model_id: "gpt-4", name: "GPT-4", reasoning: 0, context_window: 128000, max_tokens: 4096 }], []]);

      const res = fakeRes();
      const req = fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/send",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: {
          text: "read this",
          session_id: "s1",
          attachments: [{
            kind: "image",
            filename: "terminal.png",
            mimeType: "image/png",
            data: "aGVsbG8=",
          }],
        },
      });

      router.handle(req, res);

      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        "Content-Type": "text/event-stream",
      }));
      expect(connMap.sendCommand).not.toHaveBeenCalled();

      resolveFetch?.({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          kind: "terminal",
          language: "en",
          route: "text",
          confidence: 0.95,
          text: "kubectl get pods",
          warnings: [],
        }),
      });
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      expect(connMap.sendCommand).toHaveBeenCalled();
    });

    it("keeps attachment sends recoverable when OCR backend is not configured", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      query
        .mockResolvedValueOnce([[{ model_provider: "openai", model_id: "gpt-4" }], []])
        .mockResolvedValueOnce([[{ id: "p1", name: "openai", base_url: "u", api_key: "k", api_type: "openai" }], []])
        .mockResolvedValueOnce([[{ model_id: "gpt-4", name: "GPT-4", reasoning: 0, context_window: 128000, max_tokens: 4096 }], []]);

      const res = fakeRes();
      const req = fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/send",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: {
          text: "",
          session_id: "s1",
          attachments: [{
            kind: "image",
            filename: "terminal.png",
            mimeType: "image/png",
            data: "aGVsbG8=",
          }],
        },
      });

      router.handle(req, res);

      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      expect(fetchMock).not.toHaveBeenCalled();
      const command = (connMap.sendCommand as any).mock.calls[0][2];
      expect(command.text).toContain("Please analyze the attached file(s).");
      expect(command.text).toContain("OCR unavailable: OCR backend is not configured");
    });

    it("forwards model compatibility for OpenAI-compatible gateway chat sends", async () => {
      query
        .mockResolvedValueOnce([[{ model_provider: "compatible", model_id: "compatible-chat" }], []])
        .mockResolvedValueOnce([[{
          id: "p1",
          name: "compatible",
          base_url: "https://api.example.com/model-api",
          api_key: "k",
          api_type: "openai-completions",
        }], []])
        .mockResolvedValueOnce([[{
          model_id: "compatible-chat",
          name: "Compatible Chat",
          reasoning: 1,
          context_window: 128000,
          max_tokens: 4096,
        }], []]);

      const res = fakeRes();
      const req = fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/send",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: { text: "hi", session_id: "s1" },
      });

      router.handle(req, res);

      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      const command = (connMap.sendCommand as any).mock.calls[0][2];
      expect(command.modelConfig.models[0].compat).toMatchObject({
        supportsDeveloperRole: false,
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
      });
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

  // ── chat.sessionStatus (liveness) ────────────────────────
  describe("GET /api/v1/siclaw/agents/:id/chat/sessions/:sid/status", () => {
    const url = "/api/v1/siclaw/agents/a1/chat/sessions/s1/status";

    it("returns 401 without auth", async () => {
      const res = await runRoute(router, fakeReq({ url, method: "GET" }));
      expect(res._status).toBe(401);
      expect(connMap.sendCommand).not.toHaveBeenCalled();
    });

    it("returns 403 when the session belongs to another user", async () => {
      query.mockResolvedValue([[{ user_id: "someone-else" }], []]);
      const res = await runRoute(router, fakeReq({
        url, method: "GET", headers: { authorization: `Bearer ${USER_TOKEN}` },
      }));
      expect(res._status).toBe(403);
      expect(connMap.sendCommand).not.toHaveBeenCalled();
    });

    it("maps payload.running to the response on a new (unowned) session", async () => {
      query.mockResolvedValue([[], []]); // brand-new session → no row → allowed
      connMap.sendCommand = vi.fn().mockResolvedValue({ ok: true, payload: { running: true } });
      const res = await runRoute(router, fakeReq({
        url, method: "GET", headers: { authorization: `Bearer ${USER_TOKEN}` },
      }));
      expect(res._status).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ running: true });
      expect(connMap.sendCommand).toHaveBeenCalledWith("a1", "chat.sessionStatus", expect.objectContaining({ sessionId: "s1" }));
    });

    it("fails safe to running:false when the runtime RPC fails", async () => {
      query.mockResolvedValue([[], []]);
      connMap.sendCommand = vi.fn().mockResolvedValue({ ok: false, error: "disconnected" });
      const res = await runRoute(router, fakeReq({
        url, method: "GET", headers: { authorization: `Bearer ${USER_TOKEN}` },
      }));
      expect(res._status).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ running: false });
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
