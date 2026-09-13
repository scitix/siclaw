import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { exportUnknownArchive, type UnknownArchiveMapping } from "./unknown-workspace-archive.js";
import { exportLegacyWorkspace, type LegacyWorkspaceMapping } from "./workspace-migration.js";

it("preserves unowned bytes and attribution without producing an executable workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unknown-archive-"));
  try {
    const source = path.join(root, "source"); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "old.jsonl"), "malformed legacy JSONL stays evidence\n");
    const mapping: UnknownArchiveMapping = {
      organization: "org", sourceId: "root", runtimeId: "runtime", sourceRoot: source,
      sourceFrozen: true, archiveApproved: true,
      sessions: [{ sessionId: "root", originalPrincipalId: "alice", unowned: false },
        { sessionId: "child", parentSessionId: "root", originalPrincipalId: "unknown", unowned: true }],
      files: [{ source: "old.jsonl", destination: "archive/child/original.jsonl" }],
    };
    const output = path.join(root, "export"), report = exportUnknownArchive(mapping, output);
    expect(report.sessions).toEqual(mapping.sessions);
    expect(fs.readFileSync(path.join(output, report.files[0].path), "utf8")).toBe(fs.readFileSync(path.join(source, "old.jsonl"), "utf8"));
    expect(fs.readdirSync(output).sort()).toEqual(["archive", "archive.json"]);
    expect(() => exportLegacyWorkspace(report as unknown as LegacyWorkspaceMapping)).toThrow();
    expect(() => exportUnknownArchive({ ...mapping, sourceFrozen: false })).toThrow(/frozen/);
    expect(() => exportUnknownArchive({ ...mapping, archiveApproved: false })).toThrow(/approved/);
    expect(() => exportUnknownArchive({ ...mapping, files: [{ source: "old.jsonl", destination: "sessions/child/.pi-session.json" }] })).toThrow(/destination/);
    fs.symlinkSync("old.jsonl", path.join(source, "alias"));
    expect(() => exportUnknownArchive({ ...mapping, files: [{ source: "alias", destination: "archive/child/original.jsonl" }] })).toThrow(/symlinks/);
    expect(() => exportUnknownArchive(mapping, path.join(source, "export"))).toThrow(/outside/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
