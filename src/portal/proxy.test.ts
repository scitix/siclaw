import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";
import { createRuntimeProxy } from "./proxy.js";

// ── Helpers ──────────────────────────────────────────────────

/**
 * Build a fake IncomingMessage. The `pipe` method is overridden to no-op
 * because we don't need to forward body chunks in these tests.
 */
function fakeReq(opts: { url?: string; method?: string; headers?: Record<string, string> } = {}): any {
  const emitter = new EventEmitter() as any;
  emitter.url = opts.url ?? "/test";
  emitter.method = opts.method ?? "GET";
  emitter.headers = opts.headers ?? {};
  emitter.pipe = vi.fn();
  return emitter;
}

/** Minimal ServerResponse spy. */
function fakeRes() {
  const emitter = new EventEmitter() as any;
  emitter.headersSent = false;
  emitter.writeHead = vi.fn((_status: number, _headers?: unknown) => {
    emitter.headersSent = true;
    return emitter;
  });
  emitter.end = vi.fn((body?: unknown) => { emitter._body = body; return emitter; });
  return emitter;
}

// ── Stub http.request ────────────────────────────────────────

type RequestStub = {
  options?: http.RequestOptions;
  on: ReturnType<typeof vi.fn>;
  handlers: Map<string, (...args: any[]) => void>;
  emit: (ev: string, ...args: any[]) => void;
};

function stubHttpRequest() {
  const calls: RequestStub[] = [];
  const original = http.request;
  // @ts-ignore override for testing
  http.request = (options: http.RequestOptions, _callback?: (pr: any) => void) => {
    const handlers = new Map<string, (...args: any[]) => void>();
    const stub: RequestStub = {
      options,
      handlers,
      on: vi.fn((ev: string, fn: any) => {
        handlers.set(ev, fn);
        return stub;
      }) as any,
      emit: (ev: string, ...args: any[]) => {
        const h = handlers.get(ev);
        if (h) h(...args);
      },
    };
    calls.push(stub);
    return stub as any;
  };
  return {
    calls,
    restore: () => { http.request = original; },
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("createRuntimeProxy", () => {
  let stub: ReturnType<typeof stubHttpRequest>;

  beforeEach(() => {
    stub = stubHttpRequest();
  });

  afterEach(() => {
    stub.restore();
  });

  it("returns a function accepting req/res", () => {
    const handler = createRuntimeProxy("http://runtime:3000");
    expect(typeof handler).toBe("function");
  });

  it("forwards request options derived from the URL (http, default port 80)", () => {
    const handler = createRuntimeProxy("http://runtime.local");
    const req = fakeReq({ url: "/api/foo", method: "POST", headers: { "content-type": "application/json" } });
    const res = fakeRes();

    handler(req, res);

    expect(stub.calls).toHaveLength(1);
    const opts = stub.calls[0].options!;
    expect(opts.hostname).toBe("runtime.local");
    expect(opts.port).toBe(80);
    expect(opts.path).toBe("/api/foo");
    expect(opts.method).toBe("POST");
    expect((opts.headers as any).host).toBe("runtime.local");
    expect((opts.headers as any)["content-type"]).toBe("application/json");
  });

  it("uses port 443 for https without explicit port", () => {
    const handler = createRuntimeProxy("https://runtime.example.com");
    const req = fakeReq({ url: "/ping" });
    const res = fakeRes();

    handler(req, res);

    expect(stub.calls[0].options!.port).toBe(443);
  });

  it("respects explicit port in URL", () => {
    const handler = createRuntimeProxy("http://runtime.local:5555");
    const req = fakeReq();
    const res = fakeRes();

    handler(req, res);

    expect(stub.calls[0].options!.port).toBe("5555");
  });

  it("responds 502 JSON when proxy request errors and headers not sent", () => {
    const handler = createRuntimeProxy("http://runtime.local");
    const req = fakeReq();
    const res = fakeRes();

    handler(req, res);

    // Emit error on the proxy request
    stub.calls[0].emit("error", new Error("connection refused"));

    expect(res.writeHead).toHaveBeenCalledWith(502, { "Content-Type": "application/json" });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Runtime unavailable" }));
  });

  it("does not write headers again if headersSent is true on error", () => {
    const handler = createRuntimeProxy("http://runtime.local");
    const req = fakeReq();
    const res = fakeRes();
    res.headersSent = true;  // simulate proxyRes already piped

    handler(req, res);
    stub.calls[0].emit("error", new Error("late error"));

    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it("pipes the request body to the proxy request", () => {
    const handler = createRuntimeProxy("http://runtime.local");
    const req = fakeReq();
    const res = fakeRes();

    handler(req, res);

    expect(req.pipe).toHaveBeenCalledTimes(1);
    expect(req.pipe.mock.calls[0][1]).toEqual({ end: true });
  });
});
