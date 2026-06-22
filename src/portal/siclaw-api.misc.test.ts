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
import { registerSiclawRoutes, sqlDayKey } from "./siclaw-api.js";
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
      expect(query.mock.calls[1][0]).toContain('metadata NOT LIKE \'%"kind":"delegation_event"%\'');
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
