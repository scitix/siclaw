import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { capturePiSession } from "./pi-session-snapshot.js";
import { safeWorkspacePath } from "./private-workspace.js";
import { exportInvestigationRows } from "./private-memory-snapshot.js";
import { validPrivateId } from "../shared/private-workspace.js";

export interface LegacySessionMapping {
  sessionId: string;
  piFile: string;
  activeLeafId?: string | null;
  sidecars?: Array<{ source: string; name: string }>;
}
export interface LegacyWorkspaceMapping extends LegacySessionMapping {
  organization: string;
  principalId: string;
  runtimeId: string;
  ownershipVerified: boolean;
  sourceFrozen: boolean;
  sourceRoot: string;
  children?: Array<LegacySessionMapping & { parentSessionId: string }>;
  // Explicitly attributed data only. Agent-shared memory has no default owner.
  files?: Array<{ source: string; destination: string }>;
  memoryDatabase?: string;
}
export interface WorkspaceImport {
  format: "siclaw-workspace-import-v1";
  organization: string;
  principalId: string;
  sessionId: string;
  runtimeId: string;
  activeLeafKnown: boolean;
  sessions: Array<{ sessionId: string; parentSessionId?: string; activeLeafKnown: boolean }>;
  files: Array<{ path: string; size: number; sha256: string }>;
}
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function readSource(mapping: LegacyWorkspaceMapping, relative: string): Buffer {
  safeWorkspacePath(relative);
  const root = fs.realpathSync(mapping.sourceRoot), file = path.join(root, relative);
  if (fs.realpathSync(file) !== file) throw new Error("Migration sources must not contain symlinks");
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size > 256 * 1024 * 1024) throw new Error("Invalid migration source");
  const data = fs.readFileSync(file), after = fs.lstatSync(file);
  if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || data.length !== before.size) throw new Error("Migration source changed during export");
  return data;
}

