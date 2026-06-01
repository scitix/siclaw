import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

// ssh-dial is broker-free but talks to real sockets; stub it so the /test route
// is exercised without a live host.
const { dialSshChainMock, runCommandMock } = vi.hoisted(() => ({
  dialSshChainMock: vi.fn(),
  runCommandMock: vi.fn(),
}));
vi.mock("../tools/infra/ssh-dial.js", () => ({
  dialSshChain: dialSshChainMock,
  runCommand: runCommandMock,
}));

import { getDb } from "../gateway/db.js";
import { createRestRouter } from "../gateway/rest-router.js";
import { signToken } from "./auth.js";
import { registerHostRoutes, validateJumpChain } from "./host-api.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";

const JWT_SECRET = "test-host-secret";
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

function runRoute(router: ReturnType<typeof createRestRouter>, req: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = new EventEmitter();
    res.headersSent = false;
    res.writeHead = (status: number, headers?: any) => {
      res._status = status;
      res.headersSent = true;
      return res;
    };
    res.end = (body?: string) => {
      resolve({ status: res._status ?? 0, body: body ? JSON.parse(body) : null });
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

describe("registerHostRoutes", () => {
  let router: ReturnType<typeof createRestRouter>;
  let query: ReturnType<typeof vi.fn>;
  let connMap: RuntimeConnectionMap;

  beforeEach(() => {
    router = createRestRouter();
    connMap = makeConnMap();
    registerHostRoutes(router, JWT_SECRET, connMap);
    query = vi.fn();
    (getDb as any).mockReturnValue({ query });
  });

  describe("auth", () => {
    it("rejects missing token", async () => {
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/hosts", method: "GET", headers: { authorization: "" } }));
      expect(status).toBe(401);
    });

    it("rejects non-admin user", async () => {
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/hosts", method: "GET", headers: { authorization: `Bearer ${USER_TOKEN}` } }));
      expect(status).toBe(403);
    });
  });

  describe("GET /api/v1/hosts", () => {
    it("returns list and never selects password/private_key columns", async () => {
      query.mockResolvedValueOnce([[{ id: "h1", name: "web-1", ip: "10.0.0.1" }], []]);
      const { status, body } = await runRoute(router, fakeReq({ url: "/api/v1/hosts", method: "GET" }));
      expect(status).toBe(200);
      expect(body.data).toHaveLength(1);

      const sql: string = query.mock.calls[0][0];
      expect(sql).not.toContain("password");
      expect(sql).not.toContain("private_key");
    });
  });

  describe("POST /api/v1/hosts", () => {
    it("returns 400 without name or ip", async () => {
      const { status, body } = await runRoute(router, fakeReq({ url: "/api/v1/hosts", method: "POST", body: { name: "only" } }));
      expect(status).toBe(400);
      expect(body.error).toContain("name and ip");
    });

    it("applies defaults: port=22, username=root, auth_type=password, is_production=1", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "h-new", name: "web-1" }], []]);

      await runRoute(router, fakeReq({
        url: "/api/v1/hosts",
        method: "POST",
        body: { name: "web-1", ip: "10.0.0.1" },
      }));

      const insertArgs = query.mock.calls[0][1];
      // id, name, ip, port, username, auth_type, password, private_key, passphrase, description, is_production, jump_host_id
      expect(insertArgs[3]).toBe(22);
      expect(insertArgs[4]).toBe("root");
      expect(insertArgs[5]).toBe("password");
      expect(insertArgs[10]).toBe(1);
      expect(insertArgs[11]).toBeNull(); // jump_host_id defaults to null
    });

    it("rejects auth_type=managed without a jump_host_id (400)", async () => {
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/hosts",
        method: "POST",
        body: { name: "m", ip: "10.0.0.9", auth_type: "managed" },
      }));
      expect(status).toBe(400);
      expect(body.error).toMatch(/managed.*requires a jump_host_id/i);
    });

    it("creates a managed host with a jump host (no secrets stored)", async () => {
      query
        .mockResolvedValueOnce([[{ jump_host_id: null }], []]) // validateJumpChain: bastion exists, no further jump
        .mockResolvedValueOnce([undefined, []])                // INSERT
        .mockResolvedValueOnce([[{ id: "h-m", name: "m" }], []]); // SELECT back
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/hosts",
        method: "POST",
        body: { name: "m", ip: "10.0.0.9", auth_type: "managed", jump_host_id: "bastion-id" },
      }));
      expect(status).toBe(201);
      const insertArgs = query.mock.calls[1][1]; // calls[0] = validateJumpChain SELECT
      expect(insertArgs[5]).toBe("managed");      // auth_type
      expect(insertArgs[6]).toBeNull();           // password
      expect(insertArgs[7]).toBeNull();           // private_key
      expect(insertArgs[11]).toBe("bastion-id");  // jump_host_id
    });

    it("never returns password or private_key in response", async () => {
      query
        .mockResolvedValueOnce([undefined, []])
        .mockResolvedValueOnce([[{ id: "h-new", name: "secure", ip: "10.0.0.2", username: "root" }], []]);

      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/hosts",
        method: "POST",
        body: { name: "secure", ip: "10.0.0.2", password: "s3cr3t", private_key: "-----BEGIN-----" },
      }));

      expect(status).toBe(201);
      expect(body).not.toHaveProperty("password");
      expect(body).not.toHaveProperty("private_key");
      // And the second query (SELECT back) uses safe columns only
      const selectSql: string = query.mock.calls[1][0];
      expect(selectSql).not.toContain("password");
    });
  });

  describe("GET /api/v1/hosts/:id", () => {
    it("returns 404 when host missing", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/hosts/h-gone", method: "GET" }));
      expect(status).toBe(404);
    });

    it("returns host without secrets", async () => {
      query.mockResolvedValueOnce([[{ id: "h1", name: "web-1" }], []]);
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/hosts/h1", method: "GET" }));
      expect(status).toBe(200);
      expect(query.mock.calls[0][0]).not.toContain("password");
    });
  });

  describe("PUT /api/v1/hosts/:id", () => {
    it("returns 400 when no updatable fields", async () => {
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/hosts/h1", method: "PUT", body: { unrelated: 1 } }));
      expect(status).toBe(400);
    });

    it("returns 404 when update affects no rows", async () => {
      query
        .mockResolvedValueOnce([{ affectedRows: 0 }, []]);  // update
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/hosts/h-gone", method: "PUT", body: { name: "x" } }));
      expect(status).toBe(404);
    });

    it("notifies bound agents after successful update", async () => {
      query
        .mockResolvedValueOnce([{ affectedRows: 1 }, []])          // update
        .mockResolvedValueOnce([[{ id: "h1", name: "renamed" }], []]) // select safe
        .mockResolvedValueOnce([[{ agent_id: "a1" }], []]);         // agent_hosts

      await runRoute(router, fakeReq({ url: "/api/v1/hosts/h1", method: "PUT", body: { name: "renamed" } }));
      await new Promise(r => setImmediate(r));

      expect(connMap.notifyMany).toHaveBeenCalledWith(["a1"], "agent.reload", { resources: ["host"] });
    });
  });

  describe("DELETE /api/v1/hosts/:id", () => {
    it("returns 404 when host missing", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/hosts/h-gone", method: "DELETE" }));
      expect(status).toBe(404);
    });

    it("deletes when present", async () => {
      query
        .mockResolvedValueOnce([[{ id: "h1" }], []])
        .mockResolvedValueOnce([undefined, []]);
      const { status, body } = await runRoute(router, fakeReq({ url: "/api/v1/hosts/h1", method: "DELETE" }));
      expect(status).toBe(200);
      expect(body).toEqual({ deleted: true });
    });
  });

  describe("POST /api/v1/hosts/:id/test", () => {
    it("returns 404 when host missing", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({ url: "/api/v1/hosts/missing/test", method: "POST", body: {} }));
      expect(status).toBe(404);
    });

    it("dials the chain and returns ok when echo succeeds", async () => {
      query
        .mockResolvedValueOnce([[{ id: "h1" }], []]) // existence check
        .mockResolvedValueOnce([[{ id: "h1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "password", password: "pw", private_key: null, passphrase: null, jump_host_id: null }], []]); // chain resolve
      const teardown = vi.fn();
      dialSshChainMock.mockResolvedValueOnce({ client: {}, teardown });
      runCommandMock.mockResolvedValueOnce({ stdout: "ok\n", stderr: "", exitCode: 0 });

      const { status, body } = await runRoute(router, fakeReq({ url: "/api/v1/hosts/h1/test", method: "POST", body: {} }));
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(teardown).toHaveBeenCalled();
    });

    it("returns ok:false when the dial fails (no throw)", async () => {
      query
        .mockResolvedValueOnce([[{ id: "h1" }], []])
        .mockResolvedValueOnce([[{ id: "h1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "password", password: "pw", private_key: null, passphrase: null, jump_host_id: null }], []]);
      dialSshChainMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const { status, body } = await runRoute(router, fakeReq({ url: "/api/v1/hosts/h1/test", method: "POST", body: {} }));
      expect(status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.message).toContain("ECONNREFUSED");
    });
  });

  describe("validateJumpChain", () => {
    // Minimal fake db: each host id maps to its jump_host_id (or absent = not found).
    const chainDb = (map: Record<string, string | null>): any => ({
      query: vi.fn(async (_sql: string, args: any[]) => {
        const id = args[0];
        return id in map ? [[{ jump_host_id: map[id] }], []] : [[], []];
      }),
    });

    it("is a no-op when jumpHostId is empty", async () => {
      await expect(validateJumpChain(chainDb({}), "a", null)).resolves.toBeUndefined();
    });

    it("rejects a self-reference", async () => {
      await expect(validateJumpChain(chainDb({ a: null }), "a", "a")).rejects.toThrow(/its own jump host/);
    });

    it("rejects a dangling reference", async () => {
      await expect(validateJumpChain(chainDb({}), "a", "ghost")).rejects.toThrow(/not found/);
    });

    it("rejects a cycle", async () => {
      // a → b → a
      await expect(validateJumpChain(chainDb({ b: "a", a: "b" }), "a", "b")).rejects.toThrow(/cycle/);
    });

    it("rejects a chain deeper than 3", async () => {
      await expect(
        validateJumpChain(chainDb({ b: "c", c: "d", d: "e", e: null }), "a", "b"),
      ).rejects.toThrow(/exceeds max depth/);
    });

    it("accepts a valid short chain", async () => {
      await expect(validateJumpChain(chainDb({ b: "c", c: null }), "a", "b")).resolves.toBeUndefined();
    });
  });
});
