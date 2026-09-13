import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface PiSnapshot {
  format: "siclaw-pi-session-v1";
  sessionId: string;
  header: NonNullable<ReturnType<SessionManager["getHeader"]>>;
  entries: ReturnType<SessionManager["getEntries"]>;
  activeLeafId: string | null;
}

/** Capture synchronously: entries are shallow copies and the leaf can be memory-only. */
export function capturePiSession(sessionId: string, manager: SessionManager): PiSnapshot {
  const header = manager.getHeader();
  if (!header) throw new Error("Cannot checkpoint a Pi session without a header");
  return validatePiSnapshot(JSON.parse(JSON.stringify({
    format: "siclaw-pi-session-v1", sessionId, header,
    entries: manager.getEntries(), activeLeafId: manager.getLeafId(),
  })), sessionId);
}

export function validatePiSnapshot(value: unknown, sessionId: string): PiSnapshot {
  const v = value as PiSnapshot;
  if (!v || v.format !== "siclaw-pi-session-v1" || v.sessionId !== sessionId ||
      v.header?.type !== "session" || v.header.version !== 3 || typeof v.header.id !== "string" ||
      !Array.isArray(v.entries) || !(v.activeLeafId === null || typeof v.activeLeafId === "string")) {
    throw new Error("Invalid Pi session snapshot");
  }
  const types = new Set(["message", "thinking_level_change", "model_change", "compaction", "branch_summary", "custom", "label", "session_info", "custom_message"]);
  const seen = new Set<string>();
  for (const entry of v.entries) {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id) ||
        !types.has(entry.type) || !entry.id || (entry.parentId !== null && !seen.has(entry.parentId))) {
      throw new Error("Invalid or incomplete Pi entry tree");
    }
    if (entry.type === "message" && (!entry.message || typeof entry.message.role !== "string")) throw new Error("Invalid Pi message");
    if (entry.type === "compaction" && (typeof entry.summary !== "string" || (entry.firstKeptEntryId && !seen.has(entry.firstKeptEntryId)))) throw new Error("Invalid Pi compaction reference");
    if (entry.type === "branch_summary" && (typeof entry.summary !== "string" || !seen.has(entry.fromId))) throw new Error("Invalid Pi branch reference");
    seen.add(entry.id);
  }
  if (v.activeLeafId !== null && !seen.has(v.activeLeafId)) throw new Error("Pi active leaf is missing");
  return v;
}

/** Never select by mtime/cwd; the manifest names the exact tree and selected leaf. */
export function restorePiSession(snapshot: PiSnapshot, directory: string, cwd: string): SessionManager {
  validatePiSnapshot(snapshot, snapshot.sessionId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "checkpoint.jsonl");
  // cwd and parentSession are historical metadata, not host-path capabilities.
  const header = { ...snapshot.header, cwd, parentSession: undefined };
  fs.writeFileSync(file, [header, ...snapshot.entries].map(v => JSON.stringify(v)).join("\n") + "\n", { mode: 0o600 });
  const manager = SessionManager.open(file, directory, cwd);
  if (snapshot.activeLeafId === null) manager.resetLeaf(); else manager.branch(snapshot.activeLeafId);
  return manager;
}
