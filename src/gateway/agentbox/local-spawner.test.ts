import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tests for LocalSpawner.
 *
 * CRITICAL (CLAUDE.md invariant §1):
 *   LocalSpawner runs ALL AgentBox instances in-process sharing one
 *   filesystem. `skillsHandler.materialize()` must NEVER be called here —
 *   it would wipe all users' skills. We enforce this by grepping the
 *   source (structural test, same style as `write-only-not-called.ts`-ish
 *   checks elsewhere).
 *
 * Structural note: the class reaches into process.env, process.cwd(), and
 * actually starts an HTTP server. We mock the heavy HTTP + session deps and
 * run the class against a real temp directory so cert writes round-trip.
 */

// ── Mocks (hoisted by vi.mock) ────────────────────────────────────────

vi.mock("../../agentbox/http-server.js", () => ({
  createHttpServer: vi.fn(() => {
    // Return a fake http.Server that listen()/close() cleanly.
    const handlers: Record<string, ((...args: any[]) => void)[]> = {};
    const server: any = {
      listen: (_port: number, _host: string, cb: () => void) => {
        setImmediate(cb);
        return server;
      },
      on: (ev: string, cb: any) => {
        (handlers[ev] ||= []).push(cb);
        return server;
      },
      close: vi.fn((cb?: () => void) => { cb?.(); }),
    };
    return server;
  }),
}));

const sessionManagerShutdownCalls: string[] = [];

vi.mock("../../agentbox/session.js", () => ({
  AgentBoxSessionManager: class {
    userId?: string;
    agentId?: string;
    knowledgeIndexer?: unknown;
    credentialsDir?: string;
    credentialBroker = { dispose: () => { sessionManagerShutdownCalls.push("broker.dispose"); } };
    async closeAll(): Promise<void> { sessionManagerShutdownCalls.push("closeAll"); }
  },
}));

// Import the SUT after mocks.
import { LocalSpawner } from "./local-spawner.js";

// ── Test helpers ──────────────────────────────────────────────────────

class FakeCertManager {
  issuedFor: Array<{ agentId: string; podEnv: string }> = [];
  issueAgentBoxCertificate(agentId: string, _orgId: string, _boxId: string, podEnv: string) {
    this.issuedFor.push({ agentId, podEnv });
    return { cert: `CERT-${agentId}`, key: `KEY-${agentId}`, ca: `CA-${agentId}` };
  }
}

let origCwd: string;
let tmpDir: string;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sessionManagerShutdownCalls.length = 0;

  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-spawner-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("LocalSpawner — spawn (happy path)", () => {
  it("issues a cert, writes cert files, and starts an HTTP server", async () => {
    const cm = new FakeCertManager();
    const spawner = new LocalSpawner(cm as any, "https://127.0.0.1:3002", 5000);
    const handle = await spawner.spawn({ agentId: "a1" });

    expect(handle.boxId).toBe("local-a1");
    expect(handle.agentId).toBe("a1");
    expect(handle.endpoint).toBe("http://127.0.0.1:5000");

    // Cert bundle was issued — CN is agentId, no userId is embedded.
    expect(cm.issuedFor).toHaveLength(1);
    expect(cm.issuedFor[0]).toEqual({ agentId: "a1", podEnv: "dev" });

    // Cert files were written into .siclaw/certs/<boxId>
    const certDir = path.join(tmpDir, ".siclaw", "certs", "local-a1");
    expect(fs.readFileSync(path.join(certDir, "cert.pem"), "utf-8")).toBe("CERT-a1");
    expect(fs.readFileSync(path.join(certDir, "key.pem"), "utf-8")).toBe("KEY-a1");
    expect(fs.readFileSync(path.join(certDir, "ca.pem"), "utf-8")).toBe("CA-a1");

    // ENV propagated for http-server to pick up
    expect(process.env.SICLAW_GATEWAY_URL).toBe("https://127.0.0.1:3002");
    expect(process.env.SICLAW_TLS_CERT).toBe(path.join(certDir, "cert.pem"));
  });

  it("returns the existing handle on a second spawn for the same agent (idempotent)", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    const h1 = await spawner.spawn({ agentId: "a1" });
    const h2 = await spawner.spawn({ agentId: "a1" });
    expect(h1).toEqual(h2);
    expect(h1.endpoint).toBe("http://127.0.0.1:5000");
  });

  it("allocates sequential ports for different agents", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    const h1 = await spawner.spawn({ agentId: "a1" });
    const h2 = await spawner.spawn({ agentId: "a2" });
    expect(h1.endpoint).toBe("http://127.0.0.1:5000");
    expect(h2.endpoint).toBe("http://127.0.0.1:5001");
  });

  it("throws when agentId is empty", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002");
    await expect(spawner.spawn({ agentId: "" })).rejects.toThrow(/non-empty agentId/);
  });
});

