/**
 * Unit tests for the TUI-side Portal snapshot client.
 *
 * Uses a temporary cwd + a short-lived http.Server as the fake Portal so we
 * exercise the real JWT sign -> fetch -> parse path rather than mocking
 * `fetch`. Keeps the test honest about the wire-shape expectations.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import jwt from "jsonwebtoken";
import { tryLoadPortalSnapshot } from "./portal-snapshot-client.js";

const JWT_SECRET = "test-snapshot-secret-0123456789";
const RUNTIME_SECRET = "test-runtime";
const PORTAL_SECRET = "test-portal";

function writeSecrets(cwd: string, overrides: Partial<{ jwtSecret: string; runtimeSecret: string; portalSecret: string }> = {}): void {
  const dir = path.join(cwd, ".siclaw");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "local-secrets.json"), JSON.stringify({
    jwtSecret: overrides.jwtSecret ?? JWT_SECRET,
    runtimeSecret: overrides.runtimeSecret ?? RUNTIME_SECRET,
    portalSecret: overrides.portalSecret ?? PORTAL_SECRET,
  }));
}

interface FakePortal {
  port: number;
  server: http.Server;
  stop: () => Promise<void>;
  requests: Array<{ url: string; authorization: string | undefined }>;
}

async function startFakePortal(opts: {
  health?: "ok" | "fail-404" | "fail-connect";
  snapshotResponse?: { status: number; body: unknown };
  validateJwt?: boolean;
}): Promise<FakePortal> {
  const requests: FakePortal["requests"] = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? "", authorization: req.headers.authorization as string | undefined });

    if (req.url === "/api/health") {
      if (opts.health === "fail-404") { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/api/v1/cli-snapshot") {
      if (opts.validateJwt) {
        const auth = req.headers.authorization as string | undefined;
        if (!auth?.startsWith("Bearer ")) { res.writeHead(401); res.end(); return; }
        try { jwt.verify(auth.slice(7), JWT_SECRET); }
        catch { res.writeHead(401); res.end(); return; }
      }
      const r = opts.snapshotResponse ?? { status: 200, body: {
        providers: {}, default: null, mcpServers: {}, skills: [], knowledge: [],
        credentials: { clusters: [], hosts: [] },
        availableAgents: [], activeAgent: null,
        generatedAt: new Date().toISOString(),
      }};
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    server,
    requests,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("tryLoadPortalSnapshot", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-client-test-"));
  });

  afterEach(() => {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* */ }
  });

  it("returns null when no .siclaw/local-secrets.json exists", async () => {
    const result = await tryLoadPortalSnapshot({ cwd, port: 65500 });
    expect(result).toBeNull();
  });

  it("returns null when secrets file is malformed", async () => {
    fs.mkdirSync(path.join(cwd, ".siclaw"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".siclaw/local-secrets.json"), "{not valid json");
    const result = await tryLoadPortalSnapshot({ cwd, port: 65500 });
    expect(result).toBeNull();
  });

  it("returns null when Portal health probe fails (Portal not running)", async () => {
    writeSecrets(cwd);
    // port 1 is almost certainly unused and immediately rejects connect.
    const result = await tryLoadPortalSnapshot({ cwd, port: 1 });
    expect(result).toBeNull();
  });

  it("returns null when Portal is up but snapshot endpoint 401s", async () => {
    writeSecrets(cwd);
    const portal = await startFakePortal({ snapshotResponse: { status: 401, body: { error: "Unauthorized" } } });
    try {
      const result = await tryLoadPortalSnapshot({ cwd, port: portal.port });
      expect(result).toBeNull();
    } finally { await portal.stop(); }
  });

  it("signs a short-lived admin JWT with jwtSecret from the file", async () => {
    writeSecrets(cwd);
    const portal = await startFakePortal({ validateJwt: true });
    try {
      const result = await tryLoadPortalSnapshot({ cwd, port: portal.port });
      expect(result).not.toBeNull();
      // Snapshot request's Authorization must have been a valid JWT.
      const snapshotReq = portal.requests.find(r => r.url === "/api/v1/cli-snapshot");
      expect(snapshotReq).toBeDefined();
      expect(snapshotReq?.authorization?.startsWith("Bearer ")).toBe(true);
      const payload = jwt.verify(snapshotReq!.authorization!.slice(7), JWT_SECRET) as { role?: string; sub?: string };
      expect(payload.role).toBe("admin");
      expect(payload.sub).toBe("cli-local");
    } finally { await portal.stop(); }
  });

  it("parses successful snapshot response and attaches portalUrl", async () => {
    writeSecrets(cwd);
    const snapshot = {
      providers: { openai: { baseUrl: "x", apiKey: "y", api: "openai-completions", authHeader: true, models: [] } },
      default: { provider: "openai", modelId: "gpt-4" },
      mcpServers: {},
      skills: [],
      knowledge: [],
      credentials: { clusters: [], hosts: [] },
      availableAgents: [],
      activeAgent: null,
      generatedAt: "2026-01-01T00:00:00.000Z",
    };
    const portal = await startFakePortal({ snapshotResponse: { status: 200, body: snapshot } });
    try {
      const result = await tryLoadPortalSnapshot({ cwd, port: portal.port });
      expect(result).not.toBeNull();
      expect(result!.providers.openai).toBeDefined();
      expect(result!.default).toEqual({ provider: "openai", modelId: "gpt-4" });
      expect(result!.portalUrl).toBe(`http://127.0.0.1:${portal.port}`);
    } finally { await portal.stop(); }
  });

  it("honors SICLAW_PORTAL_PORT env over the opts.port", async () => {
    writeSecrets(cwd);
    const portal = await startFakePortal({});
    const before = process.env.SICLAW_PORTAL_PORT;
    process.env.SICLAW_PORTAL_PORT = String(portal.port);
    try {
      const result = await tryLoadPortalSnapshot({ cwd, port: 1 /* would fail if used */ });
      expect(result).not.toBeNull();
    } finally {
      if (before === undefined) delete process.env.SICLAW_PORTAL_PORT;
      else process.env.SICLAW_PORTAL_PORT = before;
      await portal.stop();
    }
  });
});
