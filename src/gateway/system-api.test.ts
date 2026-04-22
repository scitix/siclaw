import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import jwt from "jsonwebtoken";
import { createRestRouter } from "./rest-router.js";
import { registerSystemRoutes } from "./system-api.js";
import type { RuntimeConfig } from "./config.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";

const SECRET = "system-api-secret";
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

class FakeReq extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  _body: string;
  constructor(method: string, url: string, headers: Record<string, string> = {}, body = "") {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this._body = body;
  }
}

function dispatchReq(router: ReturnType<typeof createRestRouter>, req: FakeReq, res: FakeRes): Promise<void> {
  router.handle(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
  // parseBody uses data/end events; emit them after handle() registers listeners.
  // The handler itself is deferred via Promise.resolve(...). Schedule emits on the
  // next tick to let addRoute's handler start.
  setImmediate(() => {
    if (req._body) req.emit("data", Buffer.from(req._body));
    req.emit("end");
  });
  return new Promise((r) => setTimeout(r, 10));
}

async function dispatchGet(router: ReturnType<typeof createRestRouter>, url: string, headers: Record<string, string>): Promise<FakeRes> {
  const res = new FakeRes();
  const req = new FakeReq("GET", url, headers);
  router.handle(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return res;
}

class FakeFrontendClient {
  calls: Array<{ method: string; params: any }> = [];
  responses = new Map<string, unknown>();
  request(method: string, params?: any): Promise<any> {
    this.calls.push({ method, params });
    return Promise.resolve(this.responses.get(method) ?? {});
  }
}

function adminToken(): string {
  return jwt.sign({ sub: "admin-1", role: "admin" }, SECRET);
}
function userToken(): string {
  return jwt.sign({ sub: "user-1", role: "user" }, SECRET);
}

let router: ReturnType<typeof createRestRouter>;
let frontend: FakeFrontendClient;

beforeEach(() => {
  router = createRestRouter();
  frontend = new FakeFrontendClient();
  registerSystemRoutes(router, config, frontend as unknown as FrontendWsClient);
});

describe("GET /api/v1/siclaw/system/config", () => {
  it("returns 403 to non-admin", async () => {
    const res = await dispatchGet(router, "/api/v1/siclaw/system/config", { authorization: `Bearer ${userToken()}` });
    expect(res.statusCode).toBe(403);
  });

  it("returns all config for admin", async () => {
    frontend.responses.set("config.getSystemConfig", { config: { "system.grafanaUrl": "https://g" } });
    const res = await dispatchGet(router, "/api/v1/siclaw/system/config", { authorization: `Bearer ${adminToken()}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).config).toEqual({ "system.grafanaUrl": "https://g" });
  });
});

describe("PUT /api/v1/siclaw/system/config", () => {
  it("returns 403 to non-admin", async () => {
    const res = new FakeRes();
    const req = new FakeReq("PUT", "/api/v1/siclaw/system/config",
      { authorization: `Bearer ${userToken()}` },
      JSON.stringify({ values: { "system.grafanaUrl": "https://g" } }),
    );
    await dispatchReq(router, req, res);
    expect(res.statusCode).toBe(403);
  });

  it("rejects unknown keys with 400", async () => {
    const res = new FakeRes();
    const req = new FakeReq("PUT", "/api/v1/siclaw/system/config",
      { authorization: `Bearer ${adminToken()}` },
      JSON.stringify({ values: { "system.evil": "x", "other.key": "y" } }),
    );
    await dispatchReq(router, req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Unknown config keys/);
  });

  it("rejects javascript: URLs for system.grafanaUrl", async () => {
    const res = new FakeRes();
    const req = new FakeReq("PUT", "/api/v1/siclaw/system/config",
      { authorization: `Bearer ${adminToken()}` },
      JSON.stringify({ values: { "system.grafanaUrl": "javascript:alert(1)" } }),
    );
    await dispatchReq(router, req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Invalid URL scheme/);
  });

  it("rejects non-URL values for system.grafanaUrl", async () => {
    const res = new FakeRes();
    const req = new FakeReq("PUT", "/api/v1/siclaw/system/config",
      { authorization: `Bearer ${adminToken()}` },
      JSON.stringify({ values: { "system.grafanaUrl": "not a url" } }),
    );
    await dispatchReq(router, req, res);
    expect(res.statusCode).toBe(400);
  });

  it("persists http/https URLs and passes admin userId as updated_by", async () => {
    const res = new FakeRes();
    const req = new FakeReq("PUT", "/api/v1/siclaw/system/config",
      { authorization: `Bearer ${adminToken()}` },
      JSON.stringify({ values: { "system.grafanaUrl": "https://grafana.example.com" } }),
    );
    await dispatchReq(router, req, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    const setCall = frontend.calls.find((c) => c.method === "config.setSystemConfig");
    expect(setCall).toBeDefined();
    expect(setCall!.params.key).toBe("system.grafanaUrl");
    expect(setCall!.params.value).toBe("https://grafana.example.com");
    expect(setCall!.params.updated_by).toBe("admin-1");
  });

  it("accepts empty values payload as a no-op", async () => {
    const res = new FakeRes();
    const req = new FakeReq("PUT", "/api/v1/siclaw/system/config",
      { authorization: `Bearer ${adminToken()}` },
      JSON.stringify({}),
    );
    await dispatchReq(router, req, res);
    expect(res.statusCode).toBe(200);
    expect(frontend.calls.find((c) => c.method === "config.setSystemConfig")).toBeUndefined();
  });
});