describe("LocalSpawner — list, get, stop, cleanup", () => {
  it("list() returns all running boxes", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    await spawner.spawn({ agentId: "a1" });
    await spawner.spawn({ agentId: "a2" });
    const all = await spawner.list();
    expect(all.map((b) => b.boxId).sort()).toEqual(["local-a1", "local-a2"]);
    expect(all.every((b) => b.status === "running")).toBe(true);
  });

  it("get() returns null for unknown boxId", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002");
    expect(await spawner.get("ghost")).toBeNull();
  });

  it("stop() removes the box, closes HTTP + session, disposes broker", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    const handle = await spawner.spawn({ agentId: "a1" });
    await spawner.stop(handle.boxId);

    expect(await spawner.get(handle.boxId)).toBeNull();
    expect(sessionManagerShutdownCalls).toContain("closeAll");
    expect(sessionManagerShutdownCalls).toContain("broker.dispose");
  });

  it("stop() on unknown boxId is a no-op", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002");
    await expect(spawner.stop("missing")).resolves.toBeUndefined();
  });

  it("cleanup() stops all boxes", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    await spawner.spawn({ agentId: "a1" });
    await spawner.spawn({ agentId: "a2" });
    await spawner.cleanup();
    expect(await spawner.list()).toEqual([]);
  });
});

describe("LocalSpawner — knowledge indexer injection", () => {
  it("setKnowledgeIndexer stores the indexer for later use", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    const fakeIndexer = { id: "ki" };
    spawner.setKnowledgeIndexer(fakeIndexer as any);
    const handle = await spawner.spawn({ agentId: "a1" });
    const box = (spawner as any).boxes.get(handle.boxId);
    expect(box.sessionManager.knowledgeIndexer).toBe(fakeIndexer);
  });

  it("does NOT set knowledgeIndexer on sessionManager when none injected", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    const handle = await spawner.spawn({ agentId: "a1" });
    const box = (spawner as any).boxes.get(handle.boxId);
    expect(box.sessionManager.knowledgeIndexer).toBeUndefined();
  });
});

describe("LocalSpawner — per-agent credential isolation", () => {
  it("uses a per-agent credentialsDir (one dir per agent, shared by callers)", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    const h1 = await spawner.spawn({ agentId: "a1" });
    const h2 = await spawner.spawn({ agentId: "a2" });
    const b1 = (spawner as any).boxes.get(h1.boxId);
    const b2 = (spawner as any).boxes.get(h2.boxId);
    expect(b1.sessionManager.credentialsDir).toContain(path.join(".siclaw", "credentials", "a1"));
    expect(b2.sessionManager.credentialsDir).toContain(path.join(".siclaw", "credentials", "a2"));
    expect(b1.sessionManager.credentialsDir).not.toBe(b2.sessionManager.credentialsDir);
  });
});

// ──────────────────────────────────────────────────────────────────────
// CLAUDE.md invariant §1 — structural guard (static check of source)
// ──────────────────────────────────────────────────────────────────────

describe("LocalSpawner — invariant §1: never calls skillsHandler.materialize", () => {
  it("local-spawner.ts source does not reference skillsHandler.materialize", () => {
    const srcPath = path.resolve(__dirname, "local-spawner.ts");
    const src = fs.readFileSync(srcPath, "utf-8");
    // The skillsHandler module itself isn't imported here either, but we
    // express the invariant in the narrowest form the guard cares about.
    expect(src).not.toMatch(/skillsHandler\s*\.\s*materialize/);
    // Defense-in-depth: skillsHandler should not be imported at all.
    expect(src).not.toMatch(/skillsHandler/);
  });
});
