/**
 * Tests for the agent personal-bot routes (GET/PUT/DELETE
 * /api/v1/siclaw/agents/:id/personal-bot): admin-only writes, secret never
 * echoed, storage as a channels row carrying config.personal_bot, and the
 * best-effort channel.reload push to connected runtimes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import { createRestRouter } from "../gateway/rest-router.js";
import { signToken } from "./auth.js";
import { registerSiclawRoutes } from "./siclaw-api.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";

const JWT_SECRET = "test-personal-bot";
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

function makeConnMap(runtimeIds: string[] = []): RuntimeConnectionMap {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    isConnected: vi.fn().mockReturnValue(false),
    sendCommand: vi.fn().mockResolvedValue({ ok: true }),
    notify: vi.fn(),
    notifyMany: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    connectedAgentIds: vi.fn().mockReturnValue(runtimeIds),
  };
}

const BOT_CHANNEL_ROW = {
  id: "ch-bot-1",
  name: "cks Bot",
  status: "active",
  config: JSON.stringify({
    domain: "feishu",
    app_id: "cli_xxx",
    app_secret: "s3cret",
    personal_bot: { agent_id: "agent-1", access_mode: "open", owner_user_id: "u-owner", group_auto_bind: true },
  }),
};

describe("agent personal-bot routes", () => {
  let router: ReturnType<typeof createRestRouter>;
  let query: ReturnType<typeof vi.fn>;
  let connMap: RuntimeConnectionMap;

  function setup(runtimeIds: string[] = []) {
    router = createRestRouter();
    connMap = makeConnMap(runtimeIds);
    registerSiclawRoutes(router, {
      jwtSecret: JWT_SECRET,
      serverUrl: "http://runtime:3000",
      portalSecret: "internal",
      connectionMap: connMap,
    } as any);
    query = vi.fn();
    (getDb as any).mockReturnValue({ query, getConnection: vi.fn() });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  describe("GET /agents/:id/personal-bot", () => {
    it("returns null when the agent has no bot", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/agent-1/personal-bot", method: "GET",
      }));
      expect(status).toBe(200);
      expect(body).toEqual({ data: null });
    });

    it("returns bot info without the secret", async () => {
      query.mockResolvedValueOnce([[BOT_CHANNEL_ROW], []]);
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/agent-1/personal-bot", method: "GET",
      }));
      expect(status).toBe(200);
      expect(body.data).toEqual({
        id: "ch-bot-1",
        agent_id: "agent-1",
        domain: "feishu",
        app_id: "cli_xxx",
        access_mode: "open",
        group_auto_bind: true,
        status: "active",
      });
      expect(JSON.stringify(body)).not.toContain("s3cret");
    });

    it("does not match another agent's bot", async () => {
      query.mockResolvedValueOnce([[BOT_CHANNEL_ROW], []]);
      const { body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/agent-OTHER/personal-bot", method: "GET",
      }));
      expect(body).toEqual({ data: null });
    });
  });

  describe("PUT /agents/:id/personal-bot", () => {
    it("rejects non-admin users", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/agent-1/personal-bot", method: "PUT",
        body: { app_id: "cli_xxx", app_secret: "s" },
      }));
      expect(status).toBe(403);
      expect(query).not.toHaveBeenCalled();
    });

    it("requires app_secret when creating", async () => {
      query
        .mockResolvedValueOnce([[{ id: "agent-1", name: "cks", created_by: "u-owner" }], []]) // agent lookup
        .mockResolvedValueOnce([[], []]); // no existing bot
      const { status, body } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/agent-1/personal-bot", method: "PUT",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: { app_id: "cli_xxx" },
      }));
      expect(status).toBe(400);
      expect(body.error).toContain("app_secret");
    });

    it("creates the channels row with personal_bot config and pushes channel.reload", async () => {
      setup(["shanghai"]);
      query
        .mockResolvedValueOnce([[{ id: "agent-1", name: "cks", created_by: "u-owner" }], []])
        .mockResolvedValueOnce([[], []]) // no existing bot
        .mockResolvedValueOnce([[], []]); // insert
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/agent-1/personal-bot", method: "PUT",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: { app_id: "cli_new", app_secret: "sec", domain: "feishu", group_auto_bind: false },
      }));
      expect(status).toBe(200);
      const insert = query.mock.calls[2];
      expect(insert[0]).toContain("INSERT INTO channels");
      const cfg = JSON.parse(insert[1][2]);
      expect(cfg.app_id).toBe("cli_new");
      expect(cfg.app_secret).toBe("sec");
      expect(cfg.personal_bot).toEqual({
        agent_id: "agent-1",
        access_mode: "open",
        owner_user_id: "u-owner",
        group_auto_bind: false,
      });
      expect(connMap.sendCommand).toHaveBeenCalledWith("shanghai", "channel.reload", {});
    });

    it("keeps the stored secret when the update leaves it blank", async () => {
      query
        .mockResolvedValueOnce([[{ id: "agent-1", name: "cks", created_by: "u-owner" }], []])
        .mockResolvedValueOnce([[BOT_CHANNEL_ROW], []]) // existing bot
        .mockResolvedValueOnce([[], []]); // update
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/agent-1/personal-bot", method: "PUT",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: { app_id: "cli_xxx", app_secret: "" },
      }));
      expect(status).toBe(200);
      const update = query.mock.calls[2];
      expect(update[0]).toContain("UPDATE channels SET config");
      const cfg = JSON.parse(update[1][0]);
      expect(cfg.app_secret).toBe("s3cret");
    });
  });

  describe("DELETE /agents/:id/personal-bot", () => {
    it("rejects non-admin users", async () => {
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/agent-1/personal-bot", method: "DELETE",
      }));
      expect(status).toBe(403);
    });

    it("disables the bot (keeps the row) and pushes channel.reload", async () => {
      setup(["shanghai"]);
      query
        .mockResolvedValueOnce([[BOT_CHANNEL_ROW], []]) // find
        .mockResolvedValueOnce([[], []]); // update
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/agent-1/personal-bot", method: "DELETE",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(200);
      const update = query.mock.calls[1];
      expect(update[0]).toContain("SET status = 'inactive'");
      expect(update[1]).toEqual(["ch-bot-1"]);
      expect(connMap.sendCommand).toHaveBeenCalledWith("shanghai", "channel.reload", {});
    });

    it("404s when there is no bot", async () => {
      query.mockResolvedValueOnce([[], []]);
      const { status } = await runRoute(router, fakeReq({
        url: "/api/v1/siclaw/agents/agent-1/personal-bot", method: "DELETE",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }));
      expect(status).toBe(404);
    });
  });
});
