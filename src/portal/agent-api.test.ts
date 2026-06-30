import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import { createRestRouter } from "../gateway/rest-router.js";
import { signToken } from "./auth.js";
import { registerAgentRoutes } from "./agent-api.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";

const JWT_SECRET = "test-agent-secret";
const ADMIN_TOKEN = signToken("admin-1", "admin", "admin", JWT_SECRET);
const USER_TOKEN = signToken("u1", "user", "user", JWT_SECRET);

function fakeReq(opts: { url: string; method: string; headers?: Record<string, string>; body?: unknown }): any {
  const em = new EventEmitter() as any;
  em.url = opts.url;
  em.method = opts.method;
  em.headers = { authorization: `Bearer ${ADMIN_TOKEN}`, ...(opts.headers ?? {}) };
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

describe("registerAgentRoutes", () => {
  let router: ReturnType<typeof createRestRouter>;
  let connMap: RuntimeConnectionMap;
  let query: ReturnType<typeof vi.fn>;
  let conn: any;

  beforeEach(() => {
    router = createRestRouter();
    connMap = makeConnMap();
    registerAgentRoutes(router, JWT_SECRET, connMap);
    query = vi.fn();
    conn = {
      query: vi.fn(),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    (getDb as any).mockReturnValue({ query, getConnection: vi.fn().mockResolvedValue(conn) });
  });

  // ── GET /api/v1/agents ───────────────────────────────────
  describe("GET /api/v1/agents", () => {
    it("requires auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents",
        method: "GET",
        headers: { authorization: "" },
      }));
      expect(status).toBe(401);
    });

    it("paginates with defaults", async () => {
      query
        .mockResolvedValueOnce([[{ total: 5 }], []])   // count
        .mockResolvedValueOnce([[{ id: "a1", name: "Agent 1" }], []]);  // list
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/agents",
        method: "GET",
      }));
      expect(status).toBe(200);
      expect(body.page).toBe(1);
      expect(body.page_size).toBe(20);
      expect(body.total).toBe(5);
    });

    it("applies search filter", async () => {
      query
        .mockResolvedValueOnce([[{ total: 0 }], []])
        .mockResolvedValueOnce([[], []]);
      await runRoute(router, fakeReq({
        url: "/api/v1/agents?search=foo",
        method: "GET",
      }));
      const countSql: string = query.mock.calls[0][0];
      expect(countSql).toContain("WHERE a.name LIKE ?");
      expect(query.mock.calls[0][1]).toEqual(["%foo%", "%foo%"]);
    });

    it("caps page_size at 100", async () => {
      query
        .mockResolvedValueOnce([[{ total: 0 }], []])
        .mockResolvedValueOnce([[], []]);
      await runRoute(router, fakeReq({
        url: "/api/v1/agents?page_size=9999",
        method: "GET",
      }));
      // list call: [...params, pageSize, offset] — pageSize should be 100
      const listArgs = query.mock.calls[1][1];
      expect(listArgs[listArgs.length - 2]).toBe(100);
    });
  });

  // ── JSON-in-TEXT decoding on agent responses ─────────────
  describe("agent response decodes JSON-in-TEXT columns", () => {
    it("GET /:id decodes model_routing + tool_capabilities to object/array (not raw strings)", async () => {
      query.mockResolvedValueOnce([[{
        id: "a1", name: "A",
        model_routing: '{"enabled":true,"strategy":"ordered_fallback"}',
        tool_capabilities: '["read_files","inspect_infra"]',
      }], []]);
      const { status, body } = await runRoute(router, fakeReq({ url: "/api/v1/agents/a1", method: "GET" }));
      expect(status).toBe(200);
      expect(body.model_routing).toEqual({ enabled: true, strategy: "ordered_fallback" });
      expect(body.tool_capabilities).toEqual(["read_files", "inspect_infra"]);
    });

    it("decodes null columns to null (not the literal string)", async () => {
      query.mockResolvedValueOnce([[{ id: "a1", name: "A", model_routing: null, tool_capabilities: null }], []]);
      const { body } = await runRoute(router, fakeReq({ url: "/api/v1/agents/a1", method: "GET" }));
      expect(body.model_routing).toBeNull();
      expect(body.tool_capabilities).toBeNull();
    });

    it("tolerates malformed JSON by falling back to null (no crash)", async () => {
      query.mockResolvedValueOnce([[{ id: "a1", name: "A", model_routing: "{not json", tool_capabilities: "oops" }], []]);
      const { status, body } = await runRoute(router, fakeReq({ url: "/api/v1/agents/a1", method: "GET" }));
      expect(status).toBe(200);
      expect(body.model_routing).toBeNull();
      expect(body.tool_capabilities).toBeNull();
    });
  });

  // ── POST /api/v1/agents ──────────────────────────────────
  describe("POST /api/v1/agents", () => {
    it("rejects non-admin", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: { name: "x" },
      }));
      expect(status).toBe(403);
    });

    it("returns 400 when name missing", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents",
        method: "POST",
        body: {},
      }));
      expect(status).toBe(400);
    });

    it("creates agent and auto-binds builtin skills", async () => {
      query
        .mockResolvedValueOnce([undefined, []])                   // insert agent
        .mockResolvedValueOnce([[{ id: "s-builtin" }], []])       // select builtin skills
        .mockResolvedValueOnce([undefined, []])                   // insert binding
        .mockResolvedValueOnce([[{ id: "a-new", name: "Test Agent" }], []]);  // select-back

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/agents",
        method: "POST",
        body: { name: "Test Agent" },
      }));

      expect(status).toBe(201);
      expect(body.id).toBe("a-new");
    });

    it("stores normalized model_routing policy on create", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[{ id: "a-new", name: "routed" }], []]);

      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents",
        method: "POST",
        body: {
          name: "routed",
          model_routing: {
            enabled: true,
            candidates: [
              { provider: " openai ", modelId: " gpt-4 " },
              { provider: "openai", modelId: "gpt-4" },
              { provider: "anthropic", modelId: "claude", modelConfig: { apiKey: "do-not-store" } },
            ],
            fallbackOn: ["rate_limit", "bad"],
            cooldownMsByKind: {
              rate_limit: 60000,
              quota: 3600000,
              bad_kind: 1,
              timeout: -1,
            },
          },
        },
      }));

      expect(status).toBe(201);
      const insertArgs = query.mock.calls[0][1];
      expect(JSON.parse(insertArgs[6])).toEqual({
        enabled: true,
        strategy: "ordered_fallback",
        candidates: [
          { provider: "openai", modelId: "gpt-4" },
          { provider: "anthropic", modelId: "claude" },
        ],
        fallbackOn: ["rate_limit"],
        cooldownMsByKind: {
          billing: 3600000,
          rate_limit: 60000,
        },
      });
    });

    it("rejects invalid model_routing policy on create", async () => {
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/agents",
        method: "POST",
        body: { name: "bad", model_routing: { enabled: true, candidates: [] } },
      }));

      expect(status).toBe(400);
      expect(body.error).toContain("model_routing");
      expect(query).not.toHaveBeenCalled();
    });

    it("continues if builtin skill auto-bind fails", async () => {
      query
        .mockResolvedValueOnce([undefined, []])                   // insert agent
        .mockRejectedValueOnce(new Error("db err"))                // select builtin → fails
        .mockResolvedValueOnce([[{ id: "a-new", name: "x" }], []]); // still select-back

      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents",
        method: "POST",
        body: { name: "x" },
      }));
      expect(status).toBe(201);
    });
  });

  // ── GET /api/v1/agents/:id ───────────────────────────────
  describe("GET /api/v1/agents/:id", () => {
    it("returns 404 when missing", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a-gone",
        method: "GET",
      }));
      expect(status).toBe(404);
    });

    it("returns row for authenticated user", async () => {
      query.mockResolvedValueOnce([[{ id: "a1", name: "one" }], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "GET",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      }));
      expect(status).toBe(200);
      expect(body.id).toBe("a1");
    });
  });

  // ── PUT /api/v1/agents/:id ───────────────────────────────
  describe("PUT /api/v1/agents/:id", () => {
    it("rejects non-admin", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
        body: { name: "x" },
      }));
      expect(status).toBe(403);
    });

    it("returns 400 when no fields to update", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: {},
      }));
      expect(status).toBe(400);
    });

    it("notifies agent.reload when is_production changes", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "a1", name: "x" }], []]);

      await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: { is_production: false },
      }));

      expect(connMap.notify).toHaveBeenCalledWith("a1", "agent.reload", { resources: ["skills", "cluster", "host"] });
    });

    it("does not notify when is_production not changed", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "a1" }], []]);

      await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: { name: "rename" },
      }));

      expect(connMap.notify).not.toHaveBeenCalled();
    });

    it("terminates the running box when idle_timeout_sec changes resident(0) → finite", async () => {
      query
        .mockResolvedValueOnce([[{ idle_timeout_sec: 0 }], []]) // pre-read old idle (resident)
        .mockResolvedValueOnce([undefined, []])                  // UPDATE
        .mockResolvedValueOnce([[{ id: "a1" }], []]);            // SELECT *

      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: { idle_timeout_sec: 300 },
      }));

      expect(status).toBe(200);
      // A resident pod never self-destructs, so it must be terminated to cold-spawn
      // with the new window — agentId is in the payload (agent.reload requires it).
      expect(connMap.notify).toHaveBeenCalledWith("a1", "agent.terminate", { agentId: "a1" });
    });

    it("does NOT terminate on a finite → finite idle change (self-heals)", async () => {
      query
        .mockResolvedValueOnce([[{ idle_timeout_sec: 300 }], []]) // pre-read old idle (finite)
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "a1" }], []]);

      await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: { idle_timeout_sec: 600 },
      }));

      // 300→600 self-heals: the box self-destructs on its current 300s window and
      // the next spawn reads 600 — no need to disrupt a live box.
      expect(connMap.notify).not.toHaveBeenCalled();
    });

    it("does NOT terminate when staying resident (0 → 0)", async () => {
      query
        .mockResolvedValueOnce([[{ idle_timeout_sec: 0 }], []])
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "a1" }], []]);

      await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: { idle_timeout_sec: 0 },
      }));

      expect(connMap.notify).not.toHaveBeenCalled();
    });

    it("does NOT terminate when switching finite → Resident (300 → 0)", async () => {
      query
        .mockResolvedValueOnce([[{ idle_timeout_sec: 300 }], []])
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "a1" }], []]);

      await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: { idle_timeout_sec: 0 },
      }));

      // Going resident needs no recycle: the box self-destructs on its current
      // finite window, and the next spawn comes up resident.
      expect(connMap.notify).not.toHaveBeenCalled();
    });

    it("terminates when the stored idle is a stringified \"0\" (driver coercion)", async () => {
      // Defends the Number() coercion: a string old value must still read as
      // resident, otherwise the 0→finite recycle would silently not fire.
      query
        .mockResolvedValueOnce([[{ idle_timeout_sec: "0" }], []]) // string, not number
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "a1" }], []]);

      await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: { idle_timeout_sec: 300 },
      }));

      expect(connMap.notify).toHaveBeenCalledWith("a1", "agent.terminate", { agentId: "a1" });
    });

    it("does NOT terminate when the old idle row is missing/null (no false 0)", async () => {
      // Guards Number(null) === 0: a missing/null old value must NOT be treated
      // as resident → no spurious terminate.
      query
        .mockResolvedValueOnce([[{ idle_timeout_sec: null }], []])
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "a1" }], []]);

      await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: { idle_timeout_sec: 300 },
      }));

      expect(connMap.notify).not.toHaveBeenCalled();
    });

    it("terminates on 0 → sub-300 and persists the floored value (300)", async () => {
      query
        .mockResolvedValueOnce([[{ idle_timeout_sec: 0 }], []])
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "a1" }], []]);

      await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: { idle_timeout_sec: 100 }, // positive but below the 300 floor
      }));

      // 0 → positive (even pre-floor) is the stuck transition → terminate.
      expect(connMap.notify).toHaveBeenCalledWith("a1", "agent.terminate", { agentId: "a1" });
      // The UPDATE (2nd query) persists the normalized/floored value, proving the
      // converged single-normalize path feeds the SET clause.
      const updateValues = query.mock.calls[1][1] as unknown[];
      expect(updateValues[0]).toBe(300);
    });

    it("updates model_routing as a standalone field", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "a1" }], []]);

      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: {
          model_routing: {
            enabled: true,
            cooldownMsByKind: { rate_limit: 0 },
            candidates: [{ provider: "openai", modelId: "gpt-4" }],
          },
        },
      }));

      expect(status).toBe(200);
      expect(query.mock.calls[0][0]).toContain("model_routing = ?");
      expect(JSON.parse(query.mock.calls[0][1][0])).toEqual({
        enabled: true,
        strategy: "ordered_fallback",
        cooldownMsByKind: { rate_limit: 0 },
        candidates: [{ provider: "openai", modelId: "gpt-4" }],
      });
    });

    it("stores tool_capabilities and pushes a tools reload on change", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "a1" }], []]);

      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: { tool_capabilities: ["read_files", "run_commands", "read_files"] },
      }));

      expect(status).toBe(200);
      expect(query.mock.calls[0][0]).toContain("tool_capabilities = ?");
      // Deduped JSON array of group keys.
      expect(JSON.parse(query.mock.calls[0][1][0])).toEqual(["read_files", "run_commands"]);
      expect(connMap.notify).toHaveBeenCalledWith("a1", "agent.reload", {
        agentId: "a1",
        resources: ["tools"],
      });
    });

    it("clears tool_capabilities (empty array → null) and still pushes a reload", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "a1" }], []]);

      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: { tool_capabilities: [] },
      }));

      expect(status).toBe(200);
      expect(query.mock.calls[0][0]).toContain("tool_capabilities = ?");
      expect(query.mock.calls[0][1][0]).toBeNull();
      expect(connMap.notify).toHaveBeenCalledWith("a1", "agent.reload", {
        agentId: "a1",
        resources: ["tools"],
      });
    });

    it("does not push a tools reload when tool_capabilities is absent", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "a1" }], []]);

      await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: { name: "rename-only" },
      }));

      expect(connMap.notify).not.toHaveBeenCalled();
    });

    it("rejects a non-array tool_capabilities with 400", async () => {
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "PUT",
        body: { tool_capabilities: "read_files" },
      }));

      expect(status).toBe(400);
      expect(body.error).toContain("tool_capabilities");
    });
  });

  // ── DELETE /api/v1/agents/:id ────────────────────────────
  describe("DELETE /api/v1/agents/:id", () => {
    it("returns 404 when missing", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a-gone",
        method: "DELETE",
      }));
      expect(status).toBe(404);
    });

    it("terminates runtime then deletes", async () => {
      query
        .mockResolvedValueOnce([[{ id: "a1" }], []])  // existence
        .mockResolvedValueOnce([undefined, []]);       // delete
      connMap.sendCommand = vi.fn().mockResolvedValue({ ok: true });

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "DELETE",
      }));

      expect(status).toBe(200);
      expect(body.deleted).toBe(true);
      expect(connMap.sendCommand).toHaveBeenCalledWith("a1", "agent.terminate", expect.any(Object));
    });

    it("still deletes from DB when runtime terminate fails", async () => {
      query
        .mockResolvedValueOnce([[{ id: "a1" }], []])
        .mockResolvedValueOnce([undefined, []]);
      connMap.sendCommand = vi.fn().mockResolvedValue({ ok: false, error: "no runtime" });

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1",
        method: "DELETE",
      }));

      expect(status).toBe(200);
      expect(body.terminate.ok).toBe(false);
    });
  });

  // ── PUT /api/v1/agents/:id/resources ─────────────────────
  describe("PUT /api/v1/agents/:id/resources", () => {
    it("returns 404 when agent missing", async () => {
      query.mockResolvedValueOnce([[], []]);  // existence check
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a-gone/resources",
        method: "PUT",
        body: { cluster_ids: ["c1"] },
      }));
      expect(status).toBe(404);
    });

    it("rebinds clusters + hosts + skills in a transaction", async () => {
      query.mockResolvedValueOnce([[{ id: "a1" }], []]);  // existence

      // Transaction: DELETE + INSERT for each resource type
      conn.query.mockResolvedValue([undefined, []]);

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1/resources",
        method: "PUT",
        body: {
          cluster_ids: ["c1", "c2"],
          host_ids: [],
          skill_ids: ["s1"],
        },
      }));

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(conn.commit).toHaveBeenCalled();

      // Two cluster inserts, zero host inserts, one skill insert, plus 3 DELETE statements
      const inserts = conn.query.mock.calls.filter(c => (c[0] as string).startsWith("INSERT"));
      expect(inserts.length).toBe(3);

      expect(connMap.notify).toHaveBeenCalledWith("a1", "agent.reload", { agentId: "a1" });
    });

    it("rolls back on transaction failure", async () => {
      query.mockResolvedValueOnce([[{ id: "a1" }], []]);
      conn.query
        .mockResolvedValueOnce([undefined, []])            // DELETE agent_clusters
        .mockRejectedValueOnce(new Error("constraint"));   // INSERT agent_clusters fails

      // Router.handle wraps in try/catch and responds 500 via rest-router top-level error handler.
      // We can assert via conn.rollback being called.
      try {
        await runRoute(router, fakeReq({
          url: "/api/v1/agents/a1/resources",
          method: "PUT",
          body: { cluster_ids: ["c1"] },
        }));
      } catch { /* rest-router writes 500 directly */ }

      // Wait for queued work
      await new Promise(r => setImmediate(r));
      expect(conn.rollback).toHaveBeenCalled();
      expect(conn.release).toHaveBeenCalled();
    });
  });

  // ── GET /api/v1/agents/:id/resources ─────────────────────
  describe("GET /api/v1/agents/:id/resources", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1/resources",
        method: "GET",
        headers: { authorization: "" },
      }));
      expect(status).toBe(401);
    });

    it("returns bindings grouped by type", async () => {
      query
        .mockResolvedValueOnce([[{ id: "c1", name: "cluster" }], []])
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[{ id: "s1", name: "skill" }], []])
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[{ id: "ch1", name: "lark" }], []])
        .mockResolvedValueOnce([[], []]);

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/agents/a1/resources",
        method: "GET",
      }));

      expect(status).toBe(200);
      expect(body.clusters).toHaveLength(1);
      expect(body.hosts).toHaveLength(0);
      expect(body.skills).toHaveLength(1);
      expect(body.channels).toHaveLength(1);
    });
  });

  // ── API Keys ─────────────────────────────────────────────
  describe("API keys", () => {
    describe("GET /api/v1/siclaw/agents/:id/api-keys", () => {
      it("admin lists all keys for the agent (no owner filter)", async () => {
        query.mockResolvedValueOnce([[{ id: "k1", name: "test" }], []]);
        const { status, body } = await runRoute(router, fakeReq({
          url: "/api/v1/siclaw/agents/a1/api-keys",
          method: "GET",
        }));
        expect(status).toBe(200);
        expect(body.data).toHaveLength(1);
        // admin → filter on agent only
        expect(query.mock.calls[0][1]).toEqual(["a1"]);
        expect(query.mock.calls[0][0]).not.toMatch(/created_by = \?/);
      });

      it("regular user lists only their own keys (created_by filter)", async () => {
        query.mockResolvedValueOnce([[{ id: "k1", created_by: "u1" }], []]);
        const { status, body } = await runRoute(router, fakeReq({
          url: "/api/v1/siclaw/agents/a1/api-keys",
          method: "GET",
          headers: { authorization: `Bearer ${USER_TOKEN}` },
        }));
        expect(status).toBe(200);
        expect(body.data).toHaveLength(1);
        // user → scoped to (agent, self)
        expect(query.mock.calls[0][0]).toMatch(/created_by = \?/);
        expect(query.mock.calls[0][1]).toEqual(["a1", "u1"]);
      });
    });

    describe("POST /api/v1/siclaw/agents/:id/api-keys", () => {
      it("creates a key and returns plaintext once", async () => {
        query
          .mockResolvedValueOnce([undefined, []])
          .mockResolvedValueOnce([[{ id: "k1", agent_id: "a1", name: "test" }], []]);

        const { status, body } = await runRoute(router, fakeReq({
          url: "/api/v1/siclaw/agents/a1/api-keys",
          method: "POST",
          body: { name: "test" },
        }));

        expect(status).toBe(201);
        expect(body.key).toMatch(/^sk-[a-f0-9]+$/);
      });

      it("a regular user may create a key, stamped created_by = caller", async () => {
        query
          .mockResolvedValueOnce([undefined, []])
          .mockResolvedValueOnce([[{ id: "k1", agent_id: "a1", name: "mine" }], []]);

        const { status } = await runRoute(router, fakeReq({
          url: "/api/v1/siclaw/agents/a1/api-keys",
          method: "POST",
          body: { name: "mine" },
          headers: { authorization: `Bearer ${USER_TOKEN}` },
        }));

        expect(status).toBe(201);
        // INSERT args: [id, agentId, name, keyHash, plaintext, keyPrefix, expires, created_by]
        expect(query.mock.calls[0][1][7]).toBe("u1");
      });
    });

    describe("DELETE /api/v1/siclaw/agents/:id/api-keys/:kid", () => {
      it("returns 404 when key not found for agent", async () => {
        query.mockResolvedValueOnce([[], []]);
        const { status } = await runRoute(router, fakeReq({
          url: "/api/v1/siclaw/agents/a1/api-keys/k-gone",
          method: "DELETE",
        }));
        expect(status).toBe(404);
      });

      it("admin deletes any key and its service accounts", async () => {
        query
          .mockResolvedValueOnce([[{ id: "k1", created_by: "someone-else" }], []])
          .mockResolvedValueOnce([undefined, []])  // service accounts delete
          .mockResolvedValueOnce([undefined, []]); // key delete

        const { status, body } = await runRoute(router, fakeReq({
          url: "/api/v1/siclaw/agents/a1/api-keys/k1",
          method: "DELETE",
        }));
        expect(status).toBe(200);
        expect(body).toEqual({ ok: true });
      });

      it("a regular user may delete their own key", async () => {
        query
          .mockResolvedValueOnce([[{ id: "k1", created_by: "u1" }], []])
          .mockResolvedValueOnce([undefined, []])
          .mockResolvedValueOnce([undefined, []]);

        const { status } = await runRoute(router, fakeReq({
          url: "/api/v1/siclaw/agents/a1/api-keys/k1",
          method: "DELETE",
          headers: { authorization: `Bearer ${USER_TOKEN}` },
        }));
        expect(status).toBe(200);
      });

      it("a regular user cannot delete someone else's key (403, no delete issued)", async () => {
        query.mockResolvedValueOnce([[{ id: "k1", created_by: "admin-1" }], []]);

        const { status } = await runRoute(router, fakeReq({
          url: "/api/v1/siclaw/agents/a1/api-keys/k1",
          method: "DELETE",
          headers: { authorization: `Bearer ${USER_TOKEN}` },
        }));
        expect(status).toBe(403);
        // only the SELECT ran — no DELETE statements
        expect(query.mock.calls).toHaveLength(1);
      });
    });
  });
});
