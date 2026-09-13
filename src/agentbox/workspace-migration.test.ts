import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportLegacyWorkspace, type LegacyWorkspaceMapping } from "./workspace-migration.js";
import { capturePiSession } from "./pi-session-snapshot.js";
import { initMemoryDb } from "../memory/schema.js";
import { exportInvestigationRows, restoreInvestigationRows } from "./private-memory-snapshot.js";
const dirs: string[] = [];
function dir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-migration-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
it("exports a complete branch tree without modifying legacy files and marks unknown leaves", () => {
  const root = dir(), sm = SessionManager.create(root, root);
  sm.appendMessage({ role: "user", content: "retained", timestamp: 1 });
  const snap = capturePiSession("session", sm);
  const original = [snap.header, ...snap.entries].map(v => JSON.stringify(v)).join("\n") + "\n";
  fs.writeFileSync(path.join(root, "old.jsonl"), original);
  const mapping: LegacyWorkspaceMapping = { organization: "org", principalId: "user", sessionId: "session", runtimeId: "runtime", ownershipVerified: true, sourceFrozen: true, sourceRoot: root, piFile: "old.jsonl" };
  const before = fs.readdirSync(root);
  expect(exportLegacyWorkspace(mapping).activeLeafKnown).toBe(false);
  expect(fs.readdirSync(root)).toEqual(before);
  const output = path.join(dir(), "export");
  const report = exportLegacyWorkspace(mapping, output);
  expect(report.files.some(f => f.path === "sessions/session/.pending-turn.json")).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(output, "sessions/session/.pi-session.json"), "utf8")).entries).toEqual(snap.entries);
  expect(fs.readFileSync(path.join(root, "old.jsonl"), "utf8")).toBe(original);
  expect(() => exportLegacyWorkspace({ ...mapping, ownershipVerified: false })).toThrow(/verified owner/);
  fs.symlinkSync("old.jsonl", path.join(root, "alias"));
  expect(() => exportLegacyWorkspace({ ...mapping, piFile: "alias" })).toThrow(/symlinks/);
});
it("preserves investigation and feedback rows independently of SQLite indexes", () => {
  const root = dir(), db = initMemoryDb(path.join(root, ".memory.db"));
  db.prepare("INSERT INTO investigations(id,question,created_at,feedback_signal,feedback_note) VALUES (?,?,?,?,?)").run("case", "why?", 1, 0.2, "disproved");
  exportInvestigationRows(root); db.close();
  const restored = dir(); fs.copyFileSync(path.join(root, ".investigations.json"), path.join(restored, ".investigations.json"));
  restoreInvestigationRows(restored);
  const read = initMemoryDb(path.join(restored, ".memory.db"));
  try { expect(read.prepare("SELECT feedback_signal, feedback_note FROM investigations WHERE id='case'").get()).toMatchObject({ feedback_signal: 0.2, feedback_note: "disproved" }); }
  finally { read.close(); }
});

it("migrates child trees, sidecars and task output while blocking unknown child branches", () => {
  const root = dir(), sm = SessionManager.create(root, root);
  sm.appendMessage({ role: "user", content: "retained", timestamp: 1 });
  const snap = capturePiSession("session", sm);
  const original = [snap.header, ...snap.entries].map(v => JSON.stringify(v)).join("\n") + "\n";
  fs.writeFileSync(path.join(root, "root.jsonl"), original);
  fs.writeFileSync(path.join(root, "child.jsonl"), original);
  fs.writeFileSync(path.join(root, "route.json"), '{"model":"kept"}');
  fs.writeFileSync(path.join(root, "result.txt"), "child result");
  const mapping: LegacyWorkspaceMapping = {
    organization: "org", principalId: "user", sessionId: "session", runtimeId: "runtime",
    ownershipVerified: true, sourceFrozen: true, sourceRoot: root, piFile: "root.jsonl", activeLeafId: snap.activeLeafId,
    children: [{ sessionId: "child", parentSessionId: "session", piFile: "child.jsonl", sidecars: [{ source: "route.json", name: ".model-route-state.json" }, { source: "result.txt", name: ".tool-results/result.txt" }] }],
    files: [{ source: "result.txt", destination: "tasks/result.txt" }],
  };
  const output = path.join(dir(), "export"), report = exportLegacyWorkspace(mapping, output);
  expect(report.activeLeafKnown).toBe(false);
  expect(report.sessions).toEqual([{ sessionId: "session", activeLeafKnown: true }, { sessionId: "child", parentSessionId: "session", activeLeafKnown: false }]);
  expect(JSON.parse(fs.readFileSync(path.join(output, "sessions/child/.pi-session.json"), "utf8")).entries).toEqual(snap.entries);
  expect(JSON.parse(fs.readFileSync(path.join(output, "sessions/session/.pending-turn.json"), "utf8")).sessions).toEqual(["child"]);
  expect(fs.readFileSync(path.join(output, "sessions/child/.model-route-state.json"), "utf8")).toBe('{"model":"kept"}');
  expect(fs.readFileSync(path.join(output, "tasks/result.txt"), "utf8")).toBe("child result");
  expect(fs.readFileSync(path.join(root, "child.jsonl"), "utf8")).toBe(original);
  expect(() => exportLegacyWorkspace({ ...mapping, children: [{ ...mapping.children![0], parentSessionId: "foreign" }] })).toThrow(/root session tree/);
  expect(() => exportLegacyWorkspace({ ...mapping, children: [{ ...mapping.children![0], parentSessionId: "child" }] })).toThrow(/root session tree/);
  expect(() => exportLegacyWorkspace({ ...mapping, sidecars: [{ source: "route.json", name: "auth.json" }] })).toThrow(/Unsupported/);
});
