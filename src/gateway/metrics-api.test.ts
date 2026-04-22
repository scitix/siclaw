import { describe, it, expect, beforeEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import http from "node:http";
import { createRestRouter } from "./rest-router.js";
import { registerMetricsRoutes } from "./metrics-api.js";
import type { RuntimeConfig } from "./config.js";
import type { MetricsAggregator } from "./metrics-aggregator.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";

const SECRET = "metrics-api-secret";
const config: RuntimeConfig = {
  port: 0, internalPort: 0, host: "0.0.0.0",
  runtimeSecret: "", serverUrl: "", portalSecret: "",
  jwtSecret: SECRET,
};

class FakeRes {
  statusCode = 0;
  headers: Record<string, string | number> = {};
  body = "";
  writeHead(status: number, headers: Record<string, string | number>): this {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
  end(data?: string): void { if (data) this.body = data; }
}

function makeReq(method: string, url: string, headers: Record<string, string> = {}): http.IncomingMessage {
  return { method, url, headers } as unknown as http.IncomingMessage;
}

function adminToken(): string {
  return jwt.sign({ sub: "admin-1", role: "admin" }, SECRET);
}
function userToken(): string {
  return jwt.sign({ sub: "user-1", role: "user" }, SECRET);
}

function mkAggregator(): MetricsAggregator {
  return {
    snapshot: () => ({ activeSessions: 1, wsConnections: 2 }),
    topTools: (_n: number, _u?: string) => [{ toolName: "t", userId: "u", agentId: null, success: 1, error: 0, total: 1 }],
    topSkills: (_n: number, _u?: string) => [],
    destroy: () => {},
  } as unknown as MetricsAggregator;
}

class FakeFrontendClient {
  calls: Array<{ method: string; params: any }> = [];
  responses = new Map<string, unknown>();
  nextError: Error | null = null;
  request(method: string, params?: any): Promise<any> {
    this.calls.push({ method, params });
    if (this.nextError) {
      const err = this.nextError; this.nextError = null;
      return Promise.reject(err);
    }
    return Promise.resolve(this.responses.get(method) ?? {});
  }
}

let router: ReturnType<typeof createRestRouter>;
let aggregator: MetricsAggregator;
let frontend: FakeFrontendClient;

beforeEach(() => {
  router = createRestRouter();
  aggregator = mkAggregator();
  frontend = new FakeFrontendClient();
  registerMetricsRoutes(router, config, aggregator, frontend as unknown as FrontendWsClient);
});

async function dispatch(req: http.IncomingMessage, res: FakeRes): Promise<void> {
  router.handle(req, res as unknown as http.ServerResponse);
  // Allow the deferred Promise.resolve handler to run and awaits to settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("GET /api/v1/siclaw/metrics/live", () => {
  it("returns 403 for non-admin", async () => {
    const res = new FakeRes();
    await dispatch(makeReq("GET", "/api/v1/siclaw/metrics/live", { authorization: `Bearer ${userToken()}` }), res);
    expect(res.statusCode).toBe(403);
  });

  it("returns snapshot + topTools + topSkills for admin", async () => {
    const res = new FakeRes();
    await dispatch(makeReq("GET", "/api/v1/siclaw/metrics/live", { authorization: `Bearer ${adminToken()}` }), res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.snapshot).toEqual({ activeSessions: 1, wsConnections: 2 });
    expect(body.topTools).toHaveLength(1);
  });
});

describe("GET /api/v1/siclaw/metrics/summary", () => {
  it("proxies query to metrics.summary RPC and returns its payload", async () => {
    frontend.responses.set("metrics.summary", { hello: "world" });
    const res = new FakeRes();
    await dispatch(makeReq("GET", "/api/v1/siclaw/metrics/summary?period=day", {
      authorization: `Bearer ${adminToken()}`,
    }), res);
    expect(res.statusCode).toBe(200);
    expect(frontend.calls[0].method).toBe("metrics.summary");
    expect(frontend.calls[0].params).toEqual({ period: "day" });
    expect(JSON.parse(res.body)).toEqual({ hello: "world" });
  });

  it("returns 500 when RPC fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    frontend.nextError = new Error("oops");
    const res = new FakeRes();
    await dispatch(makeReq("GET", "/api/v1/siclaw/metrics/summary", { authorization: `Bearer ${adminToken()}` }), res);
    expect(res.statusCode).toBe(500);
    errSpy.mockRestore();
  });

  it("returns 403 for non-admin", async () => {
    const res = new FakeRes();
    await dispatch(makeReq("GET", "/api/v1/siclaw/metrics/summary", { authorization: `Bearer ${userToken()}` }), res);
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/v1/siclaw/metrics/audit (+ detail)", () => {
  it("proxies to metrics.audit with parsed query", async () => {
    frontend.responses.set("metrics.audit", { entries: [] });
    const res = new FakeRes();
    await dispatch(makeReq("GET", "/api/v1/siclaw/metrics/audit?userId=u1&limit=10", {
      authorization: `Bearer ${adminToken()}`,
    }), res);
    expect(frontend.calls[0].method).toBe("metrics.audit");
    expect(frontend.calls[0].params).toEqual({ userId: "u1", limit: "10" });
    expect(res.statusCode).toBe(200);
  });

  it("proxies /audit/:id to metrics.auditDetail with id param", async () => {
    frontend.responses.set("metrics.auditDetail", { found: true });
    const res = new FakeRes();
    await dispatch(makeReq("GET", "/api/v1/siclaw/metrics/audit/abc123", {
      authorization: `Bearer ${adminToken()}`,
    }), res);
    expect(frontend.calls[0].method).toBe("metrics.auditDetail");
    expect(frontend.calls[0].params).toEqual({ id: "abc123" });
    expect(res.statusCode).toBe(200);
  });

  it("returns 403 for non-admin on audit detail", async () => {
    const res = new FakeRes();
    await dispatch(makeReq("GET", "/api/v1/siclaw/metrics/audit/x", { authorization: `Bearer ${userToken()}` }), res);
    expect(res.statusCode).toBe(403);
  });
});
