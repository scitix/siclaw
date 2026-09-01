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

const createHttpServerMock = vi.hoisted(() => vi.fn());
vi.mock("../../agentbox/http-server.js", () => ({
  createHttpServer: createHttpServerMock,
}));

const syncResourceMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("../../agentbox/resource-sync.js", () => ({
  syncResource: syncResourceMock,
}));

vi.mock("../../core/config.js", () => ({
  loadConfig: () => ({ paths: { knowledgeDir: ".siclaw/knowledge" } }),
}));

const sessionManagerShutdownCalls: string[] = [];

vi.mock("../../agentbox/session.js", () => ({
  AgentBoxSessionManager: class {
    userId?: string;
    agentId?: string;
    credentialsDir?: string;
    knowledgeDir?: string;
    allowedToolsState: string[] | null = null;
    agentTypeState = "custom";
    subagentTierMenuState: unknown;
    credentialBroker = { dispose: () => { sessionManagerShutdownCalls.push("broker.dispose"); } };
    async closeAll(): Promise<void> { sessionManagerShutdownCalls.push("closeAll"); }
  },
}));

// DB mock — LocalSpawner reads agents.tool_capabilities at spawn time to resolve
// the agent's tool whitelist. Tests set `dbToolCapabilitiesRow` to control it.
let dbQueryImpl: (sql: string, params: unknown[]) => Promise<[unknown[], unknown]>;
vi.mock("../db.js", () => ({
  getDb: () => ({ query: (sql: string, params: unknown[]) => dbQueryImpl(sql, params) }),
}));

// Sub-agent tier menu resolver. Mocked rather than exercised: the resolver has its
// own tests, and what broke here was the WIRING — LocalSpawner never called it, so
// a cold Standalone box had no menu on its first turn and every child inherited
// while the candidates were already being sent.
let resolveTiersImpl: (raw: unknown) => Promise<{ menu: unknown; candidates: unknown }>;
const resolveTiersMock = vi.fn((raw: unknown) => resolveTiersImpl(raw));
vi.mock("../../portal/model-routing-config.js", () => ({
  resolveAgentSubagentTiers: (raw: unknown) => resolveTiersMock(raw),
}));

// Import the SUT after mocks.
import { LocalSpawner } from "./local-spawner.js";

// ── Test helpers ──────────────────────────────────────────────────────

class FakeCertManager {
  issuedFor: Array<{ agentId: string }> = [];
  issueAgentBoxCertificate(agentId: string, _orgId: string, _boxId: string) {
    this.issuedFor.push({ agentId });
    return { cert: `CERT-${agentId}`, key: `KEY-${agentId}`, ca: `CA-${agentId}` };
  }
}

let origCwd: string;
let tmpDir: string;

