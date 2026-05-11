import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import AdmZip from "adm-zip";
import * as tar from "tar";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

vi.mock("../gateway/skills/builtin-sync.js", () => ({
  parseSkillsDir: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import { parseSkillsDir } from "../gateway/skills/builtin-sync.js";
import type { ParsedSkill } from "../gateway/skills/builtin-sync.js";
import { computeImportDiff, executeImport, parseSkillPack } from "./skill-import.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── computeImportDiff ────────────────────────────────────────

describe("computeImportDiff", () => {
  const mkSkill = (name: string, extras: Partial<ParsedSkill> = {}): ParsedSkill => ({
    name,
    description: extras.description ?? `${name} desc`,
    labels: extras.labels ?? [],
    specs: extras.specs ?? `specs of ${name}`,
    scripts: extras.scripts ?? [],
  });

  it("returns empty diffs when both sides are empty", async () => {
    const query = vi.fn().mockResolvedValueOnce([[], []]);
    (getDb as any).mockReturnValue({ query });

    const diff = await computeImportDiff("org1", []);
    expect(diff).toEqual({ added: [], updated: [], deleted: [], unchanged: [] });
  });

  it("detects added skills (new names not in DB)", async () => {
    const query = vi.fn().mockResolvedValueOnce([[], []]);
    (getDb as any).mockReturnValue({ query });

    const diff = await computeImportDiff("org1", [mkSkill("new-one"), mkSkill("new-two")]);
    expect(diff.added.map(d => d.name)).toEqual(["new-one", "new-two"]);
    expect(diff.added.every(d => typeof d.description === "string")).toBe(true);
    expect(diff.updated).toEqual([]);
    expect(diff.deleted).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it("detects unchanged skills when specs + scripts match", async () => {
    const incoming = [mkSkill("alpha", { specs: "same", scripts: [{ name: "s.sh", content: "echo" }] })];
    const query = vi.fn().mockResolvedValueOnce([[
      { id: "s1", name: "alpha", description: "alpha desc", specs: "same", scripts: JSON.stringify([{ name: "s.sh", content: "echo" }]) },
    ], []]);
    (getDb as any).mockReturnValue({ query });

    const diff = await computeImportDiff("org1", incoming);
    expect(diff.unchanged.map(d => d.name)).toEqual(["alpha"]);
    expect(diff.updated).toEqual([]);
    expect(diff.added).toEqual([]);
  });

  it("detects updated skills when specs differ", async () => {
    const incoming = [mkSkill("alpha", { specs: "NEW" })];
    const query = vi.fn().mockResolvedValueOnce([[
      { id: "s1", name: "alpha", description: "alpha desc", specs: "OLD", scripts: "[]" },
    ], []]);
    (getDb as any).mockReturnValue({ query });

    const diff = await computeImportDiff("org1", incoming);
    expect(diff.updated.map(d => d.name)).toEqual(["alpha"]);
  });

  it("detects updated skills when scripts differ", async () => {
    const incoming = [mkSkill("alpha", { scripts: [{ name: "s.sh", content: "new" }] })];
    const query = vi.fn().mockResolvedValueOnce([[
      { id: "s1", name: "alpha", description: "alpha desc", specs: "specs of alpha", scripts: JSON.stringify([{ name: "s.sh", content: "old" }]) },
    ], []]);
    (getDb as any).mockReturnValue({ query });

    const diff = await computeImportDiff("org1", incoming);
    expect(diff.updated.map(d => d.name)).toEqual(["alpha"]);
  });

  it("treats DB scripts stored as object (not string) correctly", async () => {
    const incoming = [mkSkill("alpha", { scripts: [{ name: "s.sh", content: "x" }] })];
    const query = vi.fn().mockResolvedValueOnce([[
      { id: "s1", name: "alpha", description: "alpha desc", specs: "specs of alpha", scripts: [{ name: "s.sh", content: "x" }] },
    ], []]);
    (getDb as any).mockReturnValue({ query });

    const diff = await computeImportDiff("org1", incoming);
    expect(diff.unchanged.map(d => d.name)).toEqual(["alpha"]);
  });

  it("returns deleted skills with bound_agents list", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[
        { id: "s-del", name: "gone", specs: "x", scripts: "[]" },
      ], []])
      .mockResolvedValueOnce([[
        { id: "a1", name: "Agent One" },
        { id: "a2", name: "Agent Two" },
      ], []]);
    (getDb as any).mockReturnValue({ query });

    const diff = await computeImportDiff("org1", []);
    expect(diff.deleted).toHaveLength(1);
    expect(diff.deleted[0].name).toBe("gone");
    expect(diff.deleted[0].bound_agents).toEqual([
      { id: "a1", name: "Agent One" },
      { id: "a2", name: "Agent Two" },
    ]);
  });
});

// ── executeImport ────────────────────────────────────────────

describe("executeImport", () => {
  function makeDb() {
    const conn = {
      query: vi.fn(),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    const query = vi.fn();
    const getConnection = vi.fn().mockResolvedValue(conn);
    return { query, conn, getConnection, db: { query, getConnection } };
  }

  const mkSkill = (name: string, overrides: Partial<ParsedSkill> = {}): ParsedSkill => ({
    name,
    description: overrides.description ?? `${name} desc`,
    labels: overrides.labels ?? [],
    specs: overrides.specs ?? `specs of ${name}`,
    scripts: overrides.scripts ?? [],
  });

  it("rolls back and rethrows when ADD insert fails", async () => {
    const { db, conn, query } = makeDb();
    (getDb as any).mockReturnValue(db);

    // computeImportDiff reads builtins → empty (so 'new' is added)
    query.mockResolvedValueOnce([[], []]);
    // buildByName query
    query.mockResolvedValueOnce([[], []]);

    conn.query.mockRejectedValueOnce(new Error("insert fail"));

    await expect(executeImport("org1", [mkSkill("new")], "userA", "msg", { mode: "sync" }))
      .rejects.toThrow("insert fail");

    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it("adds, updates, and deletes builtins and stores a history snapshot", async () => {
    const { db, conn, query } = makeDb();
    (getDb as any).mockReturnValue(db);

    // computeImportDiff:
    //   - builtins: alpha (will be updated), gone (will be deleted)
    //   - incoming: alpha (changed), brand-new (will be added)
    query.mockResolvedValueOnce([[
      { id: "s-alpha", name: "alpha", description: "alpha desc", specs: "OLD", scripts: "[]" },
      { id: "s-gone", name: "gone", description: "gone desc", specs: "x", scripts: "[]" },
    ], []]);
    // bound_agents for gone
    query.mockResolvedValueOnce([[{ id: "a1", name: "Agent 1" }], []]);
    // executeImport's builtin name→id lookup
    query.mockResolvedValueOnce([[
      { id: "s-alpha", name: "alpha" },
      { id: "s-gone", name: "gone" },
    ], []]);

    // Transaction queries:
    //   ADD: INSERT skills + INSERT skill_versions (for brand-new)
    //   UPDATE: SELECT MAX(version), UPDATE skills, INSERT skill_versions
    //   DELETE: SELECT overlays, DELETE agent_skills, DELETE skills
    conn.query
      .mockResolvedValueOnce([undefined, []])       // INSERT skills (add)
      .mockResolvedValueOnce([undefined, []])       // INSERT skill_versions (add)
      .mockResolvedValueOnce([[{ v: 2 }], []])      // MAX version
      .mockResolvedValueOnce([undefined, []])       // UPDATE skills
      .mockResolvedValueOnce([undefined, []])       // INSERT skill_versions (update)
      .mockResolvedValueOnce([[], []])              // SELECT overlays
      .mockResolvedValueOnce([undefined, []])       // DELETE agent_skills
      .mockResolvedValueOnce([undefined, []]);      // DELETE skills

    // Snapshot queries (after transaction)
    query.mockResolvedValueOnce([[{ v: 4 }], []]);  // max history version
    query.mockResolvedValueOnce([undefined, []]);    // insert history
    query.mockResolvedValueOnce([undefined, []]);    // prune history

    const incoming = [
      mkSkill("alpha", { specs: "NEW" }),
      mkSkill("brand-new"),
    ];
    const notify = vi.fn();
    const result = await executeImport("org1", incoming, "userA", "rel", { mode: "sync", notifyAgentReload: notify });

    expect(result.added.map(d => d.name)).toEqual(["brand-new"]);
    expect(result.updated.map(d => d.name)).toEqual(["alpha"]);
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].name).toBe("gone");
    expect(result.deleted[0].description).toBe("gone desc");
    expect(result.version).toBe(5);
    expect(result.import_id).toBeDefined();

    expect(conn.commit).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("a1", ["skills"]);
  });

  it("promotes overlay when deleting a builtin that has one", async () => {
    const { db, conn, query } = makeDb();
    (getDb as any).mockReturnValue(db);

    // computeImportDiff — builtin 'gone' will be deleted
    query.mockResolvedValueOnce([[
      { id: "s-gone", name: "gone", description: "gone desc", specs: "x", scripts: "[]" },
    ], []]);
    query.mockResolvedValueOnce([[], []]);  // bound_agents — empty

    // executeImport name→id map
    query.mockResolvedValueOnce([[{ id: "s-gone", name: "gone" }], []]);

    // Transaction queries (only delete path executes)
    conn.query
      .mockResolvedValueOnce([[{ id: "overlay-1" }], []])  // SELECT overlays → overlay exists
      .mockResolvedValueOnce([undefined, []])               // UPDATE overlay_of = NULL
      .mockResolvedValueOnce([undefined, []])               // UPDATE agent_skills
      .mockResolvedValueOnce([undefined, []]);              // DELETE skills

    // Snapshot queries
    query.mockResolvedValueOnce([[{ v: 0 }], []]);
    query.mockResolvedValueOnce([undefined, []]);
    query.mockResolvedValueOnce([undefined, []]);

    const result = await executeImport("org1", [], "userA", "", { mode: "sync" });

    expect(result.deleted).toHaveLength(1);
    expect(conn.commit).toHaveBeenCalled();

    // Verify overlay promotion path: NOT delete agent_skills before rebind
    const sqls = conn.query.mock.calls.map(c => c[0] as string);
    expect(sqls).toContain("UPDATE skills SET overlay_of = NULL, updated_at = CURRENT_TIMESTAMP WHERE overlay_of = ?");
    expect(sqls).not.toContain("DELETE FROM agent_skills WHERE skill_id = ?");
  });

  it("upsert mode skips deletes and reports empty deleted list", async () => {
    const { db, conn, query } = makeDb();
    (getDb as any).mockReturnValue(db);

    // computeImportDiff:
    //   - builtins: alpha (will be updated), gone (would be deleted in sync mode)
    //   - incoming: alpha (changed)
    query.mockResolvedValueOnce([[
      { id: "s-alpha", name: "alpha", description: "alpha desc", specs: "OLD", scripts: "[]" },
      { id: "s-gone", name: "gone", description: "gone desc", specs: "x", scripts: "[]" },
    ], []]);
    // bound_agents for 'gone' (computeImportDiff still inspects them — no policy applied yet)
    query.mockResolvedValueOnce([[{ id: "a1", name: "Agent 1" }], []]);

    // executeImport's builtin name→id lookup
    query.mockResolvedValueOnce([[
      { id: "s-alpha", name: "alpha" },
      { id: "s-gone", name: "gone" },
    ], []]);

    // Transaction queries — only UPDATE path should run, no DELETE.
    conn.query
      .mockResolvedValueOnce([[{ v: 1 }], []])      // MAX version
      .mockResolvedValueOnce([undefined, []])        // UPDATE skills
      .mockResolvedValueOnce([undefined, []]);       // INSERT skill_versions

    // Snapshot queries
    query.mockResolvedValueOnce([[{ v: 0 }], []]);
    query.mockResolvedValueOnce([undefined, []]);
    query.mockResolvedValueOnce([undefined, []]);

    const notify = vi.fn();
    const result = await executeImport(
      "org1",
      [mkSkill("alpha", { specs: "NEW" })],
      "userA",
      "upsert-test",
      { mode: "upsert", notifyAgentReload: notify },
    );

    expect(result.updated.map(d => d.name)).toEqual(["alpha"]);
    expect(result.deleted).toEqual([]);
    expect(conn.commit).toHaveBeenCalled();
    // Should NOT have touched the delete branch at all.
    const sqls = conn.query.mock.calls.map(c => c[0] as string);
    expect(sqls).not.toContain("DELETE FROM skills WHERE id = ?");
    expect(sqls).not.toContain("DELETE FROM agent_skills WHERE skill_id = ?");
    expect(sqls).not.toContain("SELECT id FROM skills WHERE overlay_of = ?");
    // No agents to notify since nothing was unbound.
    expect(notify).not.toHaveBeenCalled();
  });
});

// ── parseSkillPack ────────────────────────────────────────────

describe("parseSkillPack", () => {
  it("extracts a zip and forwards the directory to parseSkillsDir", async () => {
    const zip = new AdmZip();
    zip.addFile("my-skill/SKILL.md", Buffer.from("---\nname: my-skill\ndescription: x\n---\n"));
    zip.addFile("meta.json", Buffer.from('{"labels":{"my-skill":["t"]}}'));

    let observedDir = "";
    (parseSkillsDir as any).mockImplementation((dir: string) => {
      observedDir = dir;
      return [];
    });

    await parseSkillPack(zip.toBuffer());

    expect(observedDir).toMatch(/^\/tmp\/skill-import-/);
    expect(parseSkillsDir).toHaveBeenCalledTimes(1);
    // Extraction dir is cleaned up in the finally block.
    expect(fs.existsSync(observedDir)).toBe(false);
  });

  it("descends into a single wrapper directory when there is no root meta.json", async () => {
    const zip = new AdmZip();
    zip.addFile("wrapper/my-skill/SKILL.md", Buffer.from("---\nname: my-skill\ndescription: x\n---\n"));

    let observedDir = "";
    (parseSkillsDir as any).mockImplementation((dir: string) => {
      observedDir = dir;
      return [];
    });

    await parseSkillPack(zip.toBuffer());

    expect(path.basename(observedDir)).toBe("wrapper");
  });

  it("rejects entries with parent-directory traversal", async () => {
    // adm-zip's addFile() sanitises `..` segments, so we forge a malicious
    // entry by overwriting entryName after creation — this matches what an
    // attacker could do by crafting the zip bytes directly.
    const zip = new AdmZip();
    zip.addFile("evil.txt", Buffer.from("pwned"));
    zip.getEntries()[0].entryName = "../evil.txt";
    const buf = zip.toBuffer();

    await expect(parseSkillPack(buf)).rejects.toThrow(/Unsafe path/);
    expect(parseSkillsDir).not.toHaveBeenCalled();
  });

  /**
   * Build a tar (optionally gzipped) buffer from a layout of paths → contents.
   * Uses tar.create against a real staging dir so the encoding matches what a
   * normal `tar c` command would produce.
   */
  async function buildTarBuffer(
    layout: Record<string, string>,
    opts: { gzip?: boolean } = {},
  ): Promise<Buffer> {
    const stage = path.join(os.tmpdir(), `skill-import-test-${crypto.randomUUID()}`);
    fs.mkdirSync(stage, { recursive: true });
    try {
      for (const [rel, content] of Object.entries(layout)) {
        const full = path.join(stage, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
      const chunks: Buffer[] = [];
      const stream = tar.create({ cwd: stage, gzip: opts.gzip ?? false }, ["."]);
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }

  it("extracts a tar archive and forwards the directory to parseSkillsDir", async () => {
    const buf = await buildTarBuffer({
      "my-skill/SKILL.md": "---\nname: my-skill\ndescription: x\n---\n",
      "meta.json": '{"labels":{"my-skill":["t"]}}',
    });

    let observedDir = "";
    let extractedFiles: string[] = [];
    (parseSkillsDir as any).mockImplementation((dir: string) => {
      observedDir = dir;
      extractedFiles = fs.readdirSync(dir);
      return [];
    });

    await parseSkillPack(buf);

    expect(observedDir).toMatch(/^\/tmp\/skill-import-/);
    expect(extractedFiles).toEqual(expect.arrayContaining(["my-skill", "meta.json"]));
  });

  it("extracts a gzipped tar archive", async () => {
    const buf = await buildTarBuffer(
      { "my-skill/SKILL.md": "---\nname: my-skill\ndescription: x\n---\n" },
      { gzip: true },
    );
    // Confirm we actually built a gzip-prefixed buffer (magic bytes 1f 8b).
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);

    let extractedFiles: string[] = [];
    (parseSkillsDir as any).mockImplementation((dir: string) => {
      extractedFiles = fs.readdirSync(dir);
      return [];
    });

    await parseSkillPack(buf);

    // Single wrapper subdir (no meta.json at root) → parseSkillPack descends
    // into it, so the dir we observed lists SKILL.md directly.
    expect(extractedFiles).toContain("SKILL.md");
  });

  it("rejects buffers that are neither zip nor tar", async () => {
    const buf = Buffer.from("not a real archive, just plain text bytes");
    await expect(parseSkillPack(buf)).rejects.toThrow(/Unsupported archive format/);
    expect(parseSkillsDir).not.toHaveBeenCalled();
  });

  it("rejects gzip buffers that are not actually tar inside", async () => {
    const buf = zlib.gzipSync(Buffer.from("just plain text wrapped in gzip"));
    await expect(parseSkillPack(buf)).rejects.toThrow();
    expect(parseSkillsDir).not.toHaveBeenCalled();
  });
});
