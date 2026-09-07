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