function createFakeHttpServer() {
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
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sessionManagerShutdownCalls.length = 0;
  syncResourceMock.mockClear();
  createHttpServerMock.mockReset().mockImplementation(createFakeHttpServer);
  // Default: agent has no tool_capabilities row value → unrestricted.
  dbQueryImpl = async () => [[{ tool_capabilities: null, agent_type: "custom" }], undefined];
  resolveTiersMock.mockClear();
  resolveTiersImpl = async () => ({ menu: null, candidates: null });

  origCwd = process.cwd();
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-spawner-")));
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
    expect(handle.endpoint).toBe("https://127.0.0.1:5000");

    // Cert bundle was issued — CN is agentId, no userId / env embedded.
    expect(cm.issuedFor).toHaveLength(1);
    expect(cm.issuedFor[0]).toEqual({ agentId: "a1" });

    // Cert files were written into .siclaw/certs/<boxId> using K8s-convention names
    const certDir = path.join(tmpDir, ".siclaw", "certs", "local-a1");
    expect(fs.readFileSync(path.join(certDir, "tls.crt"), "utf-8")).toBe("CERT-a1");
    expect(fs.readFileSync(path.join(certDir, "tls.key"), "utf-8")).toBe("KEY-a1");
    expect(fs.readFileSync(path.join(certDir, "ca.crt"), "utf-8")).toBe("CA-a1");

    // ENV propagated for http-server / GatewayClient to pick up
    expect(process.env.SICLAW_GATEWAY_URL).toBe("https://127.0.0.1:3002");
    expect(process.env.SICLAW_CERT_PATH).toBe(certDir);
  });

  it("isolates knowledge materialization by agent", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    await spawner.spawn({ agentId: "a1" });
    await spawner.spawn({ agentId: "a2" });

    const boxA = (spawner as any).boxes.get("local-a1");
    const boxB = (spawner as any).boxes.get("local-a2");
    expect(boxA.sessionManager.knowledgeDir).toBe(path.join(tmpDir, ".siclaw", "knowledge", "a1"));
    expect(boxB.sessionManager.knowledgeDir).toBe(path.join(tmpDir, ".siclaw", "knowledge", "a2"));

    expect(syncResourceMock).toHaveBeenCalledTimes(6);
    const knowledgeCalls = syncResourceMock.mock.calls.filter(([type]) => type === "knowledge");
    const agentBHandler = knowledgeCalls[1][2];

    fs.mkdirSync(boxA.sessionManager.knowledgeDir, { recursive: true });
    fs.mkdirSync(boxB.sessionManager.knowledgeDir, { recursive: true });
    fs.writeFileSync(path.join(boxA.sessionManager.knowledgeDir, "index.md"), "# A");
    fs.writeFileSync(path.join(boxB.sessionManager.knowledgeDir, "index.md"), "# B");
    await agentBHandler.materialize({ version: "v2", repos: [] });

    expect(fs.readFileSync(path.join(boxA.sessionManager.knowledgeDir, "index.md"), "utf8")).toBe("# A");
    expect(fs.existsSync(path.join(boxB.sessionManager.knowledgeDir, "index.md"))).toBe(false);
  });

  it("shares one knowledge handler between initial sync and HTTP reloads", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    await spawner.spawn({ agentId: "a1" });

    expect(syncResourceMock).toHaveBeenCalledTimes(3);
    const initialSyncHandler = syncResourceMock.mock.calls.find(([type]) => type === "knowledge")![2];
    expect(createHttpServerMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        disableIdleShutdown: true,
        knowledgeHandler: initialSyncHandler,
      }),
    );
  });

  it("scopes skills and MCP per Agent and wires the same handlers into reloads", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    await spawner.spawn({ agentId: "a1" });
    await spawner.spawn({ agentId: "a2" });

    const boxA = (spawner as any).boxes.get("local-a1");
    const boxB = (spawner as any).boxes.get("local-a2");
    expect(boxA.sessionManager.skillsDir).toContain(path.join(".siclaw", "skills", "agents", "a1"));
    expect(boxB.sessionManager.skillsDir).toContain(path.join(".siclaw", "skills", "agents", "a2"));
    expect(boxA.sessionManager.skillsDir).not.toBe(boxB.sessionManager.skillsDir);
    expect(boxA.sessionManager.mcpServersState).toEqual({});
    expect(boxB.sessionManager.mcpServersState).toEqual({});

    const aHttpOptions = createHttpServerMock.mock.calls[0][1];
    const aSkillSync = syncResourceMock.mock.calls.find(([type]) => type === "skills")![2];
    const aMcpSync = syncResourceMock.mock.calls.find(([type]) => type === "mcp")![2];
    expect(aHttpOptions.skillsHandler).toBe(aSkillSync);
    expect(aHttpOptions.mcpHandler).toBe(aMcpSync);
  });

  it("returns the existing handle on a second spawn for the same agent (idempotent)", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    const h1 = await spawner.spawn({ agentId: "a1" });
    const h2 = await spawner.spawn({ agentId: "a1" });
    expect(h1).toEqual(h2);
    expect(h1.endpoint).toBe("https://127.0.0.1:5000");
  });

  it("allocates sequential ports for different agents", async () => {
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    const h1 = await spawner.spawn({ agentId: "a1" });
    const h2 = await spawner.spawn({ agentId: "a2" });
    expect(h1.endpoint).toBe("https://127.0.0.1:5000");
    expect(h2.endpoint).toBe("https://127.0.0.1:5001");
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

describe("LocalSpawner — tool-capabilities injection", () => {
  it("resolves a restricted agent's capabilities into allowedToolsState at spawn", async () => {
    dbQueryImpl = async (_sql, params) => {
      expect(params).toEqual(["a1"]);
      return [[{ tool_capabilities: JSON.stringify(["read_files", "search_memory"]), agent_type: "custom" }], undefined];
    };
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    const handle = await spawner.spawn({ agentId: "a1" });
    const box = (spawner as any).boxes.get(handle.boxId);
    expect(new Set(box.sessionManager.allowedToolsState)).toEqual(
      new Set(["read", "grep", "find", "ls", "knowledge_search", "knowledge_cite", "memory_search", "memory_get"]),
    );
  });

  it("leaves allowedToolsState null for an agent with no selection (unrestricted)", async () => {
    dbQueryImpl = async () => [[{ tool_capabilities: null, agent_type: "custom" }], undefined];
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    const handle = await spawner.spawn({ agentId: "a1" });
    const box = (spawner as any).boxes.get(handle.boxId);
    expect(box.sessionManager.allowedToolsState).toBeNull();
  });

  it("fails closed when the DB lookup throws", async () => {
    dbQueryImpl = async () => { throw new Error("db down"); };
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    const handle = await spawner.spawn({ agentId: "a1" });
    const box = (spawner as any).boxes.get(handle.boxId);
    expect(box.sessionManager.allowedToolsState).toEqual([]);
    expect(box.sessionManager.harnessResolvedState).toBe(false);
  });

  it.each([
    ["the agent row is missing", []],
    ["agent_type is unknown", [{ tool_capabilities: null, agent_type: "future_type" }]],
    ["tool_capabilities JSON is malformed", [{ tool_capabilities: "not-json", agent_type: "custom" }]],
  ])("fails closed when %s", async (_label, rows) => {
    dbQueryImpl = async () => [rows, undefined] as any;
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    const handle = await spawner.spawn({ agentId: "a1" });
    const box = (spawner as any).boxes.get(handle.boxId);
    expect(box.sessionManager.allowedToolsState).toEqual([]);
    expect(box.sessionManager.harnessResolvedState).toBe(false);
  });
});

describe("LocalSpawner — locked agent-type policy (P1: parity with K8s)", () => {
  it("locks a Coordinator's capabilities + persona even with an EMPTY raw tool_capabilities", async () => {
    // The exact bug: a built-in type with no raw tool_capabilities used to resolve
    // to null (unrestricted) + default "custom" persona in local mode. It must now
    // apply the type's LOCKED capability set and agentTypeState.
    dbQueryImpl = async (_sql, params) => {
      expect(params).toEqual(["a1"]);
      return [[{ tool_capabilities: null, agent_type: "coordinator" }], undefined];
    };
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    const handle = await spawner.spawn({ agentId: "a1" });
    const box = (spawner as any).boxes.get(handle.boxId);
    // Locked, not unrestricted: a non-null, non-empty whitelist derived from the
    // coordinator type — and delegate tools present (delegate_agents capability).
    expect(Array.isArray(box.sessionManager.allowedToolsState)).toBe(true);
    expect(box.sessionManager.allowedToolsState.length).toBeGreaterThan(0);
    expect(box.sessionManager.allowedToolsState).toContain("delegate_to_agent");
    // Persona is driven by agentTypeState — must reflect the built-in type.
    expect(box.sessionManager.agentTypeState).toBe("coordinator");
    expect(box.sessionManager.harnessResolvedState).toBe(true);
  });

  it("leaves a Custom agent's raw selection + custom persona untouched", async () => {
    dbQueryImpl = async () => [[{ tool_capabilities: JSON.stringify(["read_files"]), agent_type: "custom" }], undefined];
    const spawner = new LocalSpawner(new FakeCertManager() as any, "https://127.0.0.1:3002", 5000);
    const handle = await spawner.spawn({ agentId: "a1" });
    const box = (spawner as any).boxes.get(handle.boxId);
    expect(new Set(box.sessionManager.allowedToolsState)).toEqual(
      new Set(["read", "grep", "find", "ls", "knowledge_search", "knowledge_cite"]),
    );
    expect(box.sessionManager.agentTypeState).toBe("custom");
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
    // Defense-in-depth: the process-global singleton must not be imported.
    expect(src).not.toMatch(/\bskillsHandler\b[^,}]*from\s+["'][^"']*sync-handlers/);
    expect(src).toContain("createSkillsHandler");
    expect(src).not.toContain("preserveExistingOnEmpty");
  });
});

/**
 * Cold-start bootstrap of the sub-agent tier menu.
 *
 * Local mode runs NO initial tools sync — the loop in spawn() covers only
 * knowledge/skills/mcp, and creating the tools handler just registers the later
 * reload callback. K8s is unaffected because agentbox-main awaits a tools sync
 * before it listens.
 *
 * So without an explicit resolve here the menu was null on a cold box: a
 * preconfigured agent's FIRST turn shipped tier candidates with no `model_tier` in
 * the tool schema, the lead could not name a tier it had never been offered, every
 * child inherited, and it appeared to fix itself later after some unrelated reload.
 */
/** The in-process session manager LocalSpawner created for agent a1. */
function managerOf(spawner: LocalSpawner): any {
  return (spawner as any).boxes.get("local-a1").sessionManager;
}

describe("LocalSpawner — sub-agent tier menu bootstrap", () => {
  it("resolves the menu before the box accepts prompts, from the agent's stored config", async () => {
    const MENU = { revision: "a".repeat(64), items: [{ tier: "fast", whenToUse: "read logs and summarise" }] };
    dbQueryImpl = async () => [
      [{ tool_capabilities: null, agent_type: "custom", subagent_models: '[{"tier":"fast"}]' }],
      undefined,
    ];
    resolveTiersImpl = async () => ({ menu: MENU, candidates: null });

    const cm = new FakeCertManager();
    const spawner = new LocalSpawner(cm as any, "https://127.0.0.1:3002", 5000);
    await spawner.spawn({ agentId: "a1" });

    // Resolved through the same entry point the candidates use, so both channels
    // agree on the revision — projecting the raw config separately is what made
    // them disagree before.
    expect(resolveTiersMock).toHaveBeenCalledWith('[{"tier":"fast"}]');
    expect(managerOf(spawner).subagentTierMenuState).toEqual(MENU);
  });

  it("leaves the menu null when the agent has no tiers, and still resolves tools", async () => {
    // The overwhelmingly common case: no tiers configured. Must not disturb the
    // capability resolution that shares this block.
    const cm = new FakeCertManager();
    const spawner = new LocalSpawner(cm as any, "https://127.0.0.1:3002", 5000);
    await spawner.spawn({ agentId: "a1" });

    expect(managerOf(spawner).subagentTierMenuState ?? null).toBeNull();
    expect(managerOf(spawner).harnessResolvedState).toBe(true);
  });

  it("a tier resolve failure costs the agent its tiers, never its tools", async () => {
    // Its own try/catch on purpose: falling into the capabilities fail-closed
    // handler would strip every tool over an optional optimisation.
    resolveTiersImpl = async () => { throw new Error("provider table unreachable"); };

    const cm = new FakeCertManager();
    const spawner = new LocalSpawner(cm as any, "https://127.0.0.1:3002", 5000);
    await spawner.spawn({ agentId: "a1" });

    expect(managerOf(spawner).subagentTierMenuState ?? null).toBeNull();
    expect(managerOf(spawner).harnessResolvedState).toBe(true);
    expect(managerOf(spawner).allowedToolsState).not.toEqual([]);
  });
});
