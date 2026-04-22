import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import { createRestRouter } from "../gateway/rest-router.js";
import { signToken } from "./auth.js";
import { registerClusterRoutes } from "./cluster-api.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";

const JWT_SECRET = "test-cluster-secret";
const ADMIN_TOKEN = signToken("admin-1", "admin", "admin", JWT_SECRET);
const USER_TOKEN = signToken("user-1", "user", "user", JWT_SECRET);

function fakeReq(opts: { url: string; method: string; headers?: Record<string, string>; body?: unknown }): any {
  const em = new EventEmitter() as any;
  em.url = opts.url;
  em.method = opts.method;
  em.headers = { authorization: `Bearer ${ADMIN_TOKEN}`, ...(opts.headers ?? {}) };
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

function runRoute(router: ReturnType<typeof createRestRouter>, req: any): Promise<{ status: number; body: any; headers: any }> {
  return new Promise((resolve, reject) => {
    const res: any = new EventEmitter();
    res.headersSent = false;
    res.writeHead = (status: number, headers?: any) => {
      res._status = status;
      res._headers = headers;
      res.headersSent = true;
      return res;
    };
    res.end = (body?: string) => {
      resolve({
        status: res._status ?? 0,
        body: body ? JSON.parse(body) : null,
        headers: res._headers,
      });
      return res;
    };
    try {
      if (!router.handle(req, res)) reject(new Error("no route"));
    } catch (err) { reject(err); }
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

// ── Tests ────────────────────────────────────────────────────

describe("registerClusterRoutes", () => {
  let router: ReturnType<typeof createRestRouter>;
  let query: ReturnType<typeof vi.fn>;
  let connMap: RuntimeConnectionMap;

  beforeEach(() => {
    router = createRestRouter();
    connMap = makeConnMap();
    registerClusterRoutes(router, JWT_SECRET, connMap);
    query = vi.fn();
    (getDb as any).mockReturnValue({ query });
  });

  describe("auth", () => {
    it("rejects missing token with 401", async () => {
      const req = fakeReq({ url: "/api/v1/clusters", method: "GET", headers: { authorization: "" } });
      const { status } = await runRoute(router, req);
      expect(status).toBe(401);
    });

    it("rejects non-admin with 403", async () => {
      const req = fakeReq({ url: "/api/v1/clusters", method: "GET", headers: { authorization: `Bearer ${USER_TOKEN}` } });
      const { status } = await runRoute(router, req);
      expect(status).toBe(403);
    });
  });

  describe("GET /api/v1/clusters", () => {
    it("lists clusters", async () => {
      query.mockResolvedValueOnce([[{ id: "c1", name: "prod", api_server: "https://k8s" }], []]);
      const { status, body } = await runRoute(router, fakeReq({ url: "/api/v1/clusters", method: "GET" }));
      expect(status).toBe(200);
      expect(body.data).toHaveLength(1);
    });
  });

  describe("POST /api/v1/clusters", () => {
    it("returns 400 when name missing", async () => {
      const { status, body } = await runRoute(router, fakeReq({ url: "/api/v1/clusters", method: "POST", body: {} }));
      expect(status).toBe(400);
      expect(body.error).toContain("name");
    });

    it("extracts api_server from kubeconfig", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "c-new", name: "dev", api_server: "https://extracted:6443" }], []]);

      const kubeconfig = "apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: https://extracted:6443\n";
      const req = fakeReq({ url: "/api/v1/clusters", method: "POST", body: { name: "dev", kubeconfig } });
      const { status } = await runRoute(router, req);
      expect(status).toBe(201);

      const insertArgs = query.mock.calls[0][1];
      // Position 4 is api_server (id, name, description, kubeconfig, api_server, ...)
      expect(insertArgs[4]).toBe("https://extracted:6443");
    });

    it("uses explicit api_server over kubeconfig extraction", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "c-new" }], []]);

      const req = fakeReq({
        url: "/api/v1/clusters",
        method: "POST",
        body: { name: "dev", kubeconfig: "server: https://fromkubeconfig", api_server: "https://explicit" },
      });
      await runRoute(router, req);

      expect(query.mock.calls[0][1][4]).toBe("https://explicit");
    });
  });

  describe("GET /api/v1/clusters/:id", () => {
    it("returns 404 when missing", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/clusters/c-gone", method: "GET" }));
      expect(status).toBe(404);
    });

    it("returns cluster row when found", async () => {
      query.mockResolvedValueOnce([[{ id: "c1", name: "prod", kubeconfig: "yaml-data" }], []]);
      const { status, body } = await runRoute(router, fakeReq({ url: "/api/v1/clusters/c1", method: "GET" }));
      expect(status).toBe(200);
      expect(body.id).toBe("c1");
    });
  });

  describe("PUT /api/v1/clusters/:id", () => {
    it("returns 400 when no fields to update", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/clusters/c1",
        method: "PUT",
        body: {},
      }));
      expect(status).toBe(400);
    });

    it("auto-extracts api_server when kubeconfig changes but api_server not provided", async () => {
      query
        .mockResolvedValueOnce([undefined, []])  // update
        .mockResolvedValueOnce([[{ id: "c1" }], []]);  // select-back
      // Third query (select agent_clusters for notification) is fire-and-forget;
      // we need to include it so the connMap.notifyMany path has something to consume:
      query.mockResolvedValueOnce([[], []]);

      const kubeconfig = "server: https://new-api:6443\n";
      await runRoute(router, fakeReq({
        url: "/api/v1/clusters/c1",
        method: "PUT",
        body: { kubeconfig },
      }));

      const updateSql: string = query.mock.calls[0][0];
      expect(updateSql).toContain("kubeconfig = ?");
      expect(updateSql).toContain("api_server = ?");
    });

    it("notifies bound agents when cluster changes", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "c1" }], []])
        .mockResolvedValueOnce([[{ agent_id: "a1" }, { agent_id: "a2" }], []]);  // agent_clusters

      await runRoute(router, fakeReq({
        url: "/api/v1/clusters/c1",
        method: "PUT",
        body: { description: "updated" },
      }));

      // Notification is fire-and-forget; wait a tick
      await new Promise(r => setImmediate(r));
      expect(connMap.notifyMany).toHaveBeenCalledWith(["a1", "a2"], "agent.reload", { resources: ["cluster"] });
    });
  });

  describe("DELETE /api/v1/clusters/:id", () => {
    it("returns 404 when missing", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/clusters/c-gone", method: "DELETE" }));
      expect(status).toBe(404);
    });

    it("deletes when present", async () => {
      query
        .mockResolvedValueOnce([[{ id: "c1" }], []])   // existence
        .mockResolvedValueOnce([undefined, []]);        // delete

      const { status, body } = await runRoute(router, fakeReq({ url: "/api/v1/clusters/c1", method: "DELETE" }));
      expect(status).toBe(200);
      expect(body).toEqual({ deleted: true });
    });
  });

  describe("POST /api/v1/clusters/:id/test", () => {
    it("returns 404 when cluster missing", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/clusters/missing/test", method: "POST", body: {} }));
      expect(status).toBe(404);
    });

    it("returns stub ok when cluster exists", async () => {
      query.mockResolvedValueOnce([[{ id: "c1" }], []]);
      const { status, body } = await runRoute(router, fakeReq({ url: "/api/v1/clusters/c1/test", method: "POST", body: {} }));
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });
});
