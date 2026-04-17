import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import { createRestRouter } from "../gateway/rest-router.js";
import { registerAdapterRoutes } from "./adapter.js";

const INTERNAL_SECRET = "test-internal-secret";

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

/** Collapse whitespace so SQL assertions tolerate line breaks + indentation. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

beforeEach(() => vi.clearAllMocks());

describe("registerAdapterRoutes — is_production filter", () => {
  let router: ReturnType<typeof createRestRouter>;
  let query: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router = createRestRouter();
    registerAdapterRoutes(router, INTERNAL_SECRET);
    query = vi.fn();
    (getDb as any).mockReturnValue({ query });
  });

  // ── credential-list ────────────────────────────────────────
  describe("POST /api/internal/siclaw/credential-list", () => {
    it("clusters query joins agents and enforces a.is_production = c.is_production", async () => {
      query.mockResolvedValueOnce([[], []]);
      await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/credential-list",
        method: "POST",
        headers: { "x-cert-agent-id": "a1" },
        body: {},
      }));
      const sql: string = flat(query.mock.calls[0][0]);
      expect(sql).toContain("FROM agent_clusters ac");
      expect(sql).toContain("JOIN clusters c ON ac.cluster_id = c.id");
      expect(sql).toContain("JOIN agents a ON ac.agent_id = a.id");
      expect(sql).toContain("a.is_production = c.is_production");
      expect(query.mock.calls[0][1]).toEqual(["a1"]);
    });

    it("hosts query joins agents and enforces a.is_production = h.is_production", async () => {
      query.mockResolvedValueOnce([[], []]);
      await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/credential-list",
        method: "POST",
        headers: { "x-cert-agent-id": "a1" },
        body: { kind: "host" },
      }));
      const sql: string = flat(query.mock.calls[0][0]);
      expect(sql).toContain("FROM agent_hosts ah");
      expect(sql).toContain("JOIN hosts h ON ah.host_id = h.id");
      expect(sql).toContain("JOIN agents a ON ah.agent_id = a.id");
      expect(sql).toContain("a.is_production = h.is_production");
    });

    it("returns only clusters the DB surfaced (mismatched env already filtered out)", async () => {
      // Simulate: agent is prod; only the prod cluster survives the is_production join.
      query.mockResolvedValueOnce([[
        { name: "prod-c", api_server: "https://p", is_production: 1, kubeconfig: "k", description: null, debug_image: null },
      ], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/credential-list",
        method: "POST",
        headers: { "x-cert-agent-id": "a1" },
        body: {},
      }));
      expect(status).toBe(200);
      expect(body.clusters).toEqual([
        { name: "prod-c", is_production: true, api_server: "https://p" },
      ]);
    });

    it("returns empty list when the env-filter wipes out stale cross-env bindings", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/credential-list",
        method: "POST",
        headers: { "x-cert-agent-id": "a1" },
        body: {},
      }));
      expect(status).toBe(200);
      expect(body.clusters).toEqual([]);
    });

    it("requires X-Cert-Agent-Id header", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/credential-list",
        method: "POST",
        body: {},
      }));
      expect(status).toBe(400);
    });

    it("rejects missing internal token", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/credential-list",
        method: "POST",
        headers: { "x-auth-token": "", "x-cert-agent-id": "a1" },
        body: {},
      }));
      expect(status).toBe(401);
    });
  });

  // ── credential-request ─────────────────────────────────────
  describe("POST /api/internal/siclaw/credential-request — cluster", () => {
    it("binding-check query joins agents + clusters with is_production match", async () => {
      query
        .mockResolvedValueOnce([[{ id: "c-id", name: "c1", kubeconfig: "k" }], []])  // name lookup
        .mockResolvedValueOnce([[{ "1": 1 }], []]);                                    // binding check
      await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/credential-request",
        method: "POST",
        headers: { "x-cert-agent-id": "a1" },
        body: { source: "cluster", source_id: "c1" },
      }));
      const bindingSql: string = flat(query.mock.calls[1][0]);
      expect(bindingSql).toContain("FROM agent_clusters ac");
      expect(bindingSql).toContain("JOIN agents a ON ac.agent_id = a.id");
      expect(bindingSql).toContain("JOIN clusters c ON ac.cluster_id = c.id");
      expect(bindingSql).toContain("a.is_production = c.is_production");
      expect(query.mock.calls[1][1]).toEqual(["a1", "c-id"]);
    });

    it("returns 403 when binding-check finds no matching-env row", async () => {
      query
        .mockResolvedValueOnce([[{ id: "c-id", name: "c1", kubeconfig: "k" }], []])
        .mockResolvedValueOnce([[], []]);  // env mismatch → filter wipes it out
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/credential-request",
        method: "POST",
        headers: { "x-cert-agent-id": "a1" },
        body: { source: "cluster", source_id: "c1" },
      }));
      expect(status).toBe(403);
      expect(body.error).toMatch(/not bound to this cluster/);
    });

    it("returns the cluster credential when binding-check matches", async () => {
      query
        .mockResolvedValueOnce([[{ id: "c-id", name: "c1", kubeconfig: "KUBECONFIG" }], []])
        .mockResolvedValueOnce([[{ "1": 1 }], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/credential-request",
        method: "POST",
        headers: { "x-cert-agent-id": "a1" },
        body: { source: "cluster", source_id: "c1" },
      }));
      expect(status).toBe(200);
      expect(body.credential.name).toBe("c1");
      expect(body.credential.files[0].content).toBe("KUBECONFIG");
    });

    it("returns 404 when cluster name is unknown", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/credential-request",
        method: "POST",
        headers: { "x-cert-agent-id": "a1" },
        body: { source: "cluster", source_id: "missing" },
      }));
      expect(status).toBe(404);
    });
  });

  describe("POST /api/internal/siclaw/credential-request — host", () => {
    it("binding-check query joins agents + hosts with is_production match", async () => {
      query
        .mockResolvedValueOnce([[{ id: "h-id", name: "h1", ip: "10.0.0.1", port: 22, username: "u", auth_type: "key", password: null, private_key: "KEY" }], []])
        .mockResolvedValueOnce([[{ "1": 1 }], []]);
      await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/credential-request",
        method: "POST",
        headers: { "x-cert-agent-id": "a1" },
        body: { source: "host", source_id: "h1" },
      }));
      const bindingSql: string = flat(query.mock.calls[1][0]);
      expect(bindingSql).toContain("FROM agent_hosts ah");
      expect(bindingSql).toContain("JOIN agents a ON ah.agent_id = a.id");
      expect(bindingSql).toContain("JOIN hosts h ON ah.host_id = h.id");
      expect(bindingSql).toContain("a.is_production = h.is_production");
      expect(query.mock.calls[1][1]).toEqual(["a1", "h-id"]);
    });

    it("returns 403 when binding-check finds no matching-env row", async () => {
      query
        .mockResolvedValueOnce([[{ id: "h-id", name: "h1", ip: "10.0.0.1", port: 22, username: "u", auth_type: "key", password: null, private_key: "K" }], []])
        .mockResolvedValueOnce([[], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/credential-request",
        method: "POST",
        headers: { "x-cert-agent-id": "a1" },
        body: { source: "host", source_id: "h1" },
      }));
      expect(status).toBe(403);
      expect(body.error).toMatch(/not bound to this host/);
    });
  });

  // ── agent-resources (admin panel backing query) ────────────
  describe("GET /api/internal/siclaw/agent/:agentId/resources", () => {
    it("cluster + host queries both enforce is_production match", async () => {
      // Promise.all order: [clusters, hosts, skills, mcp, agent]
      query
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[{ is_production: 1 }], []]);
      await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/agent/a1/resources",
        method: "GET",
      }));
      const clusterSql = flat(query.mock.calls[0][0]);
      const hostSql = flat(query.mock.calls[1][0]);
      expect(clusterSql).toContain("JOIN agents a ON ac.agent_id = a.id");
      expect(clusterSql).toContain("a.is_production = c.is_production");
      expect(hostSql).toContain("JOIN agents a ON ah.agent_id = a.id");
      expect(hostSql).toContain("a.is_production = h.is_production");
    });
  });

  // ── resource-manifest ──────────────────────────────────────
  describe("POST /api/internal/siclaw/resource-manifest", () => {
    it("both queries enforce is_production match", async () => {
      query.mockResolvedValue([[], []]);
      await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/resource-manifest",
        method: "POST",
        headers: { "x-cert-agent-id": "a1" },
        body: {},
      }));
      const clusterSql = flat(query.mock.calls[0][0]);
      const hostSql = flat(query.mock.calls[1][0]);
      expect(clusterSql).toContain("a.is_production = c.is_production");
      expect(hostSql).toContain("a.is_production = h.is_production");
    });
  });

  // ── host-search (agent-scoped) ─────────────────────────────
  describe("POST /api/internal/siclaw/host-search", () => {
    it("agent-scoped query enforces is_production match", async () => {
      query.mockResolvedValueOnce([[], []]);
      await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/host-search",
        method: "POST",
        headers: { "x-cert-agent-id": "a1" },
        body: {},
      }));
      const sql = flat(query.mock.calls[0][0]);
      expect(sql).toContain("JOIN agents a ON ah.agent_id = a.id");
      expect(sql).toContain("a.is_production = h.is_production");
    });

    it("agent-less search stays unfiltered (admin listing, different code path)", async () => {
      query.mockResolvedValueOnce([[], []]);
      await runRoute(router, fakeReq({
        url: "/api/internal/siclaw/host-search",
        method: "POST",
        body: {},
      }));
      const sql = flat(query.mock.calls[0][0]);
      expect(sql).not.toContain("agent_hosts");
      expect(sql).not.toContain("is_production");
    });
  });
});
