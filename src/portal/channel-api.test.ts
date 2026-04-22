import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import { createRestRouter } from "../gateway/rest-router.js";
import { signToken } from "./auth.js";
import { registerChannelRoutes } from "./channel-api.js";

const JWT_SECRET = "test-channel-secret";
const ADMIN_TOKEN = signToken("admin-1", "admin", "admin", JWT_SECRET);
const USER_TOKEN = signToken("user-1", "user", "user", JWT_SECRET);

// ── HTTP req/res helpers ─────────────────────────────────────

function fakeReq(opts: { url: string; method: string; headers?: Record<string, string>; body?: unknown } = { url: "/", method: "GET" }): any {
  const em = new EventEmitter() as any;
  em.url = opts.url;
  em.method = opts.method;
  em.headers = { authorization: `Bearer ${ADMIN_TOKEN}`, ...(opts.headers ?? {}) };
  // Schedule body emission on next tick so the handler can subscribe first.
  if (opts.body !== undefined) {
    queueMicrotask(() => {
      em.emit("data", Buffer.from(JSON.stringify(opts.body)));
      em.emit("end");
    });
  } else {
    queueMicrotask(() => em.emit("end"));
  }
  return em;
}

function fakeRes() {
  const r: any = new EventEmitter();
  r._status = 0;
  r._body = "";
  r._headers = {};
  r.headersSent = false;
  r.writeHead = vi.fn((status: number, headers?: Record<string, string>) => {
    r._status = status;
    r._headers = headers;
    r.headersSent = true;
    return r;
  });
  r.end = vi.fn((body?: string) => { if (body !== undefined) r._body = body; r.emit("finish"); return r; });
  return r;
}

/** Run router.handle and wait for the response to end. */
function runRoute(router: ReturnType<typeof createRestRouter>, req: any, res: any): Promise<void> {
  return new Promise((resolve, reject) => {
    res.once("finish", resolve);
    res.end = vi.fn((body?: string) => { if (body !== undefined) res._body = body; resolve(); return res; });
    res.writeHead = vi.fn((status: number, headers?: Record<string, string>) => {
      res._status = status;
      res._headers = headers;
      res.headersSent = true;
      return res;
    });
    try {
      const handled = router.handle(req, res);
      if (!handled) reject(new Error("route not matched"));
    } catch (err) {
      reject(err);
    }
  });
}

function parseBody(res: any): any {
  if (!res._body) return null;
  return JSON.parse(res._body);
}

// ── Tests ────────────────────────────────────────────────────

