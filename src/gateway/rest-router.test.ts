import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import jwt from "jsonwebtoken";
import {
  createRestRouter,
  sendJson,
  parseBody,
  parseQuery,
  requireAuth,
  requireAdmin,
} from "./rest-router.js";

// ── Helpers ────────────────────────────────────────────────────

function makeReq(method: string, url: string, headers: Record<string, string> = {}): http.IncomingMessage {
  return { method, url, headers } as unknown as http.IncomingMessage;
}

class FakeRes {
  statusCode = 0;
  headers: Record<string, string | number> = {};
  body = "";
  headersSent = false;
  writeHead(status: number, headers: Record<string, string | number>): this {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  end(data?: string): void {
    if (data) this.body = data;
  }
}

function asHttpRes(fake: FakeRes): http.ServerResponse {
  return fake as unknown as http.ServerResponse;
}

// ── createRestRouter ───────────────────────────────────────────

describe("createRestRouter.handle", () => {
  it("routes a GET with a path param and returns true", async () => {
    const router = createRestRouter();
    const captured: Record<string, string>[] = [];
    router.get("/users/:id", (_req, _res, params) => { captured.push(params); });

    const res = new FakeRes();
    const handled = router.handle(makeReq("GET", "/users/42"), asHttpRes(res));
    expect(handled).toBe(true);
    // Handler runs inside Promise.resolve, so wait a tick:
    await new Promise((r) => setImmediate(r));
    expect(captured).toEqual([{ id: "42" }]);
  });

  it("URL-decodes path parameters", async () => {
    const router = createRestRouter();
    let got: Record<string, string> | undefined;
    router.get("/files/:name", (_req, _res, params) => { got = params; });
    router.handle(makeReq("GET", "/files/hello%20world"), asHttpRes(new FakeRes()));
    await new Promise((r) => setImmediate(r));
    expect(got).toEqual({ name: "hello world" });
  });

  it("returns false when no route matches", () => {
    const router = createRestRouter();
    router.get("/a", () => {});
    expect(router.handle(makeReq("GET", "/b"), asHttpRes(new FakeRes()))).toBe(false);
  });

  it("does not dispatch when the method does not match", () => {
    const router = createRestRouter();
    const called = vi.fn();
    router.get("/x", called);
    router.post("/x", called);
    router.handle(makeReq("PUT", "/x"), asHttpRes(new FakeRes()));
    expect(called).not.toHaveBeenCalled();
  });

  it("strips the query string when matching", async () => {
    const router = createRestRouter();
    const called = vi.fn();
    router.get("/search", called);
    router.handle(makeReq("GET", "/search?q=abc"), asHttpRes(new FakeRes()));
    await new Promise((r) => setImmediate(r));
    expect(called).toHaveBeenCalled();
  });

  it("handles async errors by responding 500 when headers not already sent", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const router = createRestRouter();
    router.get("/boom", async () => { throw new Error("oops"); });
    const res = new FakeRes();
    router.handle(makeReq("GET", "/boom"), asHttpRes(res));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain("Internal server error");
    errSpy.mockRestore();
  });

  it("does not double-write response when handler already sent headers", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const router = createRestRouter();
    router.get("/err", async (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      throw new Error("after-response");
    });
    const res = new FakeRes();
    router.handle(makeReq("GET", "/err"), asHttpRes(res));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("ok");
    errSpy.mockRestore();
  });

  it("routes distinct methods independently", async () => {
    const router = createRestRouter();
    const g = vi.fn(), p = vi.fn(), u = vi.fn(), d = vi.fn();
    router.get("/r", g);
    router.post("/r", p);
    router.put("/r", u);
    router.delete("/r", d);
    router.handle(makeReq("POST", "/r"), asHttpRes(new FakeRes()));
    router.handle(makeReq("PUT", "/r"), asHttpRes(new FakeRes()));
    router.handle(makeReq("DELETE", "/r"), asHttpRes(new FakeRes()));
    await new Promise((r) => setImmediate(r));
    expect(g).not.toHaveBeenCalled();
    expect(p).toHaveBeenCalledOnce();
    expect(u).toHaveBeenCalledOnce();
    expect(d).toHaveBeenCalledOnce();
  });
});

