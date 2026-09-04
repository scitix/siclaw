/**
 * Smoke tests for registerSiclawRoutes covering non-skills domains:
 * mcp, chat sessions, my-tasks, task runs, channel bindings, model providers,
 * dashboard, and system config.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { parentAttributedOriginPredicate } from "./session-origin.js";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import { createRestRouter } from "../gateway/rest-router.js";
import { signToken } from "./auth.js";
import { registerSiclawRoutes, sqlDayKey } from "./siclaw-api.js";
import { DEFAULT_MAX_TOKENS } from "../core/model-compat.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";
import { humanPromptPredicate } from "./human-prompt.js";
import type { Db } from "../gateway/db.js";

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
    // driver is explicit: siclaw-api.ts builds dialect-aware SQL, and a mock
    // without it silently exercises the SQLite branch of every such helper.
    (getDb as any).mockReturnValue({ query, getConnection: vi.fn(), driver: "mysql" });
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

  describe("PUT /api/v1/siclaw/agents/:id/chat/sessions/:sid", () => {
    it("allows explicitly clearing the title", async () => {
      query
        .mockResolvedValueOnce([[{ id: "s1" }], []])
        .mockResolvedValueOnce([{}, []])
        .mockResolvedValueOnce([[{ id: "s1", title: "" }], []]);

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/sessions/s1",
        method: "PUT",
        body: { title: "" },
      }));

      expect(status).toBe(200);
      expect(query.mock.calls[1][0]).toContain("UPDATE chat_sessions SET title = ?");
      expect(query.mock.calls[1][1][0]).toBe("");
      expect(body.title).toBe("");
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

    it("stays owner-only — no parent-session hop for a non-owned session", async () => {
      // Owner-check finds nothing; delete must 404 without any further lookup.
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/sessions/s1",
        method: "DELETE",
      }));
      expect(status).toBe(404);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toContain("user_id = ?");
    });
  });

  // ── Chat messages (read access, incl. delegated sub-agent transcripts) ──
  describe("GET /api/v1/siclaw/agents/:id/chat/sessions/:sid/messages", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/sessions/s1/messages",
        method: "GET",
        headers: { authorization: "" },
      }));
      expect(status).toBe(401);
    });

    it("returns messages for the direct owner (no parent hop)", async () => {
      query
        .mockResolvedValueOnce([[{ user_id: "u1", parent_session_id: null }], []]) // resolveReadableSession
        .mockResolvedValueOnce([[{ count: 1 }], []]) // COUNT
        .mockResolvedValueOnce([[{ id: "m1", metadata: null }], []]); // list
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/sessions/s1/messages",
        method: "GET",
      }));
      expect(status).toBe(200);
      expect(body.data).toHaveLength(1);
      // Direct owner short-circuits: exactly one auth query (no parent lookup).
      expect(query.mock.calls[0][0]).toContain("parent_session_id");
      expect(query.mock.calls[1][0]).toContain("COUNT(*)");
    });

    it("allows the parent-session owner to read a delegated sub-agent transcript (user_id='unknown')", async () => {
      query
        .mockResolvedValueOnce([[{ user_id: "unknown", parent_session_id: "p1" }], []]) // child row
        .mockResolvedValueOnce([[{ id: "p1" }], []]) // parent owned by requester
        .mockResolvedValueOnce([[{ count: 0 }], []]) // COUNT
        .mockResolvedValueOnce([[], []]); // list
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/sessions/child1/messages",
        method: "GET",
      }));
      expect(status).toBe(200);
      expect(body.data).toEqual([]);
      // Parent lookup is scoped to the requester (user_id = ?).
      expect(query.mock.calls[1][0]).toContain("user_id = ?");
      expect(query.mock.calls[1][1]).toEqual(["p1", "a1", "u1"]);
    });

    it("404s when the delegated session's parent belongs to someone else", async () => {
      query
        .mockResolvedValueOnce([[{ user_id: "unknown", parent_session_id: "p1" }], []]) // child row
        .mockResolvedValueOnce([[], []]); // parent NOT owned by requester
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/sessions/child1/messages",
        method: "GET",
      }));
      expect(status).toBe(404);
      expect(query).toHaveBeenCalledTimes(2);
    });

    it("404s for an orphan non-owned session with no parent", async () => {
      query.mockResolvedValueOnce([[{ user_id: "unknown", parent_session_id: null }], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/chat/sessions/x1/messages",
        method: "GET",
      }));
      expect(status).toBe(404);
      expect(query).toHaveBeenCalledTimes(1);
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

  describe("PUT /api/v1/siclaw/agents/:id/channel-bindings/:bindingId/context-mode", () => {
    it("accepts Topic mode and persists it on an owned binding", async () => {
      query
        .mockResolvedValueOnce([[{ id: "b1" }], []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/channel-bindings/b1/context-mode",
        method: "PUT",
        body: { mode: "topic" },
      }));

      expect(status).toBe(200);
      expect(body).toEqual({ ok: true, mode: "topic" });
      expect(query.mock.calls[1][1]).toEqual(["topic", "b1"]);
    });

    it("rejects an unknown mode before querying the database", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/a1/channel-bindings/b1/context-mode",
        method: "PUT",
        body: { mode: "bogus" },
      }));

      expect(status).toBe(400);
      expect(query).not.toHaveBeenCalled();
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

  // ── max_tokens default, at the route level ───────────────
  //
  // The Portal helper test proves the FORM omits a blank max_tokens and the
  // migration test proves the COLUMN default; neither shows what a write path
  // actually persists when the field is absent. That gap is how 65536 survived:
  // the constant was correct in three writers while the value reaching the DB
  // came from elsewhere. These assert the bound parameter itself.
  describe("model write paths default max_tokens", () => {
    const providerRow = [[{ id: "p1", api_type: "anthropic-messages" }], []];
    // Column order of the create INSERT — the assertion has to name the position
    // it means, or it silently follows a column being added ahead of it.
    const CREATE_MAX_TOKENS_IDX = 7;

    it("POST .../models persists the constant when max_tokens is absent", async () => {
      query.mockResolvedValueOnce(providerRow);              // provider lookup
      query.mockResolvedValueOnce([[], []]);                 // INSERT
      query.mockResolvedValueOnce([[{ id: "new" }], []]);    // read-back of the row
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/admin/models/providers/p1/models",
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: { model_id: "claude-haiku-4-5", api_type: "anthropic-messages" },
      }));
      expect(status).toBe(201);
      const insert = query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO model_entries"));
      expect(insert).toBeDefined();
      expect(insert![1][CREATE_MAX_TOKENS_IDX]).toBe(DEFAULT_MAX_TOKENS);
      expect(DEFAULT_MAX_TOKENS).toBeLessThan(64000);
    });

    it("POST .../models keeps an explicit max_tokens", async () => {
      query.mockResolvedValueOnce(providerRow);
      query.mockResolvedValueOnce([[], []]);
      query.mockResolvedValueOnce([[{ id: "new" }], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/admin/models/providers/p1/models",
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: { model_id: "m", api_type: "anthropic-messages", max_tokens: 64000 },
      }));
      expect(status).toBe(201);
      const insert = query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO model_entries"));
      expect(insert![1][CREATE_MAX_TOKENS_IDX]).toBe(64000);
    });

    // The form sends parseInt("") = NaN for a cleared box, which arrives as null.
    // On a NOT NULL column that has to become the default, not the null.
    it("PUT .../models/:mid turns a cleared max_tokens into the constant", async () => {
      query.mockResolvedValueOnce([[{ id: "m1" }], []]);  // existing entry lookup
      query.mockResolvedValueOnce([[], []]);              // UPDATE
      query.mockResolvedValueOnce([[{ id: "m1" }], []]);  // read-back of the row
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/admin/models/providers/p1/models/m1",
        method: "PUT",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: { max_tokens: null },
      }));
      expect(status).toBe(200);
      const update = query.mock.calls.find((c) => String(c[0]).includes("UPDATE model_entries"));
      expect(update).toBeDefined();
      expect(String(update![0])).toContain("max_tokens = ?");
      expect(update![1][0]).toBe(DEFAULT_MAX_TOKENS);
    });

    // The write path is the one moment an operator typo can still be reported to
    // the person who made it — the read path deliberately ignores what it does
    // not recognise, so an unknown key stored here would just be silently inert.
    it("rejects a compat_overrides key that is not in the whitelist", async () => {
      query.mockResolvedValueOnce(providerRow);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/admin/models/providers/p1/models",
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: { model_id: "m", api_type: "anthropic-messages", compat_overrides: { somethingNew: true } },
      }));
      expect(status).toBe(400);
      expect(String(body.error)).toContain("forceAdaptiveThinking");
      expect(query.mock.calls.some((c) => String(c[0]).includes("INSERT INTO model_entries"))).toBe(false);
    });

    it("stores a whitelisted compat override and folds an empty one to NULL", async () => {
      query.mockResolvedValueOnce(providerRow);
      query.mockResolvedValueOnce([[], []]);
      query.mockResolvedValueOnce([[{ id: "new" }], []]);
      await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/admin/models/providers/p1/models",
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: { model_id: "m", api_type: "anthropic-messages", compat_overrides: { forceAdaptiveThinking: false } },
      }));
      const insert = query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO model_entries"));
      expect(insert![1][10]).toBe('{"forceAdaptiveThinking":false}');

      query.mockClear();
      query.mockResolvedValueOnce(providerRow);
      query.mockResolvedValueOnce([[], []]);
      query.mockResolvedValueOnce([[{ id: "new2" }], []]);
      await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/admin/models/providers/p1/models",
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: { model_id: "m2", api_type: "anthropic-messages", compat_overrides: {} },
      }));
      const insert2 = query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO model_entries"));
      // NULL, not "{}" — back to automatic resolution.
      expect(insert2![1][10]).toBeNull();
    });

    it("batch import persists the constant for a listing that carried no max_tokens", async () => {
      const connQuery = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
      (getDb as any).mockReturnValue({
        query,
        getConnection: vi.fn().mockResolvedValue({
          query: connQuery,
          beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
        }),
      });
      query.mockResolvedValueOnce(providerRow);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/admin/models/providers/p1/models/batch",
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: { models: [{ model_id: "claude-opus-4-5" }] },
      }));
      expect(status).toBe(200);
      const insert = connQuery.mock.calls.find((c) => String(c[0]).includes("INTO model_entries"));
      expect(insert).toBeDefined();
      // Batch INSERT has no max_tokens_field column, so the position differs from
      // the create path — another reason to assert an index, not a value anywhere.
      expect(insert![1][7]).toBe(DEFAULT_MAX_TOKENS);
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

    it("rejects invalid window (admin)", async () => {
      // from >= to is rejected by resolveWindow — the from/to contract replaced
      // the old `period` enum; 4-digit values are read as unix-ms (2000 > 1000).
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/summary?from=2000&to=1000",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(400);
    });

    it("returns summary for admin with default window", async () => {
      // Default for distinctUsers / toolCalls / skillsUsed / inventory / series;
      // the two Once values are the asserted scalar totals (byUser is gone).
      query.mockResolvedValue([[{ c: 0 }], []]);
      query
        .mockResolvedValueOnce([[{ c: 1 }], []])
        .mockResolvedValueOnce([[{ c: 5 }], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/summary",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(200);
      expect(body.totalSessions).toBe(1);
      // Prompts are counted by reading metadata.kind, and ALL synthetic kinds
      // are excluded rather than delegation_event alone — task_event on its own
      // outnumbers real questions several times over. Asserted against the
      // predicate itself, not a pinned SQL string: a pinned string is what let
      // the origin filter rot for a month, and it would break on the dialect
      // branch this predicate now carries.
      const promptSql = query.mock.calls[1][0] as string;
      expect(promptSql).toContain(humanPromptPredicate({ driver: "mysql" } as Db, "m"));
      expect(promptSql).not.toContain("LIKE");
      // Desensitized: no raw per-user data on the wire.
      expect(body).not.toHaveProperty("byUser");
      // External-showcase fields present.
      expect(body).toHaveProperty("distinctUsers");
      expect(body).toHaveProperty("toolCalls");
      expect(body).toHaveProperty("skillsUsed");
      expect(body.inventory).toMatchObject({ clusters: 0, hosts: 0, skills: 0, knowledgeRepos: 0, agents: 0, mcpServers: 0 });
      // Daily trend series: default 7d window → 8 gap-filled points, each shaped.
      expect(Array.isArray(body.dailySeries)).toBe(true);
      expect(body.dailySeries).toHaveLength(8);
      expect(body.dailySeries[0]).toMatchObject({ prompts: 0, toolCalls: 0 });
      expect(typeof body.dailySeries[0].date).toBe("string");
    });

    it("counts distinct skills from tool_input (parse, regex fallback, dedup, skip missing)", async () => {
      query.mockResolvedValue([[{ c: 0 }], []]); // inventory fall-through
      query
        .mockResolvedValueOnce([[{ c: 2 }], []])   // totalSessions
        .mockResolvedValueOnce([[{ c: 9 }], []])   // totalPrompts
        .mockResolvedValueOnce([[{ c: 3 }], []])   // distinctUsers
        .mockResolvedValueOnce([[{ c: 42 }], []])  // toolCalls
        .mockResolvedValueOnce([[                   // skillsUsed rows
          { toolInput: JSON.stringify({ skill: "volcano-queue-diagnose", script: "x.sh" }) },
          { toolInput: JSON.stringify({ skill: "volcano-queue-diagnose", script: "y.sh" }) }, // dup
          { toolInput: JSON.stringify({ skill: "roce-perftest", script: "z.sh" }) },
          { toolInput: JSON.stringify({ script: "user-script.sh" }) },                        // no skill → skip
          { toolInput: 'broken json "skill":"regex-only" trailing' },                          // parse fail → regex
          { toolInput: null },                                                                 // null → skip
        ], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/summary",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(200);
      expect(body.distinctUsers).toBe(3);
      expect(body.toolCalls).toBe(42);
      expect(body.skillsUsed).toBe(3); // volcano + roce + regex-only, deduped, missing/null skipped
      expect(body.skillsUsedApprox).toBe(false);
      // Lock decision #3: inventory.skills excludes per-agent overlay shadows.
      expect(query.mock.calls.some((c: unknown[]) => typeof c[0] === "string" && c[0].includes("overlay_of IS NULL"))).toBe(true);
    });

    it("daily series gap-fills the window and sums to the period totals", async () => {
      // Inject two days of buckets within the default 7-day window, computed
      // relative to now so the test is date-agnostic. Use the SAME local-day
      // derivation as the handler's sqlDayKey (NOT toISOString) so keys match.
      const dayKey = (back: number) => {
        const d = new Date();
        d.setDate(d.getDate() - back);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      };
      const kA = dayKey(2);
      const kB = dayKey(5);
      query.mockResolvedValue([[{ c: 0 }], []]);
      query
        .mockResolvedValueOnce([[{ c: 4 }], []])   // totalSessions
        .mockResolvedValueOnce([[{ c: 14 }], []])  // totalPrompts
        .mockResolvedValueOnce([[{ c: 1 }], []])   // distinctUsers
        .mockResolvedValueOnce([[{ c: 20 }], []])  // toolCalls
        .mockResolvedValueOnce([[], []])           // skillsUsed rows
        .mockResolvedValueOnce([[{ c: 3 }], []])   // inv clusters
        .mockResolvedValueOnce([[{ c: 4 }], []])   // inv hosts
        .mockResolvedValueOnce([[{ c: 1 }], []])   // inv skills
        .mockResolvedValueOnce([[{ c: 0 }], []])   // inv knowledge
        .mockResolvedValueOnce([[{ c: 1 }], []])   // inv agents
        .mockResolvedValueOnce([[{ c: 1 }], []])   // inv mcp
        .mockResolvedValueOnce([[{ day: kA, c: 6 }, { day: kB, c: 8 }], []])   // dailyPrompts
        .mockResolvedValueOnce([[{ day: kA, c: 9 }, { day: kB, c: 11 }], []]); // dailyTools
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/summary",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(200);
      expect(body.inventory).toMatchObject({ agents: 1, mcpServers: 1 });
      expect(body.dailySeries.reduce((s: number, d: { prompts: number }) => s + d.prompts, 0)).toBe(14);
      expect(body.dailySeries.reduce((s: number, d: { toolCalls: number }) => s + d.toolCalls, 0)).toBe(20);
    });

    it("flags skillsUsedApprox when the skill-row cap is exceeded", async () => {
      const ROW_LIMIT = 50_000; // mirrors SKILL_ROW_LIMIT in the handler
      query.mockResolvedValue([[{ c: 0 }], []]);
      query
        .mockResolvedValueOnce([[{ c: 1 }], []])   // totalSessions
        .mockResolvedValueOnce([[{ c: 1 }], []])   // totalPrompts
        .mockResolvedValueOnce([[{ c: 1 }], []])   // distinctUsers
        .mockResolvedValueOnce([[{ c: 1 }], []])   // toolCalls
        // skillsUsed: one row over the cap (handler LIMITs at ROW_LIMIT+1), all same skill
        .mockResolvedValueOnce([Array.from({ length: ROW_LIMIT + 1 }, () => ({ toolInput: '{"skill":"s"}' })), []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/summary",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(200);
      expect(body.skillsUsedApprox).toBe(true);
      expect(body.skillsUsed).toBe(1); // capped slice still de-dupes
    });
  });

  // ── Metrics audit ────────────────────────────────────────
  describe("GET /api/v1/siclaw/metrics/audit", () => {
    it("rejects non-admin", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/audit",
        method: "GET",
      }));
      expect([401, 403]).toContain(status);
    });

    it("rejects a reversed window with 400, matching summary/timing", async () => {
      // Regression: audit used `parseTs(...) ?? default` with no `from >= to`
      // check, so a reversed window silently returned an empty list via BETWEEN
      // instead of failing the way summary/timing do.
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/audit?from=2000&to=1000",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(400);
    });

    it("returns logs for admin within a valid window", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/audit?from=1000&to=2000",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(200);
      expect(Array.isArray(body.logs)).toBe(true);
    });

    it("entry=api filters by origin (with parent attribution) + joins agents", async () => {
      query.mockResolvedValueOnce([[], []]);
      await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/audit?from=1000&to=2000&entry=api",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      const sql: string = query.mock.calls[0][0];
      expect(sql).toContain("s.origin = 'api'");
      // Both trace kinds that work on behalf of a parent turn are attributed to
      // it — but only when the parent row is actually present.
      expect(sql).toContain(
        `${parentAttributedOriginPredicate("s")} AND parent_s.id IS NOT NULL AND parent_s.origin = 'api'`,
      );
      expect(sql).toContain("LEFT JOIN agents a ON s.agent_id = a.id");             // agentName
    });

    it("channel + sender filters inherit from the parent session (delegation children not dropped)", async () => {
      query.mockResolvedValueOnce([[], []]);
      await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/audit?from=1000&to=2000&entry=channel&channelId=chan-1&senderExternalId=ou_a",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      const sql: string = query.mock.calls[0][0];
      // channel_id / sender_external_id are NULL on a delegation child, so the
      // filters COALESCE to the parent channel session — else sub-agent tool
      // rows silently vanish from a channel/sender-filtered view.
      expect(sql).toContain("COALESCE(s.channel_id, parent_s.channel_id) = ?");
      expect(sql).toContain("COALESCE(s.sender_external_id, parent_s.sender_external_id) = ?");
      // projected senderId is parent-aware too, so kept delegation rows show the sender
      expect(sql).toContain("COALESCE(s.sender_external_id, parent_s.sender_external_id) AS senderId");
    });
  });

  describe("GET /api/v1/siclaw/metrics/timing", () => {
    it("summarises the llm_call partition from model-call rows + per-tool latency", async () => {
      query
        .mockResolvedValueOnce([[ // assistant metadata rows
          { metadata: JSON.stringify({ llm_call: { v: 1, ms: { net_ttft: 100, thinking: 20, output: 80, total: 200 } } }) },
          { metadata: JSON.stringify({ llm_call: { v: 1, ms: { net_ttft: 300, thinking: 0, output: 100, total: 400 } } }) },
          { metadata: JSON.stringify({ kind: "thinking", llm_round: 1 }) }, // thinking row: no ms
          { metadata: JSON.stringify({ timing: { ttft_ms: 999 } }) }, // retired shape: ignored
        ], []])
        .mockResolvedValueOnce([[ // tool duration rows
          { toolName: "bash", durationMs: 500 },
          { toolName: "bash", durationMs: 300 },
          { toolName: "read", durationMs: 50 },
        ], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/timing?from=1000&to=2000",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(200);
      expect(body.ttft).toMatchObject({ count: 2, min: 100, max: 300, avg: 200 });
      expect(body.thinking).toMatchObject({ count: 2, min: 0, max: 20, avg: 10 });
      expect(body.output).toMatchObject({ count: 2, min: 80, max: 100 });
      expect(body.total).toMatchObject({ count: 2, min: 200, max: 400 });
      const bash = body.tools.find((t: any) => t.toolName === "bash");
      expect(bash).toMatchObject({ count: 2, min: 300, max: 500 });
      // tools sorted by count desc → bash (2) before read (1)
      expect(body.tools[0].toolName).toBe("bash");
    });

    it("rejects non-admin", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/metrics/timing?from=1000&to=2000", method: "GET",
      }));
      expect([401, 403]).toContain(status);
    });
  });

  describe("GET /api/v1/siclaw/audit/sessions", () => {
    it("returns per-session rows with tool/error counts + agentName, entry-filtered", async () => {
      query.mockResolvedValueOnce([[
        {
          sessionId: "s1", userId: "owner-1", senderId: "ou_alice", channelId: "chan-1",
          agentId: "a1", agentName: "Ops Agent",
          title: "t", preview: "p", origin: "channel", messageCount: 8,
          createdAt: new Date(1000), lastActiveAt: new Date(2000),
          toolCallCount: 5, errorToolCallCount: 2,
        },
      ], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/audit/sessions?from=500&to=3000&entry=channel",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(200);
      const sql: string = query.mock.calls[0][0];
      expect(sql).toContain("s.origin = 'channel'");
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0]).toMatchObject({
        sessionId: "s1", agentName: "Ops Agent", agentGroupName: null,
        origin: "channel", messageCount: 8, toolCallCount: 5, errorToolCallCount: 2,
        // owner and channel sender are separate fields (not overloaded on userId)
        userId: "owner-1", senderId: "ou_alice", channelId: "chan-1",
      });
    });

    it("rejects a reversed window with 400", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/audit/sessions?from=2000&to=1000",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(400);
    });
  });

  describe("GET /api/v1/siclaw/audit/sessions/:id/messages", () => {
    it("returns ANY session's transcript (admin, NOT owner-scoped)", async () => {
      query
        .mockResolvedValueOnce([[ // session header — note: a session owned by some other user
          {
            sessionId: "s9", userId: "someone-else", agentId: "a1", agentName: "Ops Agent",
            title: "Prod incident", preview: "p", origin: "api", messageCount: 3,
            createdAt: new Date(1000), lastActiveAt: new Date(5000),
          },
        ], []])
        .mockResolvedValueOnce([[ // messages — RAW chat_messages rows (snake_case)
          { id: "m1", role: "user", content: "what broke?", tool_name: null, tool_input: null, outcome: null, duration_ms: null, metadata: null, created_at: new Date(1000) },
          { id: "m2", role: "tool", content: "logs…", tool_name: "restricted_bash", tool_input: "{\"command\":\"kubectl get po\"}", outcome: "success", duration_ms: 120, metadata: null, created_at: new Date(2000) },
        ], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/audit/sessions/s9/messages",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(200);
      // The header query must NOT filter by user_id (admin audit reads any owner's session).
      const headerSql: string = query.mock.calls[0][0];
      expect(headerSql).not.toContain("user_id = ?");
      expect(headerSql).toContain("deleted_at IS NULL");
      expect(body.session).toMatchObject({ sessionId: "s9", userId: "someone-else", agentName: "Ops Agent", origin: "api" });
      // Raw rows (same shape the chat endpoint returns) so the UI maps them with toPilotMessage.
      expect(body.data).toHaveLength(2);
      expect(body.data[1]).toMatchObject({ role: "tool", tool_name: "restricted_bash", outcome: "success", duration_ms: 120 });
      expect(body.truncated).toBe(false);
    });

    it("404s when the session is missing or deleted", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/audit/sessions/nope/messages",
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(404);
    });

    it("rejects non-admin", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/audit/sessions/s9/messages", method: "GET",
      }));
      expect([401, 403]).toContain(status);
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

describe("sqlDayKey", () => {
  it("reads LOCAL day components from a Date (mysql2 default), not UTC", () => {
    // A Date built from local components keys to that same local day on any
    // machine TZ — the old toISOString() path shifted this under a non-UTC DB
    // (prod is UTC+8), which dropped edge rows and broke chart Total == KPI.
    expect(sqlDayKey(new Date(2026, 5, 15, 0, 30))).toBe("2026-06-15"); // month is 0-based → June
    expect(sqlDayKey(new Date(2026, 0, 5))).toBe("2026-01-05");          // zero-pads
  });
  it("takes the date part verbatim from a string (SQLite / mysql2 dateStrings)", () => {
    expect(sqlDayKey("2026-06-15")).toBe("2026-06-15");
    expect(sqlDayKey("2026-06-15 23:59:59")).toBe("2026-06-15");
  });
  it("returns null for unparseable / too-short / non-date input", () => {
    expect(sqlDayKey(new Date("nope"))).toBeNull();
    expect(sqlDayKey("2026")).toBeNull();
    expect(sqlDayKey(null)).toBeNull();
    expect(sqlDayKey(undefined)).toBeNull();
    expect(sqlDayKey(12345)).toBeNull();
  });
});
