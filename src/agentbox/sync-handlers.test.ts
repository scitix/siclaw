import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createClusterHandler,
  createHostHandler,
  skillsHandler,
} from "./sync-handlers.js";
import { CredentialBroker } from "./credential-broker.js";
import type {
  CredentialTransport,
  ClusterMeta,
  HostMeta,
  CredentialPayload,
} from "./credential-transport.js";

// ---------------------------------------------------------------------------
// Mock loadConfig so skillsHandler.materialize() writes to a temp directory
// instead of the real skillsDir.  The mock is module-scoped and hoisted, but
// cluster/host handler tests never call loadConfig, so they are unaffected.
// ---------------------------------------------------------------------------

let _mockSkillsDir = "";

vi.mock("../core/config.js", () => ({
  loadConfig: () => ({
    paths: { skillsDir: _mockSkillsDir },
  }),
  reloadConfig: () => ({
    paths: { skillsDir: _mockSkillsDir },
  }),
  writeConfig: () => {},
}));

class FakeTransport implements CredentialTransport {
  clusters: ClusterMeta[] = [];
  hosts: HostMeta[] = [];
  listClustersCalls = 0;
  listHostsCalls = 0;

  listClusters(): Promise<ClusterMeta[]> {
    this.listClustersCalls += 1;
    return Promise.resolve(this.clusters);
  }
  listHosts(): Promise<HostMeta[]> {
    this.listHostsCalls += 1;
    return Promise.resolve(this.hosts);
  }
  getClusterCredential(): Promise<CredentialPayload> {
    throw new Error("not used");
  }
  getHostCredential(): Promise<CredentialPayload> {
    throw new Error("not used");
  }
}

let dir: string;
let broker: CredentialBroker;
let transport: FakeTransport;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-handlers-test-"));
  transport = new FakeTransport();
  broker = new CredentialBroker(transport, dir);
});

afterEach(() => {
  broker.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createClusterHandler", () => {
  it("fetch drives broker.refreshClusters and returns count", async () => {
    transport.clusters = [
      { name: "c1", is_production: true },
      { name: "c2", is_production: false },
    ];
    const handler = createClusterHandler(broker);
    const count = await handler.fetch(null);
    expect(count).toBe(2);
    expect(transport.listClustersCalls).toBe(1);
    expect(broker.isClustersReady()).toBe(true);
    expect(broker.getClustersLocal().map((m) => m.name).sort()).toEqual(["c1", "c2"]);
  });

  it("materialize is a passthrough that returns the count verbatim", async () => {
    const handler = createClusterHandler(broker);
    await expect(handler.materialize(42)).resolves.toBe(42);
  });

  it("handler type is 'cluster'", () => {
    expect(createClusterHandler(broker).type).toBe("cluster");
  });
});

