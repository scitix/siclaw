/**
 * mcp.probe RPC — dial one MCP server config from the Runtime and report the
 * outcome in the box's connection-observation shape.
 *
 * Exercised against real local HTTP endpoints so the probe classifies what the
 * MCP SDK actually throws, the same way a box does at session start.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("./chat-repo.js", () => ({
  validTraceId: (v: unknown) => (typeof v === "string" && /^[0-9a-f]{32}$/.test(v) ? v : undefined),
  warnTraceBindFailure: vi.fn(),
  ensureChatSession: vi.fn(async () => {}),
  appendMessage: vi.fn(async () => "msg-id"),
  bindMessageTraceId: vi.fn(async () => {}),
  updateMessage: vi.fn(async () => {}),
  incrementMessageCount: vi.fn(async () => {}),
}));

const { startRuntime } = await import("./server.js");

const servers: http.Server[] = [];
type Responder = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
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
const fakeMcpServer = (tools: string[]): Responder => (req, body, res) => {
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  const msg = JSON.parse(body);
  if (msg.id === undefined) { res.writeHead(202).end(); return; }
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

async function bootRuntime() {
  return startRuntime({
    config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
    agentBoxManager: {
      setCertManager: vi.fn(), setSpawnEnvResolver: vi.fn(), setPersistenceResolver: vi.fn(),
      getAsync: vi.fn(), getOrCreate: vi.fn(), list: vi.fn(async () => []), cleanup: vi.fn(async () => {}),
    } as any,
    frontendClient: { request: vi.fn(async () => ({})), onCommand: vi.fn(), emitEvent: vi.fn(), close: vi.fn() } as any,
    credentialService: {} as any,
  });
}

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;
afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});

describe("mcp.probe RPC", () => {
  it("reports a reachable MCP endpoint as connected with its tool inventory", async () => {
    const url = await listen(fakeMcpServer(["siclaw_investigate", "siclaw_get_task"]));
    server = await bootRuntime();
    const probe = server.rpcMethods.get("mcp.probe")!;
    const out: any = await probe({ server: { name: "siverse", transport: "streamable-http", url } }, { sendEvent: vi.fn() } as any);
    expect(out.ok).toBe(true);
    expect(out.probe).toMatchObject({
      name: "siverse", transport: "streamable-http", state: "connected", toolCount: 2,
      toolNames: ["siclaw_get_task", "siclaw_investigate"],
    });
    expect(out.probe.error).toBeUndefined();
  });

  it("reports a URL that answers with an HTML 404 page as not_found / text/html", async () => {
    const url = await listen((_req, _body, res) => {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><head><title>Simate</title></head><body>页面不存在</body></html>");
    });
    server = await bootRuntime();
    const probe = server.rpcMethods.get("mcp.probe")!;
    const out: any = await probe({ server: { name: "siverse", url } }, { sendEvent: vi.fn() } as any);
    expect(out.probe).toMatchObject({
      name: "siverse", transport: "streamable-http", state: "failed", toolCount: 0,
      error: { kind: "not_found", httpStatus: 404, contentType: "text/html", message: "HTML page: Simate" },
    });
  });

  it("refuses to probe a stdio server from the Runtime", async () => {
    server = await bootRuntime();
    const probe = server.rpcMethods.get("mcp.probe")!;
    const out: any = await probe({ server: { name: "chart", transport: "stdio", command: "/bin/echo" } }, { sendEvent: vi.fn() } as any);
    expect(out.probe).toMatchObject({ name: "chart", transport: "stdio", state: "failed", error: { kind: "invalid_config" } });
  });

  it("gives up with a timeout when the endpoint never answers", async () => {
    const url = await listen(() => { /* hold the request open */ });
    server = await bootRuntime();
    const probe = server.rpcMethods.get("mcp.probe")!;
    const started = Date.now();
    const out: any = await probe({ server: { name: "slow", url }, timeoutMs: 1_000 }, { sendEvent: vi.fn() } as any);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out.probe).toMatchObject({ name: "slow", state: "failed", error: { kind: "timeout" } });
  });

  it("rejects a request without a server name", async () => {
    server = await bootRuntime();
    const probe = server.rpcMethods.get("mcp.probe")!;
    await expect(probe({ server: { url: "http://127.0.0.1:1/mcp" } }, { sendEvent: vi.fn() } as any)).rejects.toThrow("server.name required");
  });
});
