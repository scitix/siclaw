/**
 * McpClientManager connection observations.
 *
 * Until these existed a server that failed to connect left one console.error
 * and nothing else: the control plane saw the configured names and reported
 * "installed" for a server no session had ever reached. These tests pin the
 * per-server outcome the manager now keeps, and the error classification the
 * control plane renders, against real HTTP endpoints rather than a mocked SDK
 * so the shape the SDK actually throws is what gets classified.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpClientManager, classifyMcpConnectError } from "./mcp-client.js";

type Responder = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});

async function listen(responder: Responder): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => responder(req, body, res));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

/** The smallest streamable-http MCP server the SDK client will complete a handshake with. */
const fakeMcpServer = (tools: string[]): Responder => (req, body, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const msg = JSON.parse(body);
  if (msg.id === undefined) { // notification
    res.writeHead(202).end();
    return;
  }
  const result = msg.method === "initialize"
    ? { protocolVersion: msg.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } }
    : msg.method === "tools/list"
      ? { tools: tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) }
      : undefined;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result !== undefined
    ? { jsonrpc: "2.0", id: msg.id, result }
    : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }));
};

const HTML_404 = `<!DOCTYPE html><html lang="zh-CN"><head><title>Simate</title></head><body><h2>页面不存在</h2></body></html>`;

describe("classifyMcpConnectError", () => {
  it("recognises an HTML 404 page as not_found with a text/html hint and a stripped message", () => {
    const err = Object.assign(new Error(`Streamable HTTP error: Error POSTing to endpoint: ${HTML_404}`), { code: 404 });
    expect(classifyMcpConnectError(err)).toEqual({
      kind: "not_found", httpStatus: 404, contentType: "text/html", message: "HTML page: Simate",
    });
  });

  it("recognises an HTML body with no status as not_mcp", () => {
    const err = new Error(`Error POSTing to endpoint: ${HTML_404}`);
    expect(classifyMcpConnectError(err)).toMatchObject({ kind: "not_mcp", contentType: "text/html" });
    expect(classifyMcpConnectError(err).httpStatus).toBeUndefined();
  });

  it("maps 401/403 to auth and other statuses to http", () => {
    expect(classifyMcpConnectError(Object.assign(new Error("Unauthorized"), { code: 401 })).kind).toBe("auth");
    expect(classifyMcpConnectError(Object.assign(new Error("Forbidden"), { code: 403 })).kind).toBe("auth");
    expect(classifyMcpConnectError(Object.assign(new Error("Bad Gateway"), { code: 502 }))).toEqual({
      kind: "http", httpStatus: 502, message: "Bad Gateway",
    });
  });

  it("maps system error codes to dns / connection_refused / timeout", () => {
    expect(classifyMcpConnectError(Object.assign(new Error("getaddrinfo ENOTFOUND nowhere"), { code: "ENOTFOUND" })).kind).toBe("dns");
    expect(classifyMcpConnectError(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })).kind).toBe("connection_refused");
    expect(classifyMcpConnectError(Object.assign(new Error("aborted"), { name: "AbortError" })).kind).toBe("timeout");
    expect(classifyMcpConnectError(new Error("connect ETIMEDOUT 10.0.0.1:443 — timed out")).kind).toBe("timeout");
  });

  it("caps the message and never stores a raw HTML body", () => {
    const err = new Error(`x${"y".repeat(2_000)}`);
    const out = classifyMcpConnectError(err);
    expect(out.message.length).toBeLessThanOrEqual(300);
    const html = classifyMcpConnectError(new Error(`<html><body>${"z".repeat(5_000)}</body></html>`));
    expect(html.message).toBe("HTML page");
  });
});