describe("createHostHandler", () => {
  it("fetch drives broker.refreshHosts and returns count", async () => {
    transport.hosts = [
      { name: "h1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: true },
    ];
    const handler = createHostHandler(broker);
    const count = await handler.fetch(null);
    expect(count).toBe(1);
    expect(transport.listHostsCalls).toBe(1);
    expect(broker.isHostsReady()).toBe(true);
  });

  it("handler type is 'host'", () => {
    expect(createHostHandler(broker).type).toBe("host");
  });
});

describe("per-broker isolation", () => {
  it("two brokers yield two independent handlers — Map isolation stays", async () => {
    // Simulate two AgentBoxes co-resident in a Local-mode process.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "sync-handlers-test-"));
    const transport2 = new FakeTransport();
    transport2.clusters = [{ name: "cB", is_production: false }];
    const broker2 = new CredentialBroker(transport2, dir2);
    try {
      transport.clusters = [{ name: "cA", is_production: true }];

      const handlerA = createClusterHandler(broker);
      const handlerB = createClusterHandler(broker2);
      await handlerA.fetch(null);
      await handlerB.fetch(null);

      // Refreshing A's handler must not touch B's Map.
      expect(broker.getClustersLocal().map((m) => m.name)).toEqual(["cA"]);
      expect(broker2.getClustersLocal().map((m) => m.name)).toEqual(["cB"]);
    } finally {
      broker2.dispose();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// skillsHandler — skill overlay materialization tests
// =========================================================================

describe("skillsHandler", () => {
  let skillsTmpDir: string;

  /** Helper: resolve the "resolved/" directory that materialize writes to. */
  function resolvedDir(): string {
    return path.join(skillsTmpDir, "resolved");
  }

  /** Read SKILL.md content from resolved/<dirName>/SKILL.md */
  function readResolved(dirName: string): string {
    return fs.readFileSync(path.join(resolvedDir(), dirName, "SKILL.md"), "utf8");
  }

  /** Check if a skill directory exists in resolved/ */
  function resolvedExists(dirName: string): boolean {
    return fs.existsSync(path.join(resolvedDir(), dirName));
  }

  beforeEach(() => {
    skillsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-handler-test-"));
    // Point the mock at our temp dir (absolute path, so path.resolve(cwd, abs) = abs)
    _mockSkillsDir = skillsTmpDir;
  });

  afterEach(() => {
    fs.rmSync(skillsTmpDir, { recursive: true, force: true });
  });

  it("has type 'skills'", () => {
    expect(skillsHandler.type).toBe("skills");
  });

  // ── 1. basic materialization ──────────────────────────────────────
  it("materializes a single skill — writes SKILL.md to resolved/", async () => {
    const payload = {
      version: new Date().toISOString(),
      skills: [
        {
          dirName: "k8s-debug",
          scope: "global" as const,
          specs: "---\nname: k8s-debug\n---\nDebug content",
          scripts: [],
        },
      ],
    };

    const count = await skillsHandler.materialize(payload);
    expect(count).toBe(1);
    expect(readResolved("k8s-debug")).toBe("---\nname: k8s-debug\n---\nDebug content");
  });

  // ── 2. skill with scripts ────────────────────────────────────────
  it("writes scripts to resolved/<name>/scripts/ with correct content", async () => {
    const payload = {
      version: new Date().toISOString(),
      skills: [
        {
          dirName: "scripted",
          scope: "builtin" as const,
          specs: "---\nname: scripted\n---\n",
          scripts: [
            { name: "check.sh", content: "#!/bin/bash\nexit 0" },
            { name: "analyze.py", content: "print('ok')" },
          ],
        },
      ],
    };

    await skillsHandler.materialize(payload);

    const scriptsDir = path.join(resolvedDir(), "scripted", "scripts");
    expect(fs.readFileSync(path.join(scriptsDir, "check.sh"), "utf8")).toBe("#!/bin/bash\nexit 0");
    expect(fs.readFileSync(path.join(scriptsDir, "analyze.py"), "utf8")).toBe("print('ok')");
  });

  // ── 3. global overrides builtin ──────────────────────────────────
  it("global scope takes priority over builtin with the same dirName", async () => {
    const payload = {
      version: new Date().toISOString(),
      skills: [
        {
          dirName: "k8s-debug",
          scope: "global" as const,
          specs: "---\nname: k8s-debug\n---\nGlobal version",
          scripts: [],
        },
        {
          dirName: "k8s-debug",
          scope: "builtin" as const,
          specs: "---\nname: k8s-debug\n---\nBuiltin version",
          scripts: [],
        },
      ],
    };

    const count = await skillsHandler.materialize(payload);
    expect(count).toBe(1);
    expect(readResolved("k8s-debug")).toBe("---\nname: k8s-debug\n---\nGlobal version");
  });

  // ── 4. only builtin ──────────────────────────────────────────────
  it("writes builtin when no global overlay exists", async () => {
    const payload = {
      version: new Date().toISOString(),
      skills: [
        {
          dirName: "k8s-debug",
          scope: "builtin" as const,
          specs: "---\nname: k8s-debug\n---\nBuiltin only",
          scripts: [],
        },
      ],
    };

    await skillsHandler.materialize(payload);
    expect(readResolved("k8s-debug")).toBe("---\nname: k8s-debug\n---\nBuiltin only");
  });

  // ── 5. empty payload ─────────────────────────────────────────────
  it("returns 0 and resolved/ is empty with no skills in payload (first spawn)", async () => {
    const payload = { version: new Date().toISOString(), skills: [] };
    const count = await skillsHandler.materialize(payload);
    expect(count).toBe(0);
    const entries = fs.readdirSync(resolvedDir());
    expect(entries).toEqual([]);
  });

  // ── 5b. defense: empty payload does NOT wipe existing skills ─────
  it("preserves resolved/ contents when an empty bundle arrives but skills already exist", async () => {
    // First materialize: real skills
    await skillsHandler.materialize({
      version: "v1",
      skills: [
        { dirName: "skill-a", scope: "global" as const, specs: "---\nname: a\n---\n", scripts: [] },
        { dirName: "skill-b", scope: "global" as const, specs: "---\nname: b\n---\n", scripts: [] },
      ],
    });
    expect(resolvedExists("skill-a")).toBe(true);
    expect(resolvedExists("skill-b")).toBe(true);

    // Then a transient-error empty bundle arrives — must NOT wipe the dir.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const count = await skillsHandler.materialize({ version: "v2", skills: [] });
    expect(count).toBe(2); // reports what it kept, not 0
    expect(resolvedExists("skill-a")).toBe(true);
    expect(resolvedExists("skill-b")).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("skipping wipe"));
    warnSpy.mockRestore();
  });

  // ── 6. multiple skills, different names ───────────────────────────
  it("materializes multiple skills with different dirNames", async () => {
    const payload = {
      version: new Date().toISOString(),
      skills: [
        { dirName: "alpha", scope: "global" as const, specs: "---\nname: alpha\n---\n", scripts: [] },
        { dirName: "beta", scope: "builtin" as const, specs: "---\nname: beta\n---\n", scripts: [] },
        { dirName: "gamma", scope: "global" as const, specs: "---\nname: gamma\n---\n", scripts: [] },
      ],
    };

    const count = await skillsHandler.materialize(payload);
    expect(count).toBe(3);
    expect(resolvedExists("alpha")).toBe(true);
    expect(resolvedExists("beta")).toBe(true);
    expect(resolvedExists("gamma")).toBe(true);
  });

  // ── 7. materialize clears previous resolved/ ─────────────────────
  it("clears previous resolved/ content on re-materialize", async () => {
    // First materialize: A and B
    await skillsHandler.materialize({
      version: "v1",
      skills: [
        { dirName: "skill-a", scope: "global" as const, specs: "---\nname: a\n---\nv1", scripts: [] },
        { dirName: "skill-b", scope: "global" as const, specs: "---\nname: b\n---\nv1", scripts: [] },
      ],
    });
    expect(resolvedExists("skill-a")).toBe(true);
    expect(resolvedExists("skill-b")).toBe(true);

    // Second materialize: only C
    await skillsHandler.materialize({
      version: "v2",
      skills: [
        { dirName: "skill-c", scope: "global" as const, specs: "---\nname: c\n---\nv2", scripts: [] },
      ],
    });

    expect(resolvedExists("skill-a")).toBe(false);
    expect(resolvedExists("skill-b")).toBe(false);
    expect(resolvedExists("skill-c")).toBe(true);
  });

  // ── 8. production agent: builtin skill with approved overlay ──────
  it("production agent gets overlay content when adapter resolves it as global scope", async () => {
    // Simulate: adapter resolved overlay and returned it as global scope
    const payload = {
      version: new Date().toISOString(),
      skills: [
        {
          dirName: "k8s-debug",
          scope: "global" as const,
          specs: "---\nname: k8s-debug\n---\nOverlay version",
          scripts: [],
        },
      ],
    };

    await skillsHandler.materialize(payload);
    expect(readResolved("k8s-debug")).toContain("Overlay version");
  });

  // ── 9. production agent: overlay NOT approved ─────────────────────
  it("production agent gets builtin when no approved overlay exists", async () => {
    // Adapter didn't find approved overlay -> returned builtin as-is
    const payload = {
      version: new Date().toISOString(),
      skills: [
        {
          dirName: "k8s-debug",
          scope: "global" as const,
          specs: "---\nname: k8s-debug\n---\nBuiltin version",
          scripts: [],
        },
      ],
    };

    await skillsHandler.materialize(payload);
    expect(readResolved("k8s-debug")).toContain("Builtin version");
  });

  // ── 10. dev agent: overlay exists (any status) ────────────────────
  it("dev agent gets latest draft overlay content", async () => {
    const payload = {
      version: new Date().toISOString(),
      skills: [
        {
          dirName: "k8s-debug",
          scope: "global" as const,
          specs: "---\nname: k8s-debug\n---\nDraft overlay",
          scripts: [],
        },
      ],
    };

    await skillsHandler.materialize(payload);
    expect(readResolved("k8s-debug")).toContain("Draft overlay");
  });

  // ── 11. overlay deleted -> revert to builtin ──────────────────────
  it("reverts to builtin content when overlay is deleted from bundle", async () => {
    // First: materialize with overlay
    await skillsHandler.materialize({
      version: "v1",
      skills: [
        {
          dirName: "k8s-debug",
          scope: "global" as const,
          specs: "---\nname: k8s-debug\n---\nOverlay content",
          scripts: [],
        },
      ],
    });
    expect(readResolved("k8s-debug")).toContain("Overlay content");

    // Then: overlay deleted, bundle returns builtin
    await skillsHandler.materialize({
      version: "v2",
      skills: [
        {
          dirName: "k8s-debug",
          scope: "builtin" as const,
          specs: "---\nname: k8s-debug\n---\nBuiltin content",
          scripts: [],
        },
      ],
    });
    expect(readResolved("k8s-debug")).toContain("Builtin content");
  });

  // ── 12. dynamic update: skill removed ─────────────────────────────
  it("removes skills no longer in the bundle on re-materialize", async () => {
    // Materialize with A and B
    await skillsHandler.materialize({
      version: "v1",
      skills: [
        { dirName: "skill-a", scope: "global" as const, specs: "---\nname: a\n---\n", scripts: [] },
        { dirName: "skill-b", scope: "global" as const, specs: "---\nname: b\n---\n", scripts: [] },
      ],
    });
    expect(resolvedExists("skill-a")).toBe(true);
    expect(resolvedExists("skill-b")).toBe(true);

    // Re-materialize with only A
    await skillsHandler.materialize({
      version: "v2",
      skills: [
        { dirName: "skill-a", scope: "global" as const, specs: "---\nname: a\n---\n", scripts: [] },
      ],
    });
    expect(resolvedExists("skill-a")).toBe(true);
    expect(resolvedExists("skill-b")).toBe(false);
  });

  // ── 13. dynamic update: overlay added ─────────────────────────────
  it("replaces builtin with overlay when overlay is added in later bundle", async () => {
    // First: builtin only
    await skillsHandler.materialize({
      version: "v1",
      skills: [
        {
          dirName: "k8s-debug",
          scope: "builtin" as const,
          specs: "---\nname: k8s-debug\n---\nOriginal builtin",
          scripts: [],
        },
      ],
    });
    expect(readResolved("k8s-debug")).toContain("Original builtin");

    // Then: overlay added (adapter now returns global scope)
    await skillsHandler.materialize({
      version: "v2",
      skills: [
        {
          dirName: "k8s-debug",
          scope: "global" as const,
          specs: "---\nname: k8s-debug\n---\nNew overlay",
          scripts: [],
        },
        {
          dirName: "k8s-debug",
          scope: "builtin" as const,
          specs: "---\nname: k8s-debug\n---\nOriginal builtin",
          scripts: [],
        },
      ],
    });
    expect(readResolved("k8s-debug")).toContain("New overlay");
    expect(readResolved("k8s-debug")).not.toContain("Original builtin");
  });

  // ── additional: scripts are replaced on overlay ───────────────────
  it("overlay scripts replace builtin scripts entirely", async () => {
    // Builtin has one script set; overlay has different scripts
    await skillsHandler.materialize({
      version: "v1",
      skills: [
        {
          dirName: "k8s-debug",
          scope: "global" as const,
          specs: "---\nname: k8s-debug\n---\nOverlay",
          scripts: [{ name: "overlay-check.sh", content: "#!/bin/bash\noverlay" }],
        },
        {
          dirName: "k8s-debug",
          scope: "builtin" as const,
          specs: "---\nname: k8s-debug\n---\nBuiltin",
          scripts: [{ name: "builtin-check.sh", content: "#!/bin/bash\nbuiltin" }],
        },
      ],
    });

    const scriptsDir = path.join(resolvedDir(), "k8s-debug", "scripts");
    expect(fs.existsSync(path.join(scriptsDir, "overlay-check.sh"))).toBe(true);
    expect(fs.existsSync(path.join(scriptsDir, "builtin-check.sh"))).toBe(false);
  });

  // ── additional: empty specs skips SKILL.md write ──────────────────
  it("does not write SKILL.md when specs is empty string", async () => {
    const payload = {
      version: new Date().toISOString(),
      skills: [
        { dirName: "empty-specs", scope: "global" as const, specs: "", scripts: [] },
      ],
    };

    await skillsHandler.materialize(payload);
    // The directory is created but SKILL.md should not exist (specs was falsy)
    expect(resolvedExists("empty-specs")).toBe(true);
    expect(fs.existsSync(path.join(resolvedDir(), "empty-specs", "SKILL.md"))).toBe(false);
  });
});

// =========================================================================
// skill directory resolution — replicates the skillsDirs logic from
// agent-factory.ts so the selection rules can be unit-tested in isolation.
// =========================================================================

describe("skill directory resolution", () => {
  // Replicate the skillsDirs logic from agent-factory.ts for testing
  function resolveSkillDirs(cwd: string, skillsBase: string): string[] {
    const resolvedSkillsDir = path.join(skillsBase, "resolved");
    const builtinPath = path.resolve(cwd, "skills", "core");
    const extensionPath = path.resolve(cwd, "skills", "extension");
    const platformPath = path.resolve(cwd, "skills", "platform");

    const skillsDirs: string[] = [];
    if (fs.existsSync(resolvedSkillsDir)) {
      skillsDirs.push(resolvedSkillsDir);
    } else {
      for (const bDir of [builtinPath, extensionPath]) {
        if (fs.existsSync(bDir)) skillsDirs.push(bDir);
      }
    }
    if (fs.existsSync(platformPath)) skillsDirs.push(platformPath);
    return skillsDirs;
  }

  let tmpDir: string;
  let skillsBase: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-dirs-test-"));
    skillsBase = path.join(tmpDir, ".siclaw", "skills");
    fs.mkdirSync(skillsBase, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. server mode: resolved/ exists → use resolved/ + platform/ ──────
  it("server mode: resolved/ takes priority over core/ and extension/ when it exists", () => {
    const resolvedDir = path.join(skillsBase, "resolved");
    const platformDir = path.join(tmpDir, "skills", "platform");
    fs.mkdirSync(resolvedDir, { recursive: true });
    fs.mkdirSync(platformDir, { recursive: true });
    // Also create core/ and extension/ to confirm they are NOT included
    fs.mkdirSync(path.join(tmpDir, "skills", "core"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "skills", "extension"), { recursive: true });

    const result = resolveSkillDirs(tmpDir, skillsBase);
    expect(result).toEqual([resolvedDir, platformDir]);
    expect(result).not.toContain(path.join(tmpDir, "skills", "core"));
    expect(result).not.toContain(path.join(tmpDir, "skills", "extension"));
  });

  // ── 2. server mode: resolved/ exists, no platform/ → use resolved/ only
  it("server mode: resolved/ exists with no platform/ → only resolved/ in list", () => {
    const resolvedDir = path.join(skillsBase, "resolved");
    fs.mkdirSync(resolvedDir, { recursive: true });

    const result = resolveSkillDirs(tmpDir, skillsBase);
    expect(result).toEqual([resolvedDir]);
  });

  // ── 3. TUI mode: no resolved/ → fallback to core/ + extension/ + platform/
  it("TUI mode: no resolved/ → falls back to core/ + extension/ + platform/", () => {
    const coreDir = path.join(tmpDir, "skills", "core");
    const extensionDir = path.join(tmpDir, "skills", "extension");
    const platformDir = path.join(tmpDir, "skills", "platform");
    fs.mkdirSync(coreDir, { recursive: true });
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.mkdirSync(platformDir, { recursive: true });

    const result = resolveSkillDirs(tmpDir, skillsBase);
    expect(result).toEqual([coreDir, extensionDir, platformDir]);
  });

  // ── 4. TUI mode: no resolved/, no extension/ → core/ + platform/ ──────
  it("TUI mode: no resolved/, no extension/ → core/ + platform/ only", () => {
    const coreDir = path.join(tmpDir, "skills", "core");
    const platformDir = path.join(tmpDir, "skills", "platform");
    fs.mkdirSync(coreDir, { recursive: true });
    fs.mkdirSync(platformDir, { recursive: true });

    const result = resolveSkillDirs(tmpDir, skillsBase);
    expect(result).toEqual([coreDir, platformDir]);
    expect(result).not.toContain(path.join(tmpDir, "skills", "extension"));
  });

  // ── 5. platform always loaded: present in both server and TUI modes ───
  it("platform/ is appended regardless of whether resolved/ exists", () => {
    const resolvedDir = path.join(skillsBase, "resolved");
    const platformDir = path.join(tmpDir, "skills", "platform");
    fs.mkdirSync(resolvedDir, { recursive: true });
    fs.mkdirSync(platformDir, { recursive: true });

    // With resolved/ present (server mode)
    let result = resolveSkillDirs(tmpDir, skillsBase);
    expect(result).toContain(platformDir);

    // Remove resolved/ (TUI mode) — platform/ should still appear
    fs.rmdirSync(resolvedDir);
    result = resolveSkillDirs(tmpDir, skillsBase);
    expect(result).toContain(platformDir);
  });

  // ── 6. platform not present → not in list ─────────────────────────────
  it("platform/ absent → not included in resolved list", () => {
    const resolvedDir = path.join(skillsBase, "resolved");
    fs.mkdirSync(resolvedDir, { recursive: true });
    // platform/ intentionally not created

    const result = resolveSkillDirs(tmpDir, skillsBase);
    expect(result).toEqual([resolvedDir]);
    expect(result).not.toContain(path.join(tmpDir, "skills", "platform"));
  });

  // ── 7. empty: nothing exists → empty list ─────────────────────────────
  it("returns empty list when no skill directories exist", () => {
    const result = resolveSkillDirs(tmpDir, skillsBase);
    expect(result).toEqual([]);
  });

  // ── 8. platform skills don't appear in resolved/ (separation) ────────
  it("resolved/ and platform/ are distinct directories — no content mixing", () => {
    const resolvedDir = path.join(skillsBase, "resolved");
    const platformDir = path.join(tmpDir, "skills", "platform");
    fs.mkdirSync(path.join(resolvedDir, "k8s-debug"), { recursive: true });
    fs.writeFileSync(path.join(resolvedDir, "k8s-debug", "SKILL.md"), "---\nname: k8s-debug\n---\n");
    fs.mkdirSync(path.join(platformDir, "skill-authoring"), { recursive: true });
    fs.writeFileSync(path.join(platformDir, "skill-authoring", "SKILL.md"), "---\nname: skill-authoring\n---\n");

    const result = resolveSkillDirs(tmpDir, skillsBase);
    expect(result).toContain(resolvedDir);
    expect(result).toContain(platformDir);

    // Verify content is isolated: k8s-debug only in resolved/, skill-authoring only in platform/
    expect(fs.existsSync(path.join(resolvedDir, "k8s-debug", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(resolvedDir, "skill-authoring"))).toBe(false);
    expect(fs.existsSync(path.join(platformDir, "skill-authoring", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(platformDir, "k8s-debug"))).toBe(false);
  });
});
