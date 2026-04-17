import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import { createRestRouter } from "../gateway/rest-router.js";
import { signToken } from "./auth.js";
import { registerNotificationRoutes } from "./notification-api.js";

const JWT_SECRET = "test-notif-secret";
const PORTAL_SECRET = "portal-hunter2";
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registerNotificationRoutes", () => {
  let router: ReturnType<typeof createRestRouter>;
  let query: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router = createRestRouter();
    registerNotificationRoutes(router, JWT_SECRET, PORTAL_SECRET);
    query = vi.fn();
    (getDb as any).mockReturnValue({ query });
  });

  describe("GET /api/v1/notifications", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/notifications", method: "GET" }));
      expect(status).toBe(401);
    });

    it("returns list and unread_count", async () => {
      query
        .mockResolvedValueOnce([[
          { id: "n1", user_id: "u1", type: "task_success", title: "Done", message: null, related_agent_id: "a1", related_task_id: "t1", related_run_id: "r1", read_at: null, created_at: "2024-01-01" },
        ], []])
        .mockResolvedValueOnce([[{ n: 1 }], []]);

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/notifications",
        method: "GET",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      }));

      expect(status).toBe(200);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].userId).toBe("u1");
      expect(body.unread_count).toBe(1);
    });

    it("adds read_at IS NULL filter when unread_only=1", async () => {
      query
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[{ n: 0 }], []]);

      await runRoute(router, fakeReq({
        url: "/api/v1/notifications?unread_only=1",
        method: "GET",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      }));

      const sql: string = query.mock.calls[0][0];
      expect(sql).toContain("read_at IS NULL");
    });

    it("caps limit at 100", async () => {
      query
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[{ n: 0 }], []]);
      await runRoute(router, fakeReq({
        url: "/api/v1/notifications?limit=9999",
        method: "GET",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      }));
      expect(query.mock.calls[0][1]).toEqual(["u1", 100]);
    });

    it("enforces minimum limit of 1", async () => {
      query
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[{ n: 0 }], []]);
      await runRoute(router, fakeReq({
        url: "/api/v1/notifications?limit=0",
        method: "GET",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      }));
      expect(query.mock.calls[0][1]).toEqual(["u1", 1]);
    });

    it("defaults to limit 20", async () => {
      query
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[{ n: 0 }], []]);
      await runRoute(router, fakeReq({
        url: "/api/v1/notifications",
        method: "GET",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      }));
      expect(query.mock.calls[0][1]).toEqual(["u1", 20]);
    });

    it("converts row dates to ISO strings via rowToNotification", async () => {
      query
        .mockResolvedValueOnce([[{
          id: "n1", user_id: "u1", type: "task_failure", title: "x",
          message: "msg",
          related_agent_id: null, related_task_id: null, related_run_id: null,
          read_at: new Date("2024-06-15T12:00:00Z"),
          created_at: new Date("2024-06-15T11:00:00Z"),
        }], []])
        .mockResolvedValueOnce([[{ n: 0 }], []]);

      const { body } = await runRoute(router, fakeReq({
        url: "/api/v1/notifications",
        method: "GET",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      }));

      expect(body.data[0].readAt).toBe("2024-06-15T12:00:00.000Z");
      expect(body.data[0].createdAt).toBe("2024-06-15T11:00:00.000Z");
    });
  });

  describe("POST /api/v1/notifications/:id/read", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/notifications/n1/read", method: "POST" }));
      expect(status).toBe(401);
    });

    it("sets read_at for user-owned unread row", async () => {
      query.mockResolvedValueOnce([undefined, []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/notifications/n1/read",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      }));
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(query.mock.calls[0][1]).toEqual(["n1", "u1"]);
    });
  });

  describe("POST /api/v1/notifications/read-all", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/notifications/read-all", method: "POST" }));
      expect(status).toBe(401);
    });

    it("marks all unread for the user as read", async () => {
      query.mockResolvedValueOnce([undefined, []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/notifications/read-all",
        method: "POST",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      }));
      expect(status).toBe(200);
      expect(query.mock.calls[0][1]).toEqual(["u1"]);
    });
  });

  describe("POST /api/internal/task-notify", () => {
    it("returns 401 without portalSecret header", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/internal/task-notify",
        method: "POST",
        body: { userId: "u1", taskId: "t1", status: "success" },
      }));
      expect(status).toBe(401);
    });

    it("returns 401 with wrong portalSecret", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/internal/task-notify",
        method: "POST",
        headers: { "x-auth-token": "wrong" },
        body: { userId: "u1", taskId: "t1", status: "success" },
      }));
      expect(status).toBe(401);
    });

    it("returns 400 when required fields missing", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/internal/task-notify",
        method: "POST",
        headers: { "x-auth-token": PORTAL_SECRET },
        body: { userId: "u1" },
      }));
      expect(status).toBe(400);
    });

    it("inserts task_success notification", async () => {
      query.mockResolvedValueOnce([undefined, []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/internal/task-notify",
        method: "POST",
        headers: { "x-auth-token": PORTAL_SECRET },
        body: { userId: "u1", taskId: "t1", agentId: "a1", runId: "r1", status: "success", title: "Done", message: "ok" },
      }));
      expect(status).toBe(201);
      expect(body.id).toBeDefined();

      const insertArgs = query.mock.calls[0][1];
      // id, user_id, type, title, message, agent_id, task_id, run_id
      expect(insertArgs[1]).toBe("u1");
      expect(insertArgs[2]).toBe("task_success");
      expect(insertArgs[3]).toBe("Done");
    });

    it("picks task_failure type for non-success status", async () => {
      query.mockResolvedValueOnce([undefined, []]);
      await runRoute(router, fakeReq({
        url: "/api/internal/task-notify",
        method: "POST",
        headers: { "x-auth-token": PORTAL_SECRET },
        body: { userId: "u1", taskId: "t1", status: "error" },
      }));
      expect(query.mock.calls[0][1][2]).toBe("task_failure");
    });

    it("uses default titles when title omitted", async () => {
      query.mockResolvedValueOnce([undefined, []]);
      await runRoute(router, fakeReq({
        url: "/api/internal/task-notify",
        method: "POST",
        headers: { "x-auth-token": PORTAL_SECRET },
        body: { userId: "u1", taskId: "t1", status: "success" },
      }));
      expect(query.mock.calls[0][1][3]).toBe("Task completed");
    });

    it("uses failure default title for non-success", async () => {
      query.mockResolvedValueOnce([undefined, []]);
      await runRoute(router, fakeReq({
        url: "/api/internal/task-notify",
        method: "POST",
        headers: { "x-auth-token": PORTAL_SECRET },
        body: { userId: "u1", taskId: "t1", status: "fail" },
      }));
      expect(query.mock.calls[0][1][3]).toBe("Task failed");
    });
  });
});
