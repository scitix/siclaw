/**
 * Unit tests for the TUI-side Portal snapshot client.
 *
 * Uses a temporary cwd + a short-lived http.Server as the fake Portal so we
 * exercise the real secrets-read -> header-auth -> fetch -> parse path
 * rather than mocking `fetch`. Keeps the test honest about wire shape.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { tryLoadPortalSnapshot } from "./portal-snapshot-client.js";

const JWT_SECRET = "test-snapshot-secret-0123456789";
const RUNTIME_SECRET = "test-runtime";
const PORTAL_SECRET = "test-portal";
const CLI_SNAPSHOT_SECRET = "test-cli-snapshot-secret-0123456789";
const CLI_SNAPSHOT_SECRET_HEADER = "x-siclaw-cli-snapshot-secret";

function writeSecrets(
  cwd: string,
  overrides: Partial<{ jwtSecret: string; runtimeSecret: string; portalSecret: string; cliSnapshotSecret: string | null }> = {},
): void {
  const dir = path.join(cwd, ".siclaw");
  fs.mkdirSync(dir, { recursive: true });
  const payload: Record<string, string> = {
    jwtSecret: overrides.jwtSecret ?? JWT_SECRET,
    runtimeSecret: overrides.runtimeSecret ?? RUNTIME_SECRET,
    portalSecret: overrides.portalSecret ?? PORTAL_SECRET,
  };
  // Explicit null opts out of writing cliSnapshotSecret (simulates old files).
  if (overrides.cliSnapshotSecret !== null) {
    payload.cliSnapshotSecret = overrides.cliSnapshotSecret ?? CLI_SNAPSHOT_SECRET;
  }
  fs.writeFileSync(path.join(dir, "local-secrets.json"), JSON.stringify(payload));
}

interface FakePortal {
  port: number;
  server: http.Server;
  stop: () => Promise<void>;
  requests: Array<{ url: string; authHeader: string | undefined; snapshotSecret: string | undefined }>;
}

async function startFakePortal(opts: {
  health?: "ok" | "fail-404" | "fail-connect";
  snapshotResponse?: { status: number; body: unknown };
  /** When true, the fake Portal enforces the cli-snapshot secret header. */
  validateSnapshotSecret?: boolean;
}): Promise<FakePortal> {
  const requests: FakePortal["requests"] = [];
  const server = http.createServer((req, res) => {
    requests.push({
      url: req.url ?? "",
      authHeader: req.headers.authorization as string | undefined,
      snapshotSecret: req.headers[CLI_SNAPSHOT_SECRET_HEADER] as string | undefined,
    });

    if (req.url === "/api/health") {
      if (opts.health === "fail-404") { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url?.startsWith("/api/v1/cli-snapshot")) {
      if (opts.validateSnapshotSecret) {
        const presented = req.headers[CLI_SNAPSHOT_SECRET_HEADER];
        if (presented !== CLI_SNAPSHOT_SECRET) { res.writeHead(401); res.end(); return; }
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

  it("sends the cliSnapshotSecret in the X-Siclaw-Cli-Snapshot-Secret header and no Authorization", async () => {
    writeSecrets(cwd);
    const portal = await startFakePortal({ validateSnapshotSecret: true });
    try {
      const result = await tryLoadPortalSnapshot({ cwd, port: portal.port });
      expect(result).not.toBeNull();
      const snapshotReq = portal.requests.find(r => r.url.startsWith("/api/v1/cli-snapshot"));
      expect(snapshotReq).toBeDefined();
      expect(snapshotReq!.snapshotSecret).toBe(CLI_SNAPSHOT_SECRET);
      // No Authorization header — the client must not forge admin JWTs.
      expect(snapshotReq!.authHeader).toBeUndefined();
    } finally { await portal.stop(); }
  });

  it("returns null when the secrets file is from an older version with no cliSnapshotSecret", async () => {
    // Old `.siclaw/local-secrets.json` (pre cli-snapshot-secret split) should
    // degrade gracefully — TUI falls back to settings.json rather than sending
    // a bogus empty header that Portal would 401 on.
    writeSecrets(cwd, { cliSnapshotSecret: null });
    const portal = await startFakePortal({ validateSnapshotSecret: true });
    try {
      const result = await tryLoadPortalSnapshot({ cwd, port: portal.port });
      expect(result).toBeNull();
      // Should NOT even have reached the snapshot endpoint.
      const snapshotReq = portal.requests.find(r => r.url.startsWith("/api/v1/cli-snapshot"));
      expect(snapshotReq).toBeUndefined();
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