describe("McpClientManager.getServerConnections", () => {
  it("records a connected server with its tool inventory and a failed one with a classified error", async () => {
    const good = await listen(fakeMcpServer(["ping", "echo"]));
    const bad = await listen((_req, _body, res) => {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML_404);
    });
    const manager = new McpClientManager({
      mcpServers: {
        devops: { transport: "streamable-http", url: good },
        siverse: { transport: "streamable-http", url: bad },
      },
    });
    try {
      await manager.initialize();
      const connections = manager.getServerConnections();
      expect(connections.map((c) => [c.name, c.state, c.toolCount])).toEqual([
        ["devops", "connected", 2],
        ["siverse", "failed", 0],
      ]);
      expect(connections[0].toolNames).toEqual(["echo", "ping"]);
      expect(connections[0].transport).toBe("streamable-http");
      expect(connections[0].error).toBeUndefined();
      expect(connections[1].error).toMatchObject({ kind: "not_found", httpStatus: 404, contentType: "text/html" });
      expect(connections[1].error?.message).toBe("HTML page: Simate");
      for (const c of connections) {
        expect(c.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(c.durationMs).toBeGreaterThanOrEqual(0);
      }
      // Tools of the failed server never reach the model; the connected one's do.
      expect(manager.getTools().map((t) => t.name)).toEqual(["mcp__devops__ping", "mcp__devops__echo"]);
    } finally {
      await manager.shutdown();
    }
  });

  it("records an unknown transport as an invalid_config failure instead of skipping silently", async () => {
    const manager = new McpClientManager({ mcpServers: { odd: { transport: "carrier-pigeon" } as any } });
    await manager.initialize();
    expect(manager.getServerConnections()).toEqual([
      expect.objectContaining({ name: "odd", state: "failed", toolCount: 0, error: { kind: "invalid_config", message: 'unknown transport "carrier-pigeon"' } }),
    ]);
  });

  it("records connection_refused when nothing listens on the port", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const manager = new McpClientManager({
      mcpServers: { gone: { transport: "streamable-http", url: `http://127.0.0.1:${port}/mcp` } },
    });
    await manager.initialize();
    expect(manager.getServerConnections()[0]).toMatchObject({ name: "gone", state: "failed", error: { kind: "connection_refused" } });
  });

  it("returns copies so a caller cannot mutate the manager's record", async () => {
    const manager = new McpClientManager({ mcpServers: { odd: { transport: "nope" } as any } });
    await manager.initialize();
    const first = manager.getServerConnections();
    first[0].state = "connected";
    first[0].toolNames.push("x");
    expect(manager.getServerConnections()[0]).toMatchObject({ state: "failed", toolNames: [] });
  });
});

describe("McpClientManager closes clients that fail after the transport is up", () => {
  it("closes the SSE stream when tools/list returns a protocol error", async () => {
    let sseOpened = 0;
    let sseClosed = 0;
    const url = await listen((req, body, res) => {
      if (req.method === "GET") { // the SDK opens the server→client SSE stream after initialize
        sseOpened++;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(":\n\n");
        // res.close fires when the client tears the stream down; req.close would
        // fire as soon as the (empty) request body is read.
        res.on("close", () => { sseClosed++; });
        return;
      }
      const msg = JSON.parse(body);
      if (msg.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "tools/list exploded" } }));
        return;
      }
      fakeMcpServer([])(req, body, res);
    });
    const manager = new McpClientManager({ mcpServers: { flaky: { transport: "streamable-http", url } } });
    await manager.initialize();
    expect(manager.getServerConnections()[0]).toMatchObject({ name: "flaky", state: "failed", error: { kind: "protocol" } });
    expect(manager.getTools()).toEqual([]);
    // Wait for the server to observe the client going away.
    for (let i = 0; i < 50 && sseClosed < sseOpened; i++) await new Promise((r) => setTimeout(r, 20));
    expect(sseOpened).toBeGreaterThan(0);
    expect(sseClosed).toBe(sseOpened);
  });
});

