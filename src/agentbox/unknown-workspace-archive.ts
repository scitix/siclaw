import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { safeWorkspacePath } from "./private-workspace.js";
import { validPrivateId } from "../shared/private-workspace.js";

export interface UnknownArchiveSession {
  sessionId: string;
  parentSessionId?: string;
  originalPrincipalId: string;
  unowned: boolean;
}
export interface UnknownArchiveMapping {
  organization: string;
  sourceId: string;
  runtimeId: string;
  sourceRoot: string;
  sourceFrozen: boolean;
  archiveApproved: boolean;
  sessions: UnknownArchiveSession[];
  files: Array<{ source: string; destination: string }>;
}
export interface UnknownArchivePackage {
  format: "siclaw-unknown-archive-v1";
  organization: string;
  sourceId: string;
  runtimeId: string;
  sessions: UnknownArchiveSession[];
  files: Array<{ path: string; size: number; sha256: string }>;
}

/** Inert operator archive: never converts Pi, extracts memory or creates a user. */
export function exportUnknownArchive(mapping: UnknownArchiveMapping, output?: string): UnknownArchivePackage {
  if (![mapping.organization, mapping.sourceId, mapping.runtimeId].every(validPrivateId) ||
      mapping.archiveApproved !== true || mapping.sourceFrozen !== true) throw new Error("An approved archive and frozen source are required");
  const ids = new Set(mapping.sessions.map(s => s.sessionId));
  if (ids.size !== mapping.sessions.length || ids.size === 0 || ids.size > 512 ||
      !mapping.sessions.some(s => s.unowned === true) ||
      mapping.sessions.some(s => !validPrivateId(s.sessionId) || typeof s.originalPrincipalId !== "string" || s.originalPrincipalId.length > 128 ||
        typeof s.unowned !== "boolean" || (s.parentSessionId && !ids.has(s.parentSessionId)))) throw new Error("Invalid archive attribution metadata");
  const root = fs.realpathSync(mapping.sourceRoot);
  if (output) {
    const resolved = path.join(fs.realpathSync(path.dirname(path.resolve(output))), path.basename(output));
    if (resolved === root || resolved.startsWith(root + path.sep) || fs.existsSync(resolved)) throw new Error("Archive needs a new output directory outside the source");
  }
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const entry of mapping.files) {
    const name = safeWorkspacePath(entry.destination), parts = name.split("/");
    if (parts[0] !== "archive" || parts.length < 3 || !ids.has(parts[1]) || files.has(name) ||
        [...files.keys()].some(old => old.startsWith(name + "/") || name.startsWith(old + "/"))) throw new Error("Invalid archive destination");
    safeWorkspacePath(entry.source);
    const source = path.join(root, entry.source);
    if (fs.realpathSync(source) !== source) throw new Error("Archive sources must not contain symlinks");
    const before = fs.lstatSync(source);
    if (!before.isFile() || before.nlink !== 1 || before.size > 256 * 1024 * 1024) throw new Error("Invalid archive source");
    total += before.size;
    if (total > 256 * 1024 * 1024 || files.size >= 4096) throw new Error("Archive exceeds package limits");
    const body = fs.readFileSync(source), after = fs.lstatSync(source);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || body.length !== before.size) throw new Error("Archive source changed during export");
    files.set(name, body);
  }
  if (!files.size) throw new Error("Archive must contain source files");
  const manifest: UnknownArchivePackage = {
    format: "siclaw-unknown-archive-v1", organization: mapping.organization, sourceId: mapping.sourceId,
    runtimeId: mapping.runtimeId, sessions: mapping.sessions,
    files: [...files].map(([name, body]) => ({ path: name, size: body.length, sha256: createHash("sha256").update(body).digest("hex") })),
  };
  if (output) {
    fs.mkdirSync(output, { mode: 0o700 });
    for (const [name, body] of files) {
      const dest = path.join(output, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, body, { mode: 0o600, flag: "wx" });
    }
    fs.writeFileSync(path.join(output, "archive.json"), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
  }
  return manifest;
}
