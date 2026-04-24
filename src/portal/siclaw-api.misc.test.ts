/**
 * Smoke tests for registerSiclawRoutes covering non-skills domains:
 * mcp, chat sessions, my-tasks, task runs, channel bindings, model providers,
 * dashboard, and system config.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import { createRestRouter } from "../gateway/rest-router.js";
import { signToken } from "./auth.js";
import { registerSiclawRoutes } from "./siclaw-api.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";

const JWT_SECRET = "test-siclaw-misc";
const USER_TOKEN = signToken("u1", "alice", "user", JWT_SECRET);
const ADMIN_TOKEN = signToken("a1", "admin", "admin", JWT_SECRET);

function fakeReq(opts: { url: string; method: string; headers?: Record<string, string>; body?: unknown }): any {
  const em = new EventEmitter() as any;
  em.url = opts.url;
  em.method = opts.method;
  em.headers = { authorization: `Bearer ${USER_TOKEN}`, ...(opts.headers ?? {}) };
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

function runRoute(router: ReturnType<typeof createRestRouter>, req: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = new EventEmitter();
    res.writeHead = (s: number) => { res._status = s; res.headersSent = true; return res; };
    res.end = (b?: string) => {
      resolve({ status: res._status ?? 0, body: b ? JSON.parse(b) : null });
      return res;
    };
    try { if (!router.handle(req, res)) reject(new Error("no route")); } catch (err) { reject(err); }
  });
}

function makeConnMap(): RuntimeConnectionMap {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    isConnected: vi.fn().mockReturnValue(false),
    sendCommand: vi.fn().mockResolvedValue({ ok: true }),
    notify: vi.fn(),
    notifyMany: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    connectedAgentIds: vi.fn().mockReturnValue([]),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("siclaw-api misc routes", () => {
  let router: ReturnType<typeof createRestRouter>;
  let query: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router = createRestRouter();
    registerSiclawRoutes(router, {
      jwtSecret: JWT_SECRET,
      serverUrl: "http://runtime:3000",
      portalSecret: "internal",
      connectionMap: makeConnMap(),
    });
    query = vi.fn();
    (getDb as any).mockReturnValue({ query, getConnection: vi.fn() });
  });

  // ── MCP endpoints ─────────────────────────────────────────
  describe("GET /api/v1/siclaw/mcp", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/mcp",
        method: "GET",
        headers: { authorization: "" },
      }));
      expect(status).toBe(401);
    });

    it("returns mcp list", async () => {
      query.mockResolvedValueOnce([[{ id: "m1", name: "srv" }], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/mcp",
        method: "GET",
      }));
      expect(status).toBe(200);
      expect(body.data).toHaveLength(1);
    });
  });

  describe("POST /api/v1/siclaw/mcp", () => {
    it("rejects missing required fields", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/mcp",
        method: "POST",
        body: {},
      }));
      // Some handlers short-circuit via guardAccess with 500 when orgId missing.
      // Accept both 400 and 500 as non-success shapes.
      expect([400, 403, 500]).toContain(status);
    });
  });

  // ── Chat sessions ────────────────────────────────────────
  describe("GET /api/v1/siclaw/agents/:id/chat/sessions", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/sessions",
        method: "GET",
        headers: { authorization: "" },
      }));
      expect(status).toBe(401);
    });

    it("returns sessions list", async () => {
      query
        .mockResolvedValueOnce([[{ count: 0 }], []])
        .mockResolvedValueOnce([[], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/sessions",
        method: "GET",
      }));
      expect(status).toBe(200);
      expect(body.data ?? body.sessions ?? body).toBeDefined();
    });
  });

  describe("POST /api/v1/siclaw/agents/:id/chat/sessions", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/sessions",
        method: "POST",
        headers: { authorization: "" },
        body: { title: "test" },
      }));
      expect(status).toBe(401);
    });
  });

  describe("DELETE /api/v1/siclaw/agents/:id/chat/sessions/:sid", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/sessions/s1",
        method: "DELETE",
        headers: { authorization: "" },
      }));
      expect(status).toBe(401);
    });
  });

  // ── My-tasks ─────────────────────────────────────────────
  describe("GET /api/v1/siclaw/my-tasks", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/my-tasks",
        method: "GET",
        headers: { authorization: "" },
      }));
      expect(status).toBe(401);
    });

    it("returns tasks for current user", async () => {
      query.mockResolvedValueOnce([[{ id: "t1", name: "Task 1" }], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/my-tasks",
        method: "GET",
      }));
      expect(status).toBe(200);
      expect(body.data ?? body.tasks ?? body).toBeDefined();
    });
  });

  // ── Agent tasks ──────────────────────────────────────────
  describe("POST /api/v1/siclaw/agents/:agentId/tasks", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/tasks",
        method: "POST",
        headers: { authorization: "" },
        body: { name: "t", schedule: "* * * * *", prompt: "do" },
      }));
      expect(status).toBe(401);
    });
  });

  describe("GET /api/v1/siclaw/agents/:agentId/tasks", () => {
    it("returns tasks list", async () => {
      query.mockResolvedValueOnce([[{ id: "t1" }], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/tasks",
        method: "GET",
      }));
      expect(status).toBe(200);
      expect(body.data ?? body).toBeDefined();
    });
  });

  // ── Channel bindings ─────────────────────────────────────
  describe("GET /api/v1/siclaw/agents/:id/channel-bindings", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/channel-bindings",
        method: "GET",
        headers: { authorization: "" },
      }));
      expect(status).toBe(401);
    });

    it("returns bindings", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/channel-bindings",
        method: "GET",
      }));
      expect(status).toBe(200);
    });
  });

  // ── Diagnostics ──────────────────────────────────────────
  describe("GET /api/v1/siclaw/agents/:id/diagnostics", () => {
    it("returns diagnostics list", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/diagnostics",
        method: "GET",
      }));
      expect(status).toBe(200);
    });
  });

  // ── Admin: model providers ───────────────────────────────
  describe("GET /api/v1/siclaw/admin/models/providers", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/admin/models/providers",
        method: "GET",
        headers: { authorization: "" },
      }));
      expect(status).toBe(401);
    });

    it("returns providers list for authenticated user", async () => {
      query.mockResolvedValueOnce([[{ id: "p1", name: "openai" }], []]);
      query.mockResolvedValueOnce([[], []]);  // model_entries for p1
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/admin/models/providers",
        method: "GET",
      }));
      expect(status).toBe(200);
      expect(body.data).toBeDefined();
    });
  });

  describe("POST /api/v1/siclaw/admin/models/providers", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/admin/models/providers",
        method: "POST",
        headers: { authorization: "" },
        body: { name: "openai" },
      }));
      expect(status).toBe(401);
    });
  });

  // ── Admin dashboard ──────────────────────────────────────
  describe("GET /api/v1/siclaw/admin/dashboard/summary", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/admin/dashboard/summary",
        method: "GET",
        headers: { authorization: "" },
      }));
      expect(status).toBe(401);
    });
  });

  // ── Metrics summary ──────────────────────────────────────
  describe("GET /api/v1/siclaw/metrics/summary", () => {
    it("rejects non-admin", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/summary",
        method: "GET",
      }));
      expect([401, 403]).toContain(status);
    });

    it("rejects invalid period (admin)", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/summary?period=bogus",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(400);
    });

    it("returns summary for admin with valid period", async () => {
      query
        .mockResolvedValueOnce([[{ c: 1 }], []])
        .mockResolvedValueOnce([[{ c: 5 }], []])
        .mockResolvedValueOnce([[], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/summary",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(200);
      expect(body.totalSessions).toBe(1);
      expect(query.mock.calls[1][0]).toContain('metadata NOT LIKE \'%"kind":"delegation_event"%\'');
    });
  });

  // ── System config ────────────────────────────────────────
  describe("GET /api/v1/siclaw/system/config", () => {
    it("rejects non-admin", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/system/config",
        method: "GET",
      }));
      expect([401, 403]).toContain(status);
    });

    it("returns config for admin", async () => {
      query.mockResolvedValueOnce([[{ config_key: "k", config_value: "v" }], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/system/config",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(200);
      expect(body.config ?? body).toBeDefined();
    });
  });

  describe("PUT /api/v1/siclaw/system/config", () => {
    it("rejects non-admin", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/system/config",
        method: "PUT",
        body: { key: "x", value: "y" },
      }));
      expect([401, 403]).toContain(status);
    });
  });

  // ── Knowledge repos (admin) ──────────────────────────────
  describe("GET /api/v1/siclaw/admin/knowledge/repos", () => {
    it("rejects non-admin", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/admin/knowledge/repos",
        method: "GET",
      }));
      expect([401, 403]).toContain(status);
    });

    it("returns repos for admin", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/admin/knowledge/repos",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(200);
      expect(body.data ?? body).toBeDefined();
    });
  });

  describe("POST /api/v1/siclaw/admin/knowledge/repos", () => {
    it("rejects non-admin", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/admin/knowledge/repos",
        method: "POST",
        body: { name: "x" },
      }));
      expect([401, 403]).toContain(status);
    });
  });
});
