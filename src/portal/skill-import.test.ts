import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

vi.mock("../gateway/skills/builtin-sync.js", () => ({
  parseSkillsDir: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import { parseSkillsDir } from "../gateway/skills/builtin-sync.js";
import type { ParsedSkill } from "../gateway/skills/builtin-sync.js";
import { computeImportDiff, executeImport } from "./skill-import.js";

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
    expect(diff.added).toEqual(["new-one", "new-two"]);
    expect(diff.updated).toEqual([]);
    expect(diff.deleted).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it("detects unchanged skills when specs + scripts match", async () => {
    const incoming = [mkSkill("alpha", { specs: "same", scripts: [{ name: "s.sh", content: "echo" }] })];
    const query = vi.fn().mockResolvedValueOnce([[
      { id: "s1", name: "alpha", specs: "same", scripts: JSON.stringify([{ name: "s.sh", content: "echo" }]) },
    ], []]);
    (getDb as any).mockReturnValue({ query });

    const diff = await computeImportDiff("org1", incoming);
    expect(diff.unchanged).toEqual(["alpha"]);
    expect(diff.updated).toEqual([]);
    expect(diff.added).toEqual([]);
  });

  it("detects updated skills when specs differ", async () => {
    const incoming = [mkSkill("alpha", { specs: "NEW" })];
    const query = vi.fn().mockResolvedValueOnce([[
      { id: "s1", name: "alpha", specs: "OLD", scripts: "[]" },
    ], []]);
    (getDb as any).mockReturnValue({ query });

    const diff = await computeImportDiff("org1", incoming);
    expect(diff.updated).toEqual(["alpha"]);
  });

  it("detects updated skills when scripts differ", async () => {
    const incoming = [mkSkill("alpha", { scripts: [{ name: "s.sh", content: "new" }] })];
    const query = vi.fn().mockResolvedValueOnce([[
      { id: "s1", name: "alpha", specs: "specs of alpha", scripts: JSON.stringify([{ name: "s.sh", content: "old" }]) },
    ], []]);
    (getDb as any).mockReturnValue({ query });

    const diff = await computeImportDiff("org1", incoming);
    expect(diff.updated).toEqual(["alpha"]);
  });

  it("treats DB scripts stored as object (not string) correctly", async () => {
    const incoming = [mkSkill("alpha", { scripts: [{ name: "s.sh", content: "x" }] })];
    const query = vi.fn().mockResolvedValueOnce([[
      { id: "s1", name: "alpha", specs: "specs of alpha", scripts: [{ name: "s.sh", content: "x" }] },
    ], []]);
    (getDb as any).mockReturnValue({ query });

    const diff = await computeImportDiff("org1", incoming);
    expect(diff.unchanged).toEqual(["alpha"]);
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

    await expect(executeImport("org1", [mkSkill("new")], "userA", "msg"))
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
      { id: "s-alpha", name: "alpha", specs: "OLD", scripts: "[]" },
      { id: "s-gone", name: "gone", specs: "x", scripts: "[]" },
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
    const result = await executeImport("org1", incoming, "userA", "rel", notify);

    expect(result.added).toEqual(["brand-new"]);
    expect(result.updated).toEqual(["alpha"]);
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].name).toBe("gone");
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
      { id: "s-gone", name: "gone", specs: "x", scripts: "[]" },
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

    const result = await executeImport("org1", [], "userA", "");

    expect(result.deleted).toHaveLength(1);
    expect(conn.commit).toHaveBeenCalled();

    // Verify overlay promotion path: NOT delete agent_skills before rebind
    const sqls = conn.query.mock.calls.map(c => c[0] as string);
    expect(sqls).toContain("UPDATE skills SET overlay_of = NULL WHERE overlay_of = ?");
    expect(sqls).not.toContain("DELETE FROM agent_skills WHERE skill_id = ?");
  });
});
