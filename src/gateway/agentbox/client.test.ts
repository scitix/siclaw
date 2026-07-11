import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { AgentBoxClient } from "./client.js";

/**
 * Tests for AgentBoxClient — Gateway's HTTP client for reaching an AgentBox.
 * We spin a tiny http.Server to act as the AgentBox. mTLS is orthogonal and
 * invariant §3 (K8s-only), so we exercise plain HTTP here.
 */

// ── Test HTTP server ──────────────────────────────────────────────────

interface Capture { method: string; url: string; body: string; headers: http.IncomingHttpHeaders; }
interface Srv { server: http.Server; port: number; captures: Capture[]; close: () => Promise<void>; }

async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Srv> {
  const captures: Capture[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      captures.push({ method: req.method || "", url: req.url || "", body, headers: req.headers });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { server, port, captures, close: () => new Promise((r) => server.close(() => r())) };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("AgentBoxClient — health + generic JSON", () => {
  let srv: Srv;
  let client: AgentBoxClient;
  beforeAll(async () => {
    srv = await startServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", sessions: 2, timestamp: "now" }));
      } else if (req.url === "/api/internal/metrics-snapshot") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cpu: 0.5 }));
      } else { res.writeHead(404); res.end(); }
    });
    client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`);
  });
  afterAll(async () => { await srv.close(); });

  it("health() returns the parsed payload", async () => {
    const h = await client.health();
    expect(h).toEqual({ status: "ok", sessions: 2, timestamp: "now" });
  });

  it("getJson<T>() returns typed payload from an arbitrary path", async () => {
    const snap = await client.getJson<{ cpu: number }>("/api/internal/metrics-snapshot");
    expect(snap.cpu).toBe(0.5);
  });

  it("strips trailing slash from the endpoint", async () => {
    const c2 = new AgentBoxClient(`http://127.0.0.1:${srv.port}/`);
    await c2.health(); // should not 404 due to double slash
    expect(srv.captures.some((c) => c.url === "/health")).toBe(true);
  });
});