/** Produces an offline, hashed package. Dry run reads sources but writes nothing. */
export function exportLegacyWorkspace(mapping: LegacyWorkspaceMapping, output?: string): WorkspaceImport {
  if (![mapping.sessionId, mapping.principalId, mapping.organization, mapping.runtimeId].every(validPrivateId) ||
      mapping.ownershipVerified !== true || mapping.sourceFrozen !== true) throw new Error("A frozen source and independently verified owner mapping are required");
  const sessions: Array<LegacySessionMapping & { parentSessionId?: string }> = [mapping, ...(mapping.children ?? [])];
  const byId = new Map(sessions.map(s => [s.sessionId, s]));
  if (byId.size !== sessions.length || sessions.length > 512 || sessions.some(s => !validPrivateId(s.sessionId))) throw new Error("Invalid migration session identities");
  for (const child of mapping.children ?? []) {
    const seen = new Set([child.sessionId]);
    let parent = child.parentSessionId;
    while (parent !== mapping.sessionId) {
      if (!parent || seen.has(parent) || !byId.has(parent)) throw new Error("Migration child must belong to the root session tree");
      seen.add(parent); parent = byId.get(parent)!.parentSessionId!;
    }
  }
  const ledgers = sessions.map(session => {
    const raw = readSource(mapping, session.piFile);
    const entries = new TextDecoder("utf-8", { fatal: true }).decode(raw).split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
    if (entries[0]?.type !== "session" || ![1, 2, 3].includes(entries[0]?.version ?? 1) || entries.slice(1).some(entry => !entry || typeof entry.type !== "string" || entry.type === "session")) throw new Error("Invalid legacy Pi ledger");
    return { session, raw, entries };
  });
  const files = new Map<string, Buffer>();
  for (const { session, raw } of ledgers) {
    files.set(`archive/${session.sessionId}/original.jsonl`, raw);
    for (const sidecar of session.sidecars ?? []) {
      const name = safeWorkspacePath(sidecar.name);
      if (![".plan-ledger.json", ".model-route-state.json", ".turn-ledger.json"].includes(name) && !name.startsWith(".tool-results/")) throw new Error("Unsupported migration session sidecar");
      const dest = `sessions/${session.sessionId}/${name}`;
      if (files.has(dest)) throw new Error("Duplicate migration session sidecar");
      const data = readSource(mapping, sidecar.source);
      if (name.endsWith(".json")) JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
      files.set(dest, data);
    }
  }
  for (const file of mapping.files ?? []) {
    const dest = safeWorkspacePath(file.destination);
    if (!/^(files|reports|traces|archive|tasks)\//.test(dest) || files.has(dest)) throw new Error("Invalid or duplicate migration destination");
    files.set(dest, readSource(mapping, file.source));
  }
  // Pi performs legacy-version migration only on a disposable local copy.
  // Even dry run avoids invoking the SDK, which may rewrite a v1/v2 JSONL.
  let scratch: string | undefined;
  if (output) {
    const resolved = path.join(fs.realpathSync(path.dirname(path.resolve(output))), path.basename(output)), source = fs.realpathSync(mapping.sourceRoot);
    if (resolved === source || resolved.startsWith(source + path.sep) || fs.existsSync(resolved)) throw new Error("Export needs a new output directory outside the legacy source");
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-export-"));
    try {
      for (const { session, raw, entries } of ledgers) {
        const sessionScratch = path.join(scratch, session.sessionId); fs.mkdirSync(sessionScratch);
        const copy = path.join(sessionScratch, "legacy.jsonl"); fs.writeFileSync(copy, raw, { mode: 0o600 });
        const manager = SessionManager.open(copy, sessionScratch);
        if (manager.getEntries().length !== entries.length - 1) throw new Error("Pi conversion dropped entries; export was refused");
        if (session.activeLeafId === null) manager.resetLeaf();
        else if (session.activeLeafId !== undefined) {
          if (!manager.getEntries().some(e => e.id === session.activeLeafId)) throw new Error("Mapped active leaf is missing");
          manager.branch(session.activeLeafId);
        }
        files.set(`sessions/${session.sessionId}/.pi-session.json`, Buffer.from(JSON.stringify(capturePiSession(session.sessionId, manager))));
      }
      if (sessions.some(s => s.activeLeafId === undefined)) files.set(`sessions/${mapping.sessionId}/.pending-turn.json`, Buffer.from(JSON.stringify({ state: "execution_uncertain", reason: "A legacy session did not record its in-memory active leaf. Review the complete session tree before continuing.", sessions: sessions.filter(s => s.activeLeafId === undefined).map(s => s.sessionId) })));
      if (mapping.memoryDatabase) {
        for (const suffix of ["", "-wal", "-shm"]) {
          const name = mapping.memoryDatabase + suffix;
          if (suffix && !fs.existsSync(path.join(mapping.sourceRoot, name))) continue;
          const data = readSource(mapping, name);
          files.set(`archive/${mapping.sessionId}/memory.db${suffix}`, data);
          fs.writeFileSync(path.join(scratch, ".memory.db" + suffix), data, { mode: 0o600 });
        }
        exportInvestigationRows(scratch);
        files.set("memory/.investigations.json", fs.readFileSync(path.join(scratch, ".investigations.json")));
      }
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
  const manifest: WorkspaceImport = {
    format: "siclaw-workspace-import-v1", organization: mapping.organization, principalId: mapping.principalId,
    sessionId: mapping.sessionId, runtimeId: mapping.runtimeId, activeLeafKnown: sessions.every(s => s.activeLeafId !== undefined),
    sessions: sessions.map(s => ({ sessionId: s.sessionId, ...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}), activeLeafKnown: s.activeLeafId !== undefined })),
    files: [...files].map(([name, data]) => ({ path: name, size: data.length, sha256: digest(data) })),
  };
  if (manifest.files.reduce((sum, file) => sum + file.size, 0) > 256 * 1024 * 1024 || manifest.files.length > 4096) throw new Error("Migration package exceeds workspace limits");
  if (output) {
    fs.mkdirSync(output, { mode: 0o700 });
    for (const [name, data] of files) {
      const dest = path.join(output, name); fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, data, { mode: 0o600, flag: "wx" });
    }
    fs.writeFileSync(path.join(output, "import.json"), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
  }
  return manifest;
}
