import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import jwt from "jsonwebtoken";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import { createRestRouter } from "../gateway/rest-router.js";
import {
  hashPassword,
  verifyPassword,
  signToken,
  requireAdmin,
  registerAuthRoutes,
} from "./auth.js";

const JWT_SECRET = "test-auth-secret";

function fakeReq(opts: { url?: string; method?: string; headers?: Record<string, string>; body?: unknown } = {}): any {
  const em = new EventEmitter() as any;
  em.url = opts.url ?? "/";
  em.method = opts.method ?? "GET";
  em.headers = opts.headers ?? {};
  // Emit only once 'data' listener is registered, so the handler can actually
  // receive the body even when parseBody is called after an awaited DB query.
  const originalOn = em.on.bind(em);
  em.on = (ev: string, listener: (...a: unknown[]) => void) => {
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

function fakeRes(): any {
  const r: any = new EventEmitter();
  r._status = 0;
  r._body = null;
  r.headersSent = false;
  r.writeHead = vi.fn((s: number, h?: any) => { r._status = s; r._headers = h; r.headersSent = true; return r; });
  r.end = vi.fn((body?: string) => { r._body = body; r.emit("finish"); return r; });
  return r;
}

function runRoute(router: ReturnType<typeof createRestRouter>, req: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = new EventEmitter();
    res.writeHead = (status: number) => { res._status = status; res.headersSent = true; return res; };
    res.end = (body?: string) => {
      resolve({ status: res._status ?? 0, body: body ? JSON.parse(body) : null });
      return res;
    };
    try {
      if (!router.handle(req, res)) reject(new Error("no route"));
    } catch (err) { reject(err); }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Password hashing ─────────────────────────────────────────

describe("hashPassword / verifyPassword", () => {
  it("produces hashes with salt:key format", () => {
    const hash = hashPassword("hunter2");
    expect(hash.split(":")).toHaveLength(2);
  });

  it("verifies a correct password", () => {
    const hash = hashPassword("correct");
    expect(verifyPassword("correct", hash)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    const hash = hashPassword("correct");
    expect(verifyPassword("wrong", hash)).toBe(false);
  });

  it("rejects malformed hash (missing separator)", () => {
    expect(verifyPassword("whatever", "no-separator")).toBe(false);
  });

  it("rejects malformed hash (empty key)", () => {
    expect(verifyPassword("whatever", "somesalt:")).toBe(false);
  });

  it("produces different hashes for same password (unique salt)", () => {
    const a = hashPassword("same-pw");
    const b = hashPassword("same-pw");
    expect(a).not.toBe(b);
  });
});

// ── JWT signing ─────────────────────────────────────────────

describe("signToken", () => {
  it("returns a valid JWT containing claims", () => {
    const token = signToken("u1", "alice", "admin", JWT_SECRET);
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    expect(decoded.sub).toBe("u1");
    expect(decoded.username).toBe("alice");
    expect(decoded.role).toBe("admin");
    expect(decoded.org_id).toBe("default");
  });

  it("sets 24h expiration", () => {
    const token = signToken("u1", "alice", "admin", JWT_SECRET);
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const expIn = decoded.exp - decoded.iat;
    expect(expIn).toBe(24 * 3600);
  });
});

// ── requireAdmin helper ─────────────────────────────────────

describe("requireAdmin", () => {
  it("returns auth for valid admin token", () => {
    const token = signToken("u1", "alice", "admin", JWT_SECRET);
    const req = fakeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = fakeRes();
    const auth = requireAdmin(req, res, JWT_SECRET);
    expect(auth).not.toBeNull();
    expect(auth?.userId).toBe("u1");
  });

  it("sends 401 and returns null when unauthenticated", () => {
    const req = fakeReq({ headers: {} });
    const res = fakeRes();
    const auth = requireAdmin(req, res, JWT_SECRET);
    expect(auth).toBeNull();
    expect(res._status).toBe(401);
  });

  it("sends 403 and returns null for non-admin role", () => {
    const token = signToken("u2", "bob", "user", JWT_SECRET);
    const req = fakeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = fakeRes();
    const auth = requireAdmin(req, res, JWT_SECRET);
    expect(auth).toBeNull();
    expect(res._status).toBe(403);
  });
});

// ── Route integration ───────────────────────────────────────

describe("registerAuthRoutes", () => {
  let router: ReturnType<typeof createRestRouter>;
  let query: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router = createRestRouter();
    registerAuthRoutes(router, JWT_SECRET);
    query = vi.fn();
    (getDb as any).mockReturnValue({ query });
  });

  describe("POST /api/v1/auth/register", () => {
    it("bootstraps first user without auth (user count 0)", async () => {
      query
        .mockResolvedValueOnce([[{ cnt: 0 }], []])      // count check
        .mockResolvedValueOnce([[], []])                 // existing check
        .mockResolvedValueOnce([undefined, []]);         // insert

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/auth/register",
        method: "POST",
        body: { username: "alice", password: "pw" },
      }));

      expect(status).toBe(201);
      expect(body.token).toBeDefined();
      expect(body.user.username).toBe("alice");
      expect(body.user.role).toBe("admin"); // default role
    });

    it("requires admin auth when users already exist", async () => {
      query.mockResolvedValueOnce([[{ cnt: 5 }], []]);

      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/auth/register",
        method: "POST",
        body: { username: "new", password: "pw" },
      }));
      expect(status).toBe(401);
    });

    it("returns 400 when fields missing on bootstrap", async () => {
      query.mockResolvedValueOnce([[{ cnt: 0 }], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/auth/register",
        method: "POST",
        body: { username: "only" },
      }));
      expect(status).toBe(400);
    });

    it("returns 409 when username already exists", async () => {
      query
        .mockResolvedValueOnce([[{ cnt: 0 }], []])     // count
        .mockResolvedValueOnce([[{ id: "x" }], []]);    // existing

      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/auth/register",
        method: "POST",
        body: { username: "alice", password: "pw" },
      }));
      expect(status).toBe(409);
    });
  });

  describe("POST /api/v1/auth/login", () => {
    it("returns 400 when fields missing", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/auth/login",
        method: "POST",
        body: {},
      }));
      expect(status).toBe(400);
    });

    it("returns 401 when user not found", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/auth/login",
        method: "POST",
        body: { username: "nobody", password: "pw" },
      }));
      expect(status).toBe(401);
    });

    it("returns 401 on wrong password", async () => {
      const hash = hashPassword("realpw");
      query.mockResolvedValueOnce([[{ id: "u1", username: "alice", password_hash: hash, role: "admin", can_review_skills: 0 }], []]);

      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/auth/login",
        method: "POST",
        body: { username: "alice", password: "wrong" },
      }));
      expect(status).toBe(401);
    });

    it("returns token and user on success", async () => {
      const hash = hashPassword("realpw");
      query.mockResolvedValueOnce([[{ id: "u1", username: "alice", password_hash: hash, role: "admin", can_review_skills: 1 }], []]);

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/auth/login",
        method: "POST",
        body: { username: "alice", password: "realpw" },
      }));

      expect(status).toBe(200);
      expect(body.token).toBeDefined();
      expect(body.user).toEqual({ id: "u1", username: "alice", role: "admin", can_review_skills: true });
    });
  });

  describe("GET /api/v1/auth/me", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/auth/me", method: "GET" }));
      expect(status).toBe(401);
    });

    it("returns 404 when user row missing", async () => {
      const token = signToken("u1", "alice", "admin", JWT_SECRET);
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/auth/me",
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      }));
      expect(status).toBe(404);
    });

    it("returns user data", async () => {
      const token = signToken("u1", "alice", "admin", JWT_SECRET);
      query.mockResolvedValueOnce([[{ id: "u1", username: "alice", role: "admin", can_review_skills: 0, created_at: "2024-01-01" }], []]);

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/auth/me",
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      }));
      expect(status).toBe(200);
      expect(body.username).toBe("alice");
    });
  });

  describe("GET /api/v1/users (admin only)", () => {
    it("returns 403 for non-admin", async () => {
      const userToken = signToken("u1", "bob", "user", JWT_SECRET);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/users",
        method: "GET",
        headers: { authorization: `Bearer ${userToken}` },
      }));
      expect(status).toBe(403);
    });

    it("returns list for admin", async () => {
      const adminToken = signToken("a1", "admin", "admin", JWT_SECRET);
      query.mockResolvedValueOnce([[{ id: "u1", username: "alice" }], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/users",
        method: "GET",
        headers: { authorization: `Bearer ${adminToken}` },
      }));
      expect(status).toBe(200);
      expect(body.data).toHaveLength(1);
    });
  });

  describe("POST /api/v1/users (admin only)", () => {
    const adminToken = signToken("a1", "admin", "admin", JWT_SECRET);

    it("returns 400 when fields missing", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/users",
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
        body: {},
      }));
      expect(status).toBe(400);
    });

    it("returns 409 on duplicate username", async () => {
      query.mockResolvedValueOnce([[{ id: "x" }], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/users",
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
        body: { username: "taken", password: "pw" },
      }));
      expect(status).toBe(409);
    });

    it("creates a new user", async () => {
      query
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([undefined, []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/users",
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
        body: { username: "new", password: "pw", can_review_skills: true },
      }));
      expect(status).toBe(201);
      expect(body.username).toBe("new");
      expect(body.role).toBe("user"); // forced role
      expect(body.can_review_skills).toBe(true);
    });
  });

  describe("PUT /api/v1/users/:userId", () => {
    const adminToken = signToken("a1", "admin", "admin", JWT_SECRET);

    it("returns 400 when nothing to update", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/users/u1",
        method: "PUT",
        headers: { authorization: `Bearer ${adminToken}` },
        body: {},
      }));
      expect(status).toBe(400);
    });

    it("returns 404 when user missing", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/users/u-gone",
        method: "PUT",
        headers: { authorization: `Bearer ${adminToken}` },
        body: { can_review_skills: true },
      }));
      expect(status).toBe(404);
    });

    it("updates can_review_skills", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "u1", username: "alice", role: "user", can_review_skills: 1 }], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/users/u1",
        method: "PUT",
        headers: { authorization: `Bearer ${adminToken}` },
        body: { can_review_skills: true },
      }));
      expect(status).toBe(200);
      expect(body.can_review_skills).toBe(1);
    });
  });

  describe("PUT /api/v1/users/:userId/password", () => {
    const adminToken = signToken("a1", "admin", "admin", JWT_SECRET);
    const userToken = signToken("u1", "bob", "user", JWT_SECRET);

    it("returns 401 when unauthenticated", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/users/u1/password",
        method: "PUT",
        body: { password: "new" },
      }));
      expect(status).toBe(401);
    });

    it("returns 403 when non-admin tries to reset another user's password", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/users/u2/password",
        method: "PUT",
        headers: { authorization: `Bearer ${userToken}` },
        body: { password: "new" },
      }));
      expect(status).toBe(403);
    });

    it("returns 400 when new password missing", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/users/u1/password",
        method: "PUT",
        headers: { authorization: `Bearer ${adminToken}` },
        body: {},
      }));
      expect(status).toBe(400);
    });

    it("self change requires current password", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/users/u1/password",
        method: "PUT",
        headers: { authorization: `Bearer ${userToken}` },
        body: { password: "new" },
      }));
      expect(status).toBe(400);
    });

    it("self change rejects incorrect current password", async () => {
      const hash = hashPassword("realpw");
      query.mockResolvedValueOnce([[{ password_hash: hash }], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/users/u1/password",
        method: "PUT",
        headers: { authorization: `Bearer ${userToken}` },
        body: { password: "newpw", current_password: "wrong" },
      }));
      expect(status).toBe(403);
    });

    it("self change succeeds with correct current password", async () => {
      const hash = hashPassword("realpw");
      query
        .mockResolvedValueOnce([[{ password_hash: hash }], []])  // select
        .mockResolvedValueOnce([undefined, []]);                   // update
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/users/u1/password",
        method: "PUT",
        headers: { authorization: `Bearer ${userToken}` },
        body: { password: "newpw", current_password: "realpw" },
      }));
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true });
    });

    it("admin can reset other user's password without current_password", async () => {
      query.mockResolvedValueOnce([undefined, []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/users/u2/password",
        method: "PUT",
        headers: { authorization: `Bearer ${adminToken}` },
        body: { password: "reset" },
      }));
      expect(status).toBe(200);
    });
  });

  describe("DELETE /api/v1/users/:userId", () => {
    const adminToken = signToken("a1", "admin", "admin", JWT_SECRET);

    it("prevents self-delete", async () => {
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/users/a1",
        method: "DELETE",
        headers: { authorization: `Bearer ${adminToken}` },
      }));
      expect(status).toBe(400);
      expect(body.error).toMatch(/yourself/);
    });

    it("deletes another user", async () => {
      query.mockResolvedValueOnce([undefined, []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/users/u2",
        method: "DELETE",
        headers: { authorization: `Bearer ${adminToken}` },
      }));
      expect(status).toBe(204);
    });
  });
});