describe("AgentBoxClient — prompt + session CRUD", () => {
  let srv: Srv;
  let client: AgentBoxClient;
  beforeAll(async () => {
    srv = await startServer((req, res) => {
      const url = req.url || "";
      if (req.method === "POST" && url === "/api/prompt") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionId: "s1" }));
      } else if (req.method === "GET" && url === "/api/sessions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessions: [{ id: "s1", createdAt: "t", lastActiveAt: "t" }] }));
      } else if (req.method === "DELETE" && url.startsWith("/api/sessions/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (req.method === "POST" && url === "/api/sessions/s1/steer") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (req.method === "POST" && url === "/api/sessions/s1/abort") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (req.method === "POST" && url === "/api/sessions/s1/clear-queue") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ steering: ["a"], followUp: [] }));
      } else { res.writeHead(404); res.end(); }
    });
    client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`);
  });
  afterAll(async () => { await srv.close(); });

  it("prompt() posts the payload as JSON", async () => {
    const result = await client.prompt({ text: "hi" });
    expect(result).toEqual({ ok: true, sessionId: "s1" });
    const req = srv.captures.find((c) => c.url === "/api/prompt")!;
    expect(req.method).toBe("POST");
    expect(JSON.parse(req.body)).toEqual({ text: "hi" });
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("prompt() preserves optional modelRouting policy", async () => {
    await client.prompt({
      text: "hi",
      modelRouting: {
        enabled: true,
        strategy: "ordered_fallback",
        candidates: [
          { provider: "openai", modelId: "gpt-4" },
          { provider: "anthropic", modelId: "claude" },
        ],
      },
    });

    const req = srv.captures[srv.captures.length - 1];
    expect(req.url).toBe("/api/prompt");
    expect(JSON.parse(req.body).modelRouting).toEqual({
      enabled: true,
      strategy: "ordered_fallback",
      candidates: [
        { provider: "openai", modelId: "gpt-4" },
        { provider: "anthropic", modelId: "claude" },
      ],
    });
  });

  it("prompt() preserves native PDF files", async () => {
    await client.prompt({
      text: "read this",
      files: [{ mimeType: "application/pdf", filename: "runbook.pdf", data: "aGVsbG8=" }],
    });

    const req = srv.captures[srv.captures.length - 1];
    expect(req.url).toBe("/api/prompt");
    expect(JSON.parse(req.body).files).toEqual([
      { mimeType: "application/pdf", filename: "runbook.pdf", data: "aGVsbG8=" },
    ]);
  });

  it("listSessions() returns the parsed sessions array", async () => {
    const r = await client.listSessions();
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].id).toBe("s1");
  });

  it("closeSession() issues DELETE", async () => {
    await client.closeSession("s1");
    const req = srv.captures[srv.captures.length - 1];
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe("/api/sessions/s1");
  });

  it("steerSession() posts the text body", async () => {
    await client.steerSession("s1", "stop the pod");
    const req = srv.captures.find((c) => c.url === "/api/sessions/s1/steer")!;
    expect(req.method).toBe("POST");
    expect(JSON.parse(req.body)).toEqual({ text: "stop the pod" });
  });

  it("steerSession() preserves media payloads", async () => {
    await client.steerSession("s1", "inspect these", {
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
      files: [{ mimeType: "application/pdf", filename: "runbook.pdf", data: "aGVsbG8=" }],
    });
    const req = srv.captures[srv.captures.length - 1];
    expect(req.url).toBe("/api/sessions/s1/steer");
    expect(JSON.parse(req.body)).toEqual({
      text: "inspect these",
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
      files: [{ mimeType: "application/pdf", filename: "runbook.pdf", data: "aGVsbG8=" }],
    });
  });

  it("abortSession() posts to the abort endpoint", async () => {
    await client.abortSession("s1");
    const last = srv.captures[srv.captures.length - 1];
    expect(last.method).toBe("POST");
    expect(last.url).toBe("/api/sessions/s1/abort");
  });

  it("clearQueue() returns steering + followUp arrays", async () => {
    const r = await client.clearQueue("s1");
    expect(r).toEqual({ steering: ["a"], followUp: [] });
  });
});

describe("AgentBoxClient — model + context endpoints", () => {
  let srv: Srv;
  let client: AgentBoxClient;
  beforeAll(async () => {
    srv = await startServer((req, res) => {
      const url = req.url || "";
      if (req.method === "GET" && url === "/api/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ id: "m1", name: "m1", provider: "p", contextWindow: 1, maxTokens: 1, reasoning: false }] }));
      } else if (req.method === "GET" && url === "/api/sessions/s1/model") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: null }));
      } else if (req.method === "PUT" && url === "/api/sessions/s1/model") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, model: { id: "m1", name: "m1", provider: "p", contextWindow: 1, maxTokens: 1, reasoning: false } }));
      } else if (req.method === "GET" && url === "/api/sessions/s1/context") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tokens: 10, contextWindow: 100, percent: 10, isCompacting: false, inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01 }));
      } else if (req.method === "GET" && url === "/api/sessions/s1/dp-state") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ active: true }));
      } else if (req.method === "DELETE" && url === "/api/memory") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else { res.writeHead(404); res.end(); }
    });
    client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`);
  });
  afterAll(async () => { await srv.close(); });

  it("listModels() returns models array", async () => {
    const r = await client.listModels();
    expect(r.models).toHaveLength(1);
  });

  it("getModel() returns { model: null } when no model set", async () => {
    const r = await client.getModel("s1");
    expect(r.model).toBeNull();
  });

  it("setModel() PUTs provider + modelId", async () => {
    const r = await client.setModel("s1", "p", "m1");
    expect(r.ok).toBe(true);
    const req = srv.captures.find((c) => c.method === "PUT" && c.url === "/api/sessions/s1/model")!;
    expect(JSON.parse(req.body)).toEqual({ provider: "p", modelId: "m1" });
  });

  it("getContextUsage() returns token/cost breakdown", async () => {
    const r = await client.getContextUsage("s1");
    expect(r.tokens).toBe(10);
    expect(r.cost).toBe(0.01);
    expect(r.isCompacting).toBe(false);
  });

  it("getDpState() returns dp-mode snapshot", async () => {
    const r = await client.getDpState("s1");
    expect(r.active).toBe(true);
  });

  it("resetMemory() issues DELETE /api/memory", async () => {
    const r = await client.resetMemory();
    expect(r.ok).toBe(true);
  });
});