describe("McpClientManager paginated tool inventory", () => {
  const tool = (name: string) => ({ name, inputSchema: { type: "object", properties: {} } });
  async function paginated(page: (params: any) => unknown) {
    const requests: any[] = [];
    const url = await listen((req, body, res) => {
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const message = JSON.parse(body);
      if (message.method !== "tools/list") { fakeMcpServer([])(req, body, res); return; }
      requests.push(message.params);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...page(message.params) as object }));
    });
    const manager = new McpClientManager({ mcpServers: { metrics: { transport: "streamable-http", url } } });
    await manager.initialize();
    return { manager, requests };
  }

  it("publishes second-page tool descriptions and complete schemas to the main Agent", async () => {
    const schema = { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1 } }, required: ["query"], additionalProperties: false };
    const { manager, requests } = await paginated(params => ({ result: params?.cursor
      ? { tools: [{ name: "query", description: "Read metric samples", inputSchema: schema }] }
      : { tools: [tool("status")], nextCursor: "page-2" } }));
    try {
      expect(requests).toEqual([undefined, { cursor: "page-2" }]);
      expect(manager.getTools().map(t => t.name)).toEqual(["mcp__metrics__status", "mcp__metrics__query"]);
      expect(manager.getTools()[1]).toMatchObject({ description: "Read metric samples", parameters: schema });
      expect(manager.getServerConnections()[0]).toMatchObject({ state: "connected", toolCount: 2, toolNames: ["query", "status"] });
    } finally { await manager.shutdown(); }
  });

  it.each(["later-page-error", "repeated-cursor", "duplicate-name", "tool-budget", "byte-budget", "page-budget"])("fails closed without a partial inventory on %s", async failure => {
    let pages = 0;
    const { manager, requests } = await paginated(() => {
      pages++;
      if (pages === 1) return { result: { tools: [tool("first")], nextCursor: "next" } };
      if (failure === "later-page-error") return { error: { code: -32603, message: "Discovery unavailable" } };
      if (failure === "repeated-cursor") return { result: { tools: [], nextCursor: "next" } };
      if (failure === "duplicate-name") return { result: { tools: [tool("first")] } };
      if (failure === "tool-budget") return { result: { tools: Array.from({ length: 1000 }, (_, i) => tool(`tool-${i}`)) } };
      if (failure === "byte-budget") return { result: { tools: [{ ...tool("large"), description: "x".repeat(4 * 1024 * 1024) }] } };
      return { result: { tools: [], nextCursor: `page-${pages}` } };
    });
    try {
      expect(manager.getTools()).toEqual([]);
      expect(manager.getServerConnections()[0]).toMatchObject({ state: "failed", toolCount: 0, error: { kind: "protocol" } });
      expect(requests).toHaveLength(failure === "page-budget" ? 32 : 2);
    } finally { await manager.shutdown(); }
  });

  it("does not fetch another page or publish tools after shutdown during pagination", async () => {
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    let pages = 0;
    const url = await listen((req, body, res) => {
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const message = JSON.parse(body);
      if (message.method !== "tools/list") { fakeMcpServer([])(req, body, res); return; }
      pages++;
      const reply = () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [tool(`tool-${pages}`)], nextCursor: `page-${pages}` } }));
      };
      if (pages === 2) { release = reply; reached(); } else reply();
    });
    const manager = new McpClientManager({ mcpServers: { metrics: { transport: "streamable-http", url } } });
    const initializing = manager.initialize();
    await waiting;
    await manager.shutdown();
    release();
    await initializing;
    expect(pages).toBe(2);
    expect(manager.getTools()).toEqual([]);
    expect(manager.getServerConnections()[0]).toMatchObject({ state: "failed", error: { kind: "timeout" } });
  });
});

describe("McpClientManager.shutdown during initialize", () => {
  it("closes a connection that completes after shutdown instead of leaking it", async () => {
    let handshakes = 0;
    const url = await listen((req, body, res) => {
      const msg = JSON.parse(body);
      if (msg.method === "initialize") handshakes++;
      // Answer slowly so shutdown() can land while the SDK is still dialling.
      setTimeout(() => fakeMcpServer(["ping"])(req, body, res), 300);
    });
    const manager = new McpClientManager({ mcpServers: { slow: { transport: "streamable-http", url } } });
    const init = manager.initialize();
    await new Promise((r) => setTimeout(r, 50));
    await manager.shutdown();
    await init;
    expect(handshakes).toBe(1);
    expect(manager.getTools()).toEqual([]);
    expect(manager.getServerConnections()).toEqual([
      expect.objectContaining({ name: "slow", state: "failed", toolCount: 0, error: { kind: "timeout", message: "connection completed after the manager was shut down" } }),
    ]);
    // Nothing left to close: a second shutdown is a no-op rather than a second disconnect.
    await manager.shutdown();
  });
});
