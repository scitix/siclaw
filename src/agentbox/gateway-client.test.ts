import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { GatewayClient } from "./gateway-client.js";

/**
 * Tests for GatewayClient — the AgentBox-side HTTP client that talks to the
 * Gateway's internal APIs. We spin up a real http.Server on an ephemeral port
 * and drive the client against it. TLS/mTLS is exercised indirectly via the
 * cert-loading branch; the wire-level TLS is part of invariant §3 (K8s-only)
 * and is covered there rather than here.
 */

// ── Utility: local http server used as a gateway stand-in ─────────────

interface TestServer {
  server: http.Server;
  port: number;
  requests: Array<{ method: string; url: string; body: unknown }>;
  close: () => Promise<void>;
}

async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => void): Promise<TestServer> {
  const requests: TestServer["requests"] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let parsed: unknown = undefined;
      if (body) {
        try { parsed = JSON.parse(body); } catch { parsed = body; }
      }
      requests.push({ method: req.method || "", url: req.url || "", body: parsed });
      handler(req, res, parsed);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── Silence log noise ──────────────────────────────────────────────────

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("GatewayClient — construction & mTLS scope (invariant §3)", () => {
  it("does NOT load cert files when certPath is missing (plain HTTP fallback)", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-"));
    try {
      // No tls.crt/tls.key/ca.crt present — client should skip TLS setup.
      const client = new GatewayClient({ gatewayUrl: "http://localhost:1", certPath: emptyDir });
      expect(client).toBeDefined();
      // If we got here without throwing, the branch is "cert not found".
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("loads cert files from certPath when all three exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-"));
    try {
      fs.writeFileSync(path.join(dir, "tls.crt"), "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----");
      fs.writeFileSync(path.join(dir, "tls.key"), "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----");
      fs.writeFileSync(path.join(dir, "ca.crt"), "-----BEGIN CERTIFICATE-----\nFAKECA\n-----END CERTIFICATE-----");
      // Construction should not throw — we only validate the path-read branch.
      const client = new GatewayClient({ gatewayUrl: "https://gw.example:3002", certPath: dir });
      expect(client).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips trailing slash from gatewayUrl", async () => {
    const srv = await startServer((_req, res) => { res.end(JSON.stringify({ ok: true })); });
    try {
      const certPath = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-"));
      const client = new GatewayClient({ gatewayUrl: `http://127.0.0.1:${srv.port}/`, certPath });
      fs.rmSync(certPath, { recursive: true, force: true });
      await client.fetchSettings();
      expect(srv.requests[0].url).toBe("/api/internal/settings");
    } finally {
      await srv.close();
    }
  });
});

describe("GatewayClient — fetchSettings (GET JSON)", () => {
  let srv: TestServer;
  let client: GatewayClient;

  beforeAll(async () => {
    srv = await startServer((req, res) => {
      if (req.url === "/api/internal/settings") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ providers: {}, models: [] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const certPath = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-"));
    client = new GatewayClient({ gatewayUrl: `http://127.0.0.1:${srv.port}`, certPath });
    fs.rmSync(certPath, { recursive: true, force: true });
  });

  afterAll(async () => { await srv.close(); });

  it("returns parsed JSON response", async () => {
    const settings = await client.fetchSettings();
    expect(settings).toEqual({ providers: {}, models: [] });
  });
});

describe("GatewayClient — agent task CRUD", () => {
  let srv: TestServer;
  let client: GatewayClient;

  beforeAll(async () => {
    srv = await startServer((req, res) => {
      const url = req.url || "";
      if (req.method === "GET" && url === "/api/internal/agent-tasks") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tasks: [{ id: "t1", name: "cron1", schedule: "* * * * *", status: "active" }] }));
      } else if (req.method === "POST" && url === "/api/internal/agent-tasks") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "t2", name: "new", schedule: "* * * * *", status: "active" }));
      } else if (req.method === "PUT" && url.startsWith("/api/internal/agent-tasks/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "t1", name: "renamed", schedule: "* * * * *", status: "active" }));
      } else if (req.method === "DELETE" && url.startsWith("/api/internal/agent-tasks/")) {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const certPath = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-"));
    client = new GatewayClient({ gatewayUrl: `http://127.0.0.1:${srv.port}`, certPath });
    fs.rmSync(certPath, { recursive: true, force: true });
  });

  afterAll(async () => { await srv.close(); });

  it("listAgentTasks returns empty array when gateway omits 'tasks' field", async () => {
    // Probe a non-existent endpoint that returns {}
    const sep = await startServer((req, res) => {
      if (req.url === "/api/internal/agent-tasks") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({})); // no `tasks`
      } else { res.writeHead(404); res.end(); }
    });
    try {
      const certPath = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-"));
      const c = new GatewayClient({ gatewayUrl: `http://127.0.0.1:${sep.port}`, certPath });
      fs.rmSync(certPath, { recursive: true, force: true });
      const tasks = await c.listAgentTasks();
      expect(tasks).toEqual([]);
    } finally {
      await sep.close();
    }
  });

  it("listAgentTasks returns the tasks array", async () => {
    const tasks = await client.listAgentTasks();
    expect(tasks).toEqual([{ id: "t1", name: "cron1", schedule: "* * * * *", status: "active" }]);
  });

  it("createAgentTask POSTs the input and returns the response", async () => {
    const created = await client.createAgentTask({ name: "new", schedule: "* * * * *", prompt: "p" });
    expect(created.id).toBe("t2");
    const lastReq = srv.requests[srv.requests.length - 1];
    expect(lastReq.method).toBe("POST");
    expect(lastReq.body).toEqual({ name: "new", schedule: "* * * * *", prompt: "p" });
  });

  it("updateAgentTask URL-encodes the task id", async () => {
    await client.updateAgentTask("task/with/slash", { name: "renamed" });
    const lastReq = srv.requests[srv.requests.length - 1];
    expect(lastReq.url).toBe("/api/internal/agent-tasks/task%2Fwith%2Fslash");
    expect(lastReq.method).toBe("PUT");
  });

  it("deleteAgentTask resolves without returning a body", async () => {
    await expect(client.deleteAgentTask("t1")).resolves.toBeUndefined();
    const lastReq = srv.requests[srv.requests.length - 1];
    expect(lastReq.method).toBe("DELETE");
  });
});

