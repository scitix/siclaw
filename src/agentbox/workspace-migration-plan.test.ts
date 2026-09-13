import { expect, it } from "vitest";
import { planLegacyWorkspaces, type LegacyMigrationCatalog, type LegacyInventoryEntry } from "./workspace-migration-plan.js";

const catalog: LegacyMigrationCatalog = {
  sourceRoot: "/legacy", sessionsDirectory: "agent/sessions", runtimeId: "runtime", ownershipVerified: true,
  sessions: [
    { sessionId: "root", organization: "org", principalId: "alice" },
    { sessionId: "child", parentSessionId: "root", organization: "org", principalId: "alice" },
    { sessionId: "other", organization: "org", principalId: "bob" },
    { sessionId: "missing", organization: "org", principalId: "alice" },
  ],
};
const inventory: LegacyInventoryEntry[] = [
  "agent/sessions/root/old.jsonl", "agent/sessions/child/old.jsonl", "agent/sessions/other/old.jsonl",
  "agent/sessions/child/.tool-results/result.txt", "agent/sessions/root/.turn-ledger.json", "agent/sessions/missing.handoff",
  "agent/auth.json", "skill-drafts/run.sh", "knowledge-index/memory.db",
].map(path => ({ path, type: "file", size: 10 }));

it("groups complete attributed trees without freezing live sources or importing shared authority", () => {
  const plan = planLegacyWorkspaces(catalog, inventory);
  expect(plan.summary).toEqual({ roots: 2, sessions: 3, files: 5, bytes: 50 });
  expect(plan.catalogSessionsWithoutTranscript).toEqual(["missing"]);
  expect(plan.excludedFiles).toEqual(["agent/auth.json", "agent/sessions/missing.handoff", "knowledge-index/memory.db", "skill-drafts/run.sh"]);
  expect(plan.invalidatedCaches).toEqual([{ sessionId: "missing", source: "agent/sessions/missing.handoff" }]);
  const root = plan.mappings.find(m => m.sessionId === "root")!;
  expect(root.children).toHaveLength(1);
  expect(root.children![0].parentSessionId).toBe("root");
  expect(root.children![0].activeLeafId).toBeUndefined();
  expect(root.files).toEqual([]);
  expect(plan.mappings.every(m => m.sourceFrozen === false)).toBe(true);
});

it("refuses ownership guesses, ambiguous transcripts, missing parents and cycles", () => {
  const changed = (update: (c: LegacyMigrationCatalog) => void) => {
    const c = structuredClone(catalog); update(c); return () => planLegacyWorkspaces(c, inventory);
  };
  expect(changed(c => { c.ownershipVerified = false; })).toThrow(/verified host/);
  expect(changed(c => { c.sessions[1].principalId = "bob"; })).toThrow(/Cross-owner/);
  expect(changed(c => { c.sessions[1].parentSessionId = "missing"; })).toThrow(/Missing parent/);
  expect(changed(c => { c.sessions[0].parentSessionId = "child"; })).toThrow(/cycle/);
  expect(changed(c => { c.sessions = c.sessions.filter(s => s.sessionId !== "child"); })).toThrow(/no verified owner/);
  expect(() => planLegacyWorkspaces(catalog, [...inventory, { path: "agent/sessions/root/another.jsonl", type: "file", size: 1 }])).toThrow(/Multiple transcripts/);
  expect(() => planLegacyWorkspaces(catalog, [...inventory, inventory[0]])).toThrow(/Invalid inventory/);
  expect(() => planLegacyWorkspaces(catalog, [...inventory, { path: "agent/sessions/root.handoff", type: "file", size: 1 }])).toThrow(/Invalidated cache/);
});

it("archives the complete affected tree only on an explicit host decision", () => {
  const c = structuredClone(catalog);
  c.sessions[1].principalId = "unknown";
  c.unownedSessionIds = ["child"];
  expect(() => planLegacyWorkspaces(c, inventory)).toThrow(/explicit archive/);
  c.unknownDisposition = "archive";
  const plan = planLegacyWorkspaces(c, inventory);
  expect(plan.mappings.map(m => m.sessionId)).toEqual(["other"]);
  expect(plan.unknownArchives).toHaveLength(1);
  const archive = plan.unknownArchives[0];
  expect(archive.sourceFrozen).toBe(false);
  expect(archive.sessions).toEqual([
    { sessionId: "child", parentSessionId: "root", originalPrincipalId: "unknown", unowned: true },
    { sessionId: "root", parentSessionId: undefined, originalPrincipalId: "alice", unowned: false },
  ]);
  expect(archive.files).toHaveLength(4);
  expect(archive.files.every(f => f.destination.startsWith("archive/"))).toBe(true);
  expect(plan.summary.files).toBe(5);
  c.sessions[1].principalId = "";
  expect(planLegacyWorkspaces(c, inventory).unknownArchives[0].sessions[0].originalPrincipalId).toBe("");
  c.sessions[1].organization = "foreign-org";
  expect(() => planLegacyWorkspaces(c, inventory)).toThrow(/Cross-organization/);
});
