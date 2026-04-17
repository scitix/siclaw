/**
 * REST-layer smoke tests for `registerAdapterRoutes`.
 *
 * The bulk of adapter business logic is exercised via `buildAdapterRpcHandlers`
 * in `adapter-rpc.test.ts` (40 handlers). This file focuses on the thin
 * REST shim: internal-auth enforcement, route matching, param parsing,
 * and response codes for representative endpoints across each domain
 * (agent, resources, credential, chat, tasks, metrics, channel, config).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import { createRestRouter } from "../gateway/rest-router.js";
import { registerAdapterRoutes } from "./adapter.js";

const INTERNAL_SECRET = "portal-internal-secret";

function fakeReq(opts: { url: string; method: string; headers?: Record<string, string>; body?: unknown }): any {
  const em = new EventEmitter() as any;
  em.url = opts.url;
  em.method = opts.method;
  em.headers = { "x-auth-token": INTERNAL_SECRET, ...(opts.headers ?? {}) };
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

beforeEach(() => vi.clearAllMocks());

describe("registerAdapterRoutes — auth + routing", () => {
  let router: ReturnType<typeof createRestRouter>;
  let query: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router = createRestRouter();
    registerAdapterRoutes(router, INTERNAL_SECRET);
    query = vi.fn();
    (getDb as any).mockReturnValue({ query, getConnection: vi.fn() });
  });

  // ── Internal-auth enforcement (sampled across method/domain space) ──

  it("GET agent info rejects missing x-auth-token", async () => {
    const { status } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/agent/a1",
      method: "GET",
      headers: { "x-auth-token": "" },
    }));
    expect(status).toBe(401);
  });

  it("GET agent info rejects wrong x-auth-token", async () => {
    const { status } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/agent/a1",
      method: "GET",
      headers: { "x-auth-token": "not-the-secret" },
    }));
    expect(status).toBe(401);
  });

  it("POST check-access rejects wrong x-auth-token", async () => {
    const { status } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/check-access",
      method: "POST",
      headers: { "x-auth-token": "wrong" },
      body: { action: "review" },
    }));
    expect(status).toBe(401);
  });

  it("POST credential-request rejects wrong x-auth-token", async () => {
    const { status } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/credential-request",
      method: "POST",
      headers: { "x-auth-token": "" },
      body: {},
    }));
    expect(status).toBe(401);
  });

  // ── Representative happy/404 paths per domain ───────────────────────

  it("GET agent returns 404 when missing", async () => {
    query.mockResolvedValueOnce([[], []]);
    const { status } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/agent/missing",
      method: "GET",
    }));
    expect(status).toBe(404);
  });

  it("GET agent returns 200 when found", async () => {
    query.mockResolvedValueOnce([[
      { id: "a1", name: "A", description: "", status: "active", model_provider: "x", model_id: "y", system_prompt: "p", icon: null, color: null },
    ], []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/agent/a1",
      method: "GET",
    }));
    expect(status).toBe(200);
    expect(body.id).toBe("a1");
  });

  it("GET agent resources returns resource shape", async () => {
    query
      .mockResolvedValueOnce([[{ id: "c1", name: "cluster", api_server: "x" }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ skill_id: "s1" }], []])
      .mockResolvedValueOnce([[{ mcp_server_id: "m1" }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ is_production: 1 }], []]);

    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/agent/a1/resources",
      method: "GET",
    }));
    expect(status).toBe(200);
    expect(body.clusters).toHaveLength(1);
    expect(body.skill_ids).toEqual(["s1"]);
    expect(body.mcp_server_ids).toEqual(["m1"]);
    expect(body.is_production).toBe(true);
  });

  it("POST check-access returns allowed for non-review action", async () => {
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/check-access",
      method: "POST",
      body: { action: "run" },
    }));
    expect(status).toBe(200);
    expect(body.allowed).toBe(true);
  });

  it("POST check-access returns allowed=true for admin reviewer", async () => {
    query.mockResolvedValueOnce([[{ role: "admin", can_review_skills: 0 }], []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/check-access",
      method: "POST",
      body: { action: "review", user_id: "u1" },
    }));
    expect(status).toBe(200);
    expect(body.allowed).toBe(true);
  });

  it("POST credential-request returns 400 when source missing", async () => {
    const { status } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/credential-request",
      method: "POST",
      body: {},
    }));
    expect(status).toBe(400);
  });

  it("GET channels returns empty list", async () => {
    query.mockResolvedValueOnce([[], []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/channels",
      method: "GET",
    }));
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it("GET tasks active returns list shape", async () => {
    query.mockResolvedValueOnce([[
      { id: "t1", agent_id: "a1", name: "Cleanup", description: null, schedule: "0 * * * *", prompt: "p", status: "active", created_by: "u1", last_run_at: null, last_result: null },
    ], []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/tasks/active",
      method: "GET",
    }));
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
  });

  it("GET system-config returns key-value map", async () => {
    query.mockResolvedValueOnce([[
      { config_key: "feature.a", config_value: "true" },
      { config_key: "feature.b", config_value: null },
    ], []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/system-config",
      method: "GET",
    }));
    expect(status).toBe(200);
    expect(body.config).toEqual({ "feature.a": "true" });
  });

  it("GET model-provider/default returns null shape when no providers", async () => {
    query.mockResolvedValueOnce([[], []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/model-provider/default",
      method: "GET",
    }));
    expect(status).toBe(200);
    expect(body.provider).toBeNull();
  });

  // ── Agents-by-skill / mcp / cluster / host ──────────────────────────

  it("GET skill agents returns list", async () => {
    query.mockResolvedValueOnce([[{ agent_id: "a1" }, { agent_id: "a2" }], []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/skill/s1/agents",
      method: "GET",
    }));
    expect(status).toBe(200);
    expect(body.agent_ids).toEqual(["a1", "a2"]);
  });

  it("GET mcp agents returns list", async () => {
    query.mockResolvedValueOnce([[{ agent_id: "a1" }], []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/mcp/m1/agents",
      method: "GET",
    }));
    expect(status).toBe(200);
    expect(body.agent_ids).toEqual(["a1"]);
  });

  it("GET cluster agents returns list", async () => {
    query.mockResolvedValueOnce([[{ agent_id: "a3" }], []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/cluster/c1/agents",
      method: "GET",
    }));
    expect(status).toBe(200);
    expect(body.agent_ids).toEqual(["a3"]);
  });

  it("GET host agents returns list", async () => {
    query.mockResolvedValueOnce([[{ agent_id: "a4" }], []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/host/h1/agents",
      method: "GET",
    }));
    expect(status).toBe(200);
    expect(body.agent_ids).toEqual(["a4"]);
  });

  // ── Task CRUD endpoints ─────────────────────────────────────────────

  it("POST agent-tasks/create inserts and returns row", async () => {
    query
      .mockResolvedValueOnce([undefined, []])
      .mockResolvedValueOnce([[{ id: "t1", name: "New" }], []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/agent-tasks/create",
      method: "POST",
      body: { id: "t1", agent_id: "a1", user_id: "u1", name: "New", schedule: "0 * * * *", prompt: "go" },
    }));
    expect(status).toBe(201);
    expect(body.id).toBe("t1");
  });

  it("GET tasks/:id/status returns status", async () => {
    query.mockResolvedValueOnce([[{ status: "active" }], []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/tasks/t1/status",
      method: "GET",
    }));
    expect(status).toBe(200);
    expect(body.status).toBe("active");
  });

  it("POST tasks/prune returns affectedRows counts", async () => {
    query
      .mockResolvedValueOnce([{ affectedRows: 2 }, []])
      .mockResolvedValueOnce([{ affectedRows: 3 }, []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/tasks/prune",
      method: "POST",
      body: { retention_days: 7 },
    }));
    expect(status).toBe(200);
    expect(body.sessions_deleted).toBe(2);
    expect(body.runs_deleted).toBe(3);
  });

  // ── Channel RPC endpoints ───────────────────────────────────────────

  it("POST channel/resolve-binding returns null shape when no match", async () => {
    query.mockResolvedValueOnce([[], []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/channel/resolve-binding",
      method: "POST",
      body: { channel_id: "ch1", route_key: "g1" },
    }));
    expect(status).toBe(200);
    expect(body.binding).toBeNull();
  });

  // ── Metrics ─────────────────────────────────────────────────────────

  it("GET metrics/summary rejects invalid period", async () => {
    const { status } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/metrics/summary?period=invalid",
      method: "GET",
    }));
    expect(status).toBe(400);
  });

  it("GET metrics/audit returns logs with hasMore=false", async () => {
    query.mockResolvedValueOnce([[
      { id: "m1", sessionId: "s1", toolName: "bash", toolInput: "ls", outcome: "success", durationMs: 100, timestamp: "2024-01-01T00:00:00Z", userId: "u1", agentId: "a1" },
    ], []]);
    const { status, body } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/metrics/audit?limit=10",
      method: "GET",
    }));
    expect(status).toBe(200);
    expect(body.logs).toHaveLength(1);
    expect(body.hasMore).toBe(false);
  });

  it("GET metrics/audit/:id returns 404 when missing", async () => {
    query.mockResolvedValueOnce([[], []]);
    const { status } = await runRoute(router, fakeReq({
      url: "/api/internal/siclaw/metrics/audit/nope",
      method: "GET",
    }));
    expect(status).toBe(404);
  });
});