describe("AgentBoxClient — reloadResource + post", () => {
  it("reloadResource('mcp') POSTs to /api/reload-mcp", async () => {
    const srv = await startServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/reload-mcp") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, count: 3 }));
      } else { res.writeHead(404); res.end(); }
    });
    try {
      const client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`);
      const r = await client.reloadResource("mcp") as any;
      expect(r.ok).toBe(true);
      expect(r.count).toBe(3);
    } finally { await srv.close(); }
  });

  it("reloadResource('skills') POSTs to /api/reload-skills (skill-bundle invariant §2)", async () => {
    const srv = await startServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/reload-skills") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, count: 5 }));
      } else { res.writeHead(404); res.end(); }
    });
    try {
      const client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`);
      const r = await client.reloadResource("skills") as any;
      expect(r.ok).toBe(true);
    } finally { await srv.close(); }
  });

  it("post() hits an arbitrary path and returns JSON", async () => {
    const srv = await startServer((req, res) => {
      if (req.method === "POST" && req.url === "/arbitrary") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pong: true }));
      } else { res.writeHead(404); res.end(); }
    });
    try {
      const client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`);
      const r = await client.post("/arbitrary") as any;
      expect(r.pong).toBe(true);
    } finally { await srv.close(); }
  });
});

describe("AgentBoxClient — error paths", () => {
  it("throws a descriptive error on non-2xx status", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    });
    try {
      const client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`);
      await expect(client.health()).rejects.toThrow(/AgentBox request failed: 500/);
    } finally { await srv.close(); }
  });

  it("surfaces timeout errors (short timeoutMs)", async () => {
    // Server accepts the connection but never responds.
    const srv = await startServer(() => { /* hang */ });
    try {
      const client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`, 50);
      await expect(client.health()).rejects.toThrow();
    } finally {
      // Force-close any hanging sockets
      srv.server.closeAllConnections?.();
      await srv.close();
    }
  });

  it("preserves HTTP conflict metadata from a string error body", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "command_id was already used with a different payload" }));
    });
    try {
      const client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`);
      const err = await client.postJson("/command/r1", {}).catch((caught) => caught);
      expect(err).toBeInstanceOf(Error);
      expect(err).toMatchObject({
        status: 409,
        code: "CONFLICT",
        retriable: false,
      });
    } finally { await srv.close(); }
  });

  it("preserves an AgentBox-provided code/retriable on non-conflict statuses", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: { code: "BOX_STARTING", message: "session is still starting", retriable: true },
      }));
    });
    try {
      const client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`);
      const err = await client.postJson("/command/r1", {}).catch((caught) => caught);
      expect(err).toBeInstanceOf(Error);
      expect(err).toMatchObject({
        status: 503,
        code: "BOX_STARTING",
        retriable: true,
      });
    } finally { await srv.close(); }
  });
});

describe("AgentBoxClient — streamEvents (SSE)", () => {
  it("yields parsed JSON events from data: lines", async () => {
    const srv = await startServer((req, res) => {
      if (req.url?.startsWith("/api/stream/")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: {"type":"a","n":1}\n\n`);
        res.write(`data: {"type":"b"}\n\n`);
        res.end();
      } else { res.writeHead(404); res.end(); }
    });
    try {
      const client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`);
      const events: any[] = [];
      for await (const ev of client.streamEvents("s1") as AsyncIterable<any>) {
        events.push(ev);
      }
      expect(events).toEqual([{ type: "a", n: 1 }, { type: "b" }]);
    } finally { await srv.close(); }
  });

  it("accepts SSE-valid space-less data: lines and still routes comments to onComment only", async () => {
    // Per the SSE spec the value is everything after the colon minus ONE
    // optional leading space — "data:x" is as valid as "data: x". Today's box
    // always sends the space; a spec-conforming producer must not be dropped.
    const srv = await startServer((req, res) => {
      if (req.url?.startsWith("/api/stream/")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data:{"type":"tight"}\n\n`);
        res.write(`: heartbeat\n\n`);
        res.write(`data: {"type":"spaced"}\n\n`);
        res.end();
      } else { res.writeHead(404); res.end(); }
    });
    try {
      const client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`);
      const events: any[] = [];
      for await (const ev of client.streamEvents("s1") as AsyncIterable<any>) {
        events.push(ev);
      }
      expect(events).toEqual([{ type: "tight" }, { type: "spaced" }]);
    } finally { await srv.close(); }
  });

  it("skips malformed data lines without crashing the iterator", async () => {
    const srv = await startServer((req, res) => {
      if (req.url?.startsWith("/api/stream/")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: not-json\n\n`);
        res.write(`data: {"ok":true}\n\n`);
        res.end();
      } else { res.writeHead(404); res.end(); }
    });
    try {
      const client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`);
      const events: any[] = [];
      for await (const ev of client.streamEvents("s1") as AsyncIterable<any>) {
        events.push(ev);
      }
      expect(events).toEqual([{ ok: true }]);
    } finally { await srv.close(); }
  });

  it("throws when the stream returns non-200", async () => {
    const srv = await startServer((_req, res) => { res.writeHead(404); res.end(); });
    try {
      const client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`);
      const run = async () => {
        const it = client.streamEvents("s1") as AsyncIterable<any>;
        for await (const _ of it) { /* noop */ }
      };
      await expect(run()).rejects.toThrow(/Stream request failed/);
    } finally { await srv.close(); }
  });
});

