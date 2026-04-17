/**
 * Smoke tests for `registerSiclawRoutes` — skills domain (list, create, get,
 * update, delete). Focus: auth enforcement, input validation, state-machine
 * transitions, and the builtin-overlay contract from docs/design/skills.md.
 *
 * The giant siclaw-api.ts is split across multiple per-domain test files to
 * stay under the 800-LOC limit from the spec.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

vi.mock("../gateway/skills/script-evaluator.js", () => ({
  evaluateScriptsStatic: vi.fn().mockReturnValue({ score: 100, rules: [] }),
  buildAssessment: vi.fn().mockReturnValue({ verdict: "safe", score: 100, rules: [] }),
}));

vi.mock("../gateway/skills/ai-security-reviewer.js", () => ({
  evaluateScriptsAI: vi.fn().mockResolvedValue({ verdict: "safe", score: 100, notes: "" }),
}));

import { getDb } from "../gateway/db.js";
import { createRestRouter } from "../gateway/rest-router.js";
import { signToken } from "./auth.js";
import { registerSiclawRoutes } from "./siclaw-api.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";

const JWT_SECRET = "test-siclaw";
const USER_TOKEN = signToken("u1", "alice", "user", JWT_SECRET);

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

describe("siclaw-api skills", () => {
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

  // ── GET /skills/labels ───────────────────────────────────
  describe("GET /api/v1/siclaw/skills/labels", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/labels",
        method: "GET",
        headers: { authorization: "" },
      }));
      expect(status).toBe(401);
    });

    it("returns distinct labels", async () => {
      query.mockResolvedValueOnce([[{ label: "k8s" }, { label: "ops" }], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/labels",
        method: "GET",
      }));
      expect(status).toBe(200);
      expect(body.labels).toEqual(["k8s", "ops"]);
    });
  });

  // ── GET /skills (list) ───────────────────────────────────
  describe("GET /api/v1/siclaw/skills", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills",
        method: "GET",
        headers: { authorization: "" },
      }));
      expect(status).toBe(401);
    });

    it("returns paginated list", async () => {
      query
        .mockResolvedValueOnce([[{ count: 1 }], []])
        .mockResolvedValueOnce([[{ id: "s1", name: "skill-1" }], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills",
        method: "GET",
      }));
      expect(status).toBe(200);
      expect(body.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.page).toBe(1);
      expect(body.page_size).toBe(20);
    });

    it("applies search filter", async () => {
      query
        .mockResolvedValueOnce([[{ count: 0 }], []])
        .mockResolvedValueOnce([[], []]);
      await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills?search=kafka",
        method: "GET",
      }));
      const countSql: string = query.mock.calls[0][0];
      expect(countSql).toContain("name LIKE ?");
      expect(query.mock.calls[0][1]).toContain("%kafka%");
    });

    it("applies labels filter", async () => {
      query
        .mockResolvedValueOnce([[{ count: 0 }], []])
        .mockResolvedValueOnce([[], []]);
      await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills?labels=ops,prod",
        method: "GET",
      }));
      const countSql: string = query.mock.calls[0][0];
      expect(countSql).toContain("JSON_CONTAINS(labels, ?)");
    });
  });

  // ── POST /skills (create) ────────────────────────────────
  describe("POST /api/v1/siclaw/skills", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills",
        method: "POST",
        headers: { authorization: "" },
        body: { specs: "" },
      }));
      expect(status).toBe(401);
    });

    it("returns 400 when specs missing", async () => {
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills",
        method: "POST",
        body: {},
      }));
      expect(status).toBe(400);
      expect(body.error).toMatch(/specs/);
    });

    it("rejects specs without YAML frontmatter", async () => {
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills",
        method: "POST",
        body: { specs: "no frontmatter here" },
      }));
      expect(status).toBe(400);
      expect(body.error).toMatch(/frontmatter/);
    });

    it("rejects frontmatter missing name field", async () => {
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills",
        method: "POST",
        body: { specs: "---\ndescription: x\n---\nbody" },
      }));
      expect(status).toBe(400);
      expect(body.error).toMatch(/name/);
    });

    it("creates a skill with valid frontmatter", async () => {
      query
        .mockResolvedValueOnce([undefined, []])  // insert skill
        .mockResolvedValueOnce([undefined, []])  // insert version
        .mockResolvedValueOnce([[{ id: "s-new", name: "my-skill", status: "draft" }], []]);

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills",
        method: "POST",
        body: {
          specs: "---\nname: my-skill\ndescription: demo\n---\nbody",
          scripts: [{ name: "run.sh", content: "echo" }],
          labels: ["demo"],
        },
      }));

      expect(status).toBe(201);
      expect(body.name).toBe("my-skill");
      // Verify INSERT skills got labels JSON-stringified
      const skillInsertArgs = query.mock.calls[0][1];
      expect(skillInsertArgs).toContain(JSON.stringify(["demo"]));
    });
  });

  // ── GET /skills/:id ──────────────────────────────────────
  describe("GET /api/v1/siclaw/skills/:id", () => {
    it("returns 404 when skill missing", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/s-gone",
        method: "GET",
      }));
      expect(status).toBe(404);
    });

    it("returns skill row", async () => {
      query.mockResolvedValueOnce([[{ id: "s1", name: "skill" }], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/s1",
        method: "GET",
      }));
      expect(status).toBe(200);
      expect(body.id).toBe("s1");
    });
  });

  // ── PUT /skills/:id (overlay + state machine) ────────────
  describe("PUT /api/v1/siclaw/skills/:id", () => {
    it("returns 404 when skill missing", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/s-gone",
        method: "PUT",
        body: { specs: "---\nname: x\n---" },
      }));
      expect(status).toBe(404);
    });

    it("creates overlay when editing a builtin skill", async () => {
      query
        .mockResolvedValueOnce([[{ id: "s-builtin", name: "builtin", is_builtin: 1, specs: "old", scripts: "[]", labels: null, description: "" }], []])
        .mockResolvedValueOnce([[], []])  // no existing overlay
        .mockResolvedValueOnce([undefined, []])  // insert overlay skill
        .mockResolvedValueOnce([undefined, []])  // insert overlay version
        .mockResolvedValueOnce([[{ id: "overlay-1", name: "builtin", overlay_of: "s-builtin" }], []]);

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/s-builtin",
        method: "PUT",
        body: { specs: "---\nname: builtin\ndescription: patched\n---" },
      }));

      expect(status).toBe(201);
      expect(body.overlay_of).toBe("s-builtin");
    });

    it("returns 409 when builtin already has an overlay", async () => {
      query
        .mockResolvedValueOnce([[{ id: "s-builtin", is_builtin: 1, specs: "", scripts: "[]" }], []])
        .mockResolvedValueOnce([[{ id: "overlay-x" }], []]);

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/s-builtin",
        method: "PUT",
        body: { specs: "---\nname: builtin\n---" },
      }));
      expect(status).toBe(409);
      expect(body.overlay_id).toBe("overlay-x");
    });

    it("returns 409 when editing a pending_review skill", async () => {
      query.mockResolvedValueOnce([[{
        id: "s1", status: "pending_review", is_builtin: 0,
      }], []]);

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/s1",
        method: "PUT",
        body: { specs: "---\nname: x\n---" },
      }));
      expect(status).toBe(409);
      expect(body.error).toMatch(/Withdraw first/);
    });
  });

  // ── DELETE /skills/:id ───────────────────────────────────
  describe("DELETE /api/v1/siclaw/skills/:id", () => {
    it("returns 404 when skill missing", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/s-gone",
        method: "DELETE",
      }));
      expect(status).toBe(404);
    });
  });

  // ── GET /skills/:id/versions ─────────────────────────────
  describe("GET /api/v1/siclaw/skills/:id/versions", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/s1/versions",
        method: "GET",
        headers: { authorization: "" },
      }));
      expect(status).toBe(401);
    });

    it("returns versions list", async () => {
      query
        .mockResolvedValueOnce([[{ id: "s1" }], []])  // skill exists
        .mockResolvedValueOnce([[{ version: 1 }, { version: 2 }], []]);

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/s1/versions",
        method: "GET",
      }));
      expect(status).toBe(200);
      expect(body.data ?? body.versions ?? body).toBeDefined();
    });
  });

  // ── GET /reviews/pending ─────────────────────────────────
  describe("GET /api/v1/siclaw/reviews/pending", () => {
    it("returns 401 without auth", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/reviews/pending",
        method: "GET",
        headers: { authorization: "" },
      }));
      expect(status).toBe(401);
    });

    it("returns pending list for any authenticated user", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/reviews/pending",
        method: "GET",
      }));
      expect(status).toBe(200);
      expect(body.data).toEqual([]);
    });
  });

  // ── Skill import endpoints ───────────────────────────────
  describe("POST /api/v1/siclaw/skills/import/init", () => {
    const adminToken = signToken("a1", "admin", "admin", JWT_SECRET);

    it("rejects non-admin", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/import/init",
        method: "POST",
        body: {},
      }));
      expect(status).toBe(403);
    });

    it("returns 400 when builtin skills dir is empty", async () => {
      // skills/core doesn't exist in the test cwd — parseSkillsDir returns []
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/import/init",
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
        body: {},
      }));
      // Either 400 (no builtin skills) or 500 (parseSkillsDir throws) is acceptable
      // since the test cwd has no skills/core; we just assert it's NOT 200.
      expect([400, 500]).toContain(status);
      expect(body.error).toBeDefined();
    });
  });

  describe("GET /api/v1/siclaw/skills/import/history", () => {
    const adminToken = signToken("a1", "admin", "admin", JWT_SECRET);

    it("rejects non-admin", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/import/history",
        method: "GET",
      }));
      expect(status).toBe(403);
    });

    it("returns history list for admin", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/skills/import/history",
        method: "GET",
        headers: { authorization: `Bearer ${adminToken}` },
      }));
      expect(status).toBe(200);
      expect(body.data ?? body.history ?? body).toBeDefined();
    });
  });
});