// ── sendJson ───────────────────────────────────────────────────

describe("sendJson", () => {
  it("writes JSON with content-type and content-length", () => {
    const res = new FakeRes();
    sendJson(asHttpRes(res), 201, { ok: true, n: 2 });
    expect(res.statusCode).toBe(201);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(res.headers["Content-Length"]).toBe(Buffer.byteLength('{"ok":true,"n":2}'));
    expect(JSON.parse(res.body)).toEqual({ ok: true, n: 2 });
  });
});

// ── parseBody ──────────────────────────────────────────────────

describe("parseBody", () => {
  class FakeReq extends EventEmitter {}
  it("parses a complete JSON body", async () => {
    const req = new FakeReq() as any;
    const p = parseBody<{ a: number }>(req);
    req.emit("data", Buffer.from('{"a":'));
    req.emit("data", Buffer.from("1}"));
    req.emit("end");
    await expect(p).resolves.toEqual({ a: 1 });
  });

  it("resolves to an empty object when body is empty", async () => {
    const req = new FakeReq() as any;
    const p = parseBody(req);
    req.emit("end");
    await expect(p).resolves.toEqual({});
  });

  it("rejects on invalid JSON", async () => {
    const req = new FakeReq() as any;
    const p = parseBody(req);
    req.emit("data", Buffer.from("not-json"));
    req.emit("end");
    await expect(p).rejects.toThrow(/Invalid JSON/);
  });

  it("rejects on stream error", async () => {
    const req = new FakeReq() as any;
    const p = parseBody(req);
    req.emit("error", new Error("socket hangup"));
    await expect(p).rejects.toThrow("socket hangup");
  });
});

// ── parseQuery ────────────────────────────────────────────────

describe("parseQuery", () => {
  it("returns empty object when url has no query", () => {
    expect(parseQuery("/path")).toEqual({});
  });
  it("parses key/value pairs", () => {
    expect(parseQuery("/p?a=1&b=two")).toEqual({ a: "1", b: "two" });
  });
  it("decodes percent-encoded values", () => {
    expect(parseQuery("/p?q=hello%20world")).toEqual({ q: "hello world" });
  });
});

// ── requireAuth ───────────────────────────────────────────────

describe("requireAuth", () => {
  const SECRET = "jwt-secret-1";

  it("returns identity from a valid JWT", () => {
    const token = jwt.sign({ sub: "u-jwt", role: "user" }, SECRET);
    const req = makeReq("GET", "/", { authorization: `Bearer ${token}` });
    const auth = requireAuth(req, SECRET);
    expect(auth?.userId).toBe("u-jwt");
    expect(auth?.role).toBe("user");
  });

  it("returns null when no auth is provided", () => {
    expect(requireAuth(makeReq("GET", "/"), SECRET)).toBeNull();
  });

  it("returns null when JWT signature invalid", () => {
    const token = jwt.sign({ sub: "u" }, "other-secret");
    const req = makeReq("GET", "/", { authorization: `Bearer ${token}` });
    expect(requireAuth(req, SECRET)).toBeNull();
  });
});

// ── requireAdmin ──────────────────────────────────────────────

describe("requireAdmin", () => {
  const SECRET = "jwt-secret-2";

  it("returns context when user has admin role", () => {
    const token = jwt.sign({ sub: "u", role: "admin" }, SECRET);
    const req = makeReq("GET", "/", { authorization: `Bearer ${token}` });
    const auth = requireAdmin(req, SECRET);
    expect(auth?.role).toBe("admin");
  });

  it("returns null when role is not admin", () => {
    const token = jwt.sign({ sub: "u", role: "user" }, SECRET);
    const req = makeReq("GET", "/", { authorization: `Bearer ${token}` });
    expect(requireAdmin(req, SECRET)).toBeNull();
  });

  it("returns null when no auth at all", () => {
    expect(requireAdmin(makeReq("GET", "/"), SECRET)).toBeNull();
  });
});