describe("AgentBoxClient — prompt image URL resolution (vision-gated)", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  function imageResponse(buf: Buffer) {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    } as unknown as Response;
  }
  function mkModelConfig(input: string[], id: string) {
    return {
      name: "prov", baseUrl: "http://x", apiKey: "k", api: "openai", authHeader: false,
      models: [{ id, name: id, reasoning: false, input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
    };
  }

  let srv: Srv;
  let client: AgentBoxClient;
  let realFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    srv = await startServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/prompt") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionId: "s1" }));
      } else { res.writeHead(404); res.end(); }
    });
    client = new AgentBoxClient(`http://127.0.0.1:${srv.port}`);
  });
  afterAll(async () => { await srv.close(); });

  beforeEach(() => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "*.siflow.cn";
    realFetch = globalThis.fetch.bind(globalThis);
    // Host-split: image URLs are stubbed; the agentbox POST is forwarded to the real local server.
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      if (String(url).includes("oss.siflow.cn")) return imageResponse(PNG);
      return realFetch(url, init);
    }));
  });
  afterEach(() => {
    delete process.env.SICLAW_IMAGE_URL_ALLOWLIST;
    vi.unstubAllGlobals();
  });

  it("vision model: resolves an allowlisted URL into images; URL stays in text", async () => {
    await client.prompt({
      text: "see https://oss.siflow.cn/a.png",
      modelProvider: "openai", modelId: "gpt-4o", modelConfig: mkModelConfig(["text", "image"], "gpt-4o"),
    });
    const req = srv.captures.filter((c) => c.url === "/api/prompt").pop()!;
    const body = JSON.parse(req.body);
    expect(body.images).toEqual([{ mimeType: "image/png", data: PNG.toString("base64") }]);
    expect(body.text).toContain("oss.siflow.cn/a.png"); // original URL left in text
  });

  it("non-vision model: does NOT resolve; no images, URL stays as plain text", async () => {
    await client.prompt({
      text: "see https://oss.siflow.cn/a.png",
      modelProvider: "deepseek", modelId: "deepseek-chat", modelConfig: mkModelConfig(["text"], "deepseek-chat"),
    });
    const req = srv.captures.filter((c) => c.url === "/api/prompt").pop()!;
    const body = JSON.parse(req.body);
    expect(body.images).toBeUndefined();
    expect(body.text).toContain("oss.siflow.cn/a.png");
  });

  it("vision routing candidate (no single-model fields): still resolves", async () => {
    await client.prompt({
      text: "see https://oss.siflow.cn/a.png",
      modelRouting: {
        enabled: true,
        candidates: [{ provider: "openai", modelId: "gpt-4o", modelConfig: mkModelConfig(["text", "image"], "gpt-4o") }],
      },
    });
    const req = srv.captures.filter((c) => c.url === "/api/prompt").pop()!;
    expect(JSON.parse(req.body).images).toHaveLength(1);
  });

  it("redacts signed-URL credentials from the forwarded text (fetch still used the full URL)", async () => {
    await client.prompt({
      text: "see https://oss.siflow.cn/a.png?Signature=secret&AccessKeyId=key",
      modelProvider: "openai", modelId: "gpt-4o", modelConfig: mkModelConfig(["text", "image"], "gpt-4o"),
    });
    const req = srv.captures.filter((c) => c.url === "/api/prompt").pop()!;
    const body = JSON.parse(req.body);
    expect(body.text).toContain("oss.siflow.cn/a.png");
    expect(body.text).not.toContain("Signature"); // creds stripped from model/history text
    expect(body.text).not.toContain("secret");
    expect(body.images).toHaveLength(1); // ...but the image was still resolved (full URL fetched)
  });
});