describe("GatewayClient — searchKnowledge", () => {
  it("encodes query, topK, minScore into the query string", async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ chunks: [], message: "" }));
    });
    try {
      const certPath = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-"));
      const client = new GatewayClient({ gatewayUrl: `http://127.0.0.1:${srv.port}`, certPath });
      fs.rmSync(certPath, { recursive: true, force: true });

      await client.searchKnowledge("pod crashloop", 8, 0.5);
      expect(srv.requests[0].url).toBe("/api/internal/knowledge-search?query=pod%20crashloop&topK=8&minScore=0.5");
    } finally {
      await srv.close();
    }
  });

  it("defaults topK=5 and minScore=0.35 when omitted", async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ chunks: [] }));
    });
    try {
      const certPath = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-"));
      const client = new GatewayClient({ gatewayUrl: `http://127.0.0.1:${srv.port}`, certPath });
      fs.rmSync(certPath, { recursive: true, force: true });

      await client.searchKnowledge("q");
      expect(srv.requests[0].url).toBe("/api/internal/knowledge-search?query=q&topK=5&minScore=0.35");
    } finally {
      await srv.close();
    }
  });
});

describe("GatewayClient — toClientLike adapter", () => {
  it("exposes a request(path, method, body) function", async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ saw: req.method }));
    });
    try {
      const certPath = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-"));
      const client = new GatewayClient({ gatewayUrl: `http://127.0.0.1:${srv.port}`, certPath });
      fs.rmSync(certPath, { recursive: true, force: true });
      const like = client.toClientLike();
      const res = await like.request("/x", "POST", { a: 1 }) as { saw: string };
      expect(res.saw).toBe("POST");
      expect(srv.requests[0].body).toEqual({ a: 1 });
    } finally {
      await srv.close();
    }
  });
});

describe("GatewayClient — error handling", () => {
  it("rejects with helpful message on non-2xx status", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    try {
      const certPath = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-"));
      const client = new GatewayClient({ gatewayUrl: `http://127.0.0.1:${srv.port}`, certPath });
      fs.rmSync(certPath, { recursive: true, force: true });
      await expect(client.fetchSettings()).rejects.toThrow(/Gateway returned 500/);
    } finally {
      await srv.close();
    }
  });

  it("rejects when the response is not valid JSON (only on 2xx)", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not json");
    });
    try {
      const certPath = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-"));
      const client = new GatewayClient({ gatewayUrl: `http://127.0.0.1:${srv.port}`, certPath });
      fs.rmSync(certPath, { recursive: true, force: true });
      await expect(client.fetchSettings()).rejects.toThrow(/Failed to parse JSON/);
    } finally {
      await srv.close();
    }
  });

  it("rejects on connection refused", async () => {
    const certPath = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-"));
    // Port 1 is almost guaranteed to refuse.
    const client = new GatewayClient({ gatewayUrl: "http://127.0.0.1:1", certPath });
    fs.rmSync(certPath, { recursive: true, force: true });
    await expect(client.fetchSettings()).rejects.toThrow(/Gateway request failed/);
  });

  it("returns undefined on 204 No Content", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    try {
      const certPath = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-"));
      const client = new GatewayClient({ gatewayUrl: `http://127.0.0.1:${srv.port}`, certPath });
      fs.rmSync(certPath, { recursive: true, force: true });
      // DELETE-style call returns undefined on 204
      await expect(client.deleteAgentTask("t1")).resolves.toBeUndefined();
    } finally {
      await srv.close();
    }
  });
});