describe("registerChannelRoutes", () => {
  let router: ReturnType<typeof createRestRouter>;
  let query: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router = createRestRouter();
    registerChannelRoutes(router, JWT_SECRET);
    query = vi.fn();
    (getDb as any).mockReturnValue({ query });
  });

  // ── GET /api/v1/channels ─────────────────────────────────
  describe("GET /api/v1/channels", () => {
    it("returns 401 when not authenticated", async () => {
      const req = fakeReq({ url: "/api/v1/channels", method: "GET", headers: { authorization: "" } });
      const res = fakeRes();
      await runRoute(router, req, res);
      expect(res._status).toBe(401);
    });

    it("returns 403 when user is not admin", async () => {
      const req = fakeReq({ url: "/api/v1/channels", method: "GET", headers: { authorization: `Bearer ${USER_TOKEN}` } });
      const res = fakeRes();
      await runRoute(router, req, res);
      expect(res._status).toBe(403);
    });

    it("returns list of channels", async () => {
      query.mockResolvedValueOnce([[
        { id: "c1", name: "slack", type: "slack", status: "active", created_by: "u1", created_at: "2024-01-01", updated_at: "2024-01-02" },
      ], []]);
      const req = fakeReq({ url: "/api/v1/channels", method: "GET" });
      const res = fakeRes();
      await runRoute(router, req, res);
      expect(res._status).toBe(200);
      expect(parseBody(res)).toEqual({ data: [expect.objectContaining({ id: "c1" })] });
    });
  });

  // ── POST /api/v1/channels ────────────────────────────────
  describe("POST /api/v1/channels", () => {
    it("returns 400 when required fields missing", async () => {
      const req = fakeReq({ url: "/api/v1/channels", method: "POST", body: { name: "slack" } });
      const res = fakeRes();
      await runRoute(router, req, res);
      expect(res._status).toBe(400);
      expect(parseBody(res).error).toContain("required");
    });

    it("creates channel and returns 201 with the new row", async () => {
      query
        .mockResolvedValueOnce([undefined, []])  // insert
        .mockResolvedValueOnce([[{ id: "c-new", name: "slack", type: "slack", status: "active" }], []]); // select

      const req = fakeReq({
        url: "/api/v1/channels",
        method: "POST",
        body: { name: "slack", type: "slack", config: { token: "x" } },
      });
      const res = fakeRes();
      await runRoute(router, req, res);

      expect(res._status).toBe(201);
      // Confirm stringified config was passed to the INSERT
      const insertArgs = query.mock.calls[0][1];
      expect(insertArgs[3]).toBe(JSON.stringify({ token: "x" }));
    });
  });

  // ── GET /api/v1/channels/:id ─────────────────────────────
  describe("GET /api/v1/channels/:id", () => {
    it("returns 404 when channel missing", async () => {
      query.mockResolvedValueOnce([[], []]);
      const req = fakeReq({ url: "/api/v1/channels/missing", method: "GET" });
      const res = fakeRes();
      await runRoute(router, req, res);
      expect(res._status).toBe(404);
    });

    it("returns channel row when found", async () => {
      query.mockResolvedValueOnce([[{ id: "c1", name: "slack", config: "{}" }], []]);
      const req = fakeReq({ url: "/api/v1/channels/c1", method: "GET" });
      const res = fakeRes();
      await runRoute(router, req, res);
      expect(res._status).toBe(200);
      expect(parseBody(res).id).toBe("c1");
    });
  });

  // ── PUT /api/v1/channels/:id ─────────────────────────────
  describe("PUT /api/v1/channels/:id", () => {
    it("returns 400 when body has no updatable fields", async () => {
      const req = fakeReq({ url: "/api/v1/channels/c1", method: "PUT", body: { unrelated: 1 } });
      const res = fakeRes();
      await runRoute(router, req, res);
      expect(res._status).toBe(400);
      expect(parseBody(res).error).toMatch(/No fields/);
    });

    it("updates name and returns updated row", async () => {
      query
        .mockResolvedValueOnce([undefined, []])   // update
        .mockResolvedValueOnce([[{ id: "c1", name: "new-name" }], []]);  // select
      const req = fakeReq({ url: "/api/v1/channels/c1", method: "PUT", body: { name: "new-name" } });
      const res = fakeRes();
      await runRoute(router, req, res);
      expect(res._status).toBe(200);
      expect(parseBody(res).name).toBe("new-name");
      const updateSql: string = query.mock.calls[0][0];
      expect(updateSql).toContain("name = ?");
    });

    it("serializes config when it appears in body", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "c1", name: "slack" }], []]);
      const req = fakeReq({ url: "/api/v1/channels/c1", method: "PUT", body: { config: { secret: "z" } } });
      const res = fakeRes();
      await runRoute(router, req, res);
      expect(res._status).toBe(200);
      const updateArgs = query.mock.calls[0][1];
      expect(updateArgs[0]).toBe(JSON.stringify({ secret: "z" }));
    });

    it("returns 404 when channel disappears during select-back", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[], []]);
      const req = fakeReq({ url: "/api/v1/channels/c1", method: "PUT", body: { name: "x" } });
      const res = fakeRes();
      await runRoute(router, req, res);
      expect(res._status).toBe(404);
    });
  });

  // ── DELETE /api/v1/channels/:id ──────────────────────────
  describe("DELETE /api/v1/channels/:id", () => {
    it("returns 404 when channel missing", async () => {
      query.mockResolvedValueOnce([[], []]);
      const req = fakeReq({ url: "/api/v1/channels/c-gone", method: "DELETE" });
      const res = fakeRes();
      await runRoute(router, req, res);
      expect(res._status).toBe(404);
    });

    it("deletes channel with cascading cleanup of related tables", async () => {
      query
        .mockResolvedValueOnce([[{ id: "c1" }], []])  // existence check
        .mockResolvedValueOnce([undefined, []])       // channel_bindings cleanup
        .mockResolvedValueOnce([undefined, []])       // channel_pairing_codes cleanup
        .mockResolvedValueOnce([undefined, []])       // agent_channel_auth cleanup
        .mockResolvedValueOnce([undefined, []]);      // channels delete

      const req = fakeReq({ url: "/api/v1/channels/c1", method: "DELETE" });
      const res = fakeRes();
      await runRoute(router, req, res);

      expect(res._status).toBe(200);
      expect(parseBody(res)).toEqual({ deleted: true });

      // Verify all cleanup queries ran
      const sqls = query.mock.calls.map((c) => c[0] as string);
      expect(sqls).toEqual(expect.arrayContaining([
        expect.stringContaining("DELETE FROM channel_bindings"),
        expect.stringContaining("DELETE FROM channel_pairing_codes"),
        expect.stringContaining("DELETE FROM agent_channel_auth"),
        expect.stringContaining("DELETE FROM channels"),
      ]));
    });
  });
});
