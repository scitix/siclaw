/**
 * Session checkpoint pack/extract — tar.gz of an AgentBox session directory.
 *
 * Contract: docs/design/2026-06-10-session-checkpoint-db.md §4.
 *
 * Packing is deterministic (`portable` + `noMtime`): identical directory
 * content yields identical bytes, so callers can dedup uploads by sha256.
 * Extraction follows the same tar-slip defense as `portal/skill-import.ts`:
 * node-tar already strips absolute paths and refuses `..`, and the explicit
 * filter is defense-in-depth against a future dep swap or option drift.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

/**
 * Hard cap on the compressed archive. An over-cap session is not an error the
 * user can act on mid-turn — callers log and skip checkpointing (that one
 * session degrades to fresh-on-restart; see design §4).
 */
export const MAX_CHECKPOINT_COMPRESSED_BYTES = 64 * 1024 * 1024;
/** Decompression bomb guard for extraction. */
const MAX_TOTAL_UNPACKED_BYTES = 512 * 1024 * 1024;

export interface PackedCheckpoint {
  /** Compressed tar.gz bytes. */
  data: Buffer;
  /** sha256 hex of `data` (the compressed bytes — what the server stores/verifies). */
  sha256: string;
  sizeBytes: number;
  fileCount: number;
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Pack a session directory into a deterministic tar.gz.
 * Returns null when there is nothing to checkpoint (missing or empty dir).
 * Throws when the archive exceeds MAX_CHECKPOINT_COMPRESSED_BYTES.
 */
export async function packSessionDir(sessionDir: string): Promise<PackedCheckpoint | null> {
  if (!fs.existsSync(sessionDir)) return null;
  const topEntries = await fsp.readdir(sessionDir);
  if (topEntries.length === 0) return null;

  const allEntries = await fsp.readdir(sessionDir, { recursive: true, withFileTypes: true });
  const fileCount = allEntries.filter((e) => e.isFile()).length;
  if (fileCount === 0) return null;

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "siclaw-checkpoint-"));
  const archivePath = path.join(tmpDir, "session.tar.gz");
  try {
    await tar.create(
      // portable omits uid/gid/system metadata and zeroes the gzip mtime;
      // noMtime drops per-entry mtimes — together: same content, same bytes.
      { gzip: true, cwd: sessionDir, portable: true, noMtime: true, file: archivePath },
      topEntries.sort(),
    );
    const data = await fsp.readFile(archivePath);
    if (data.length > MAX_CHECKPOINT_COMPRESSED_BYTES) {
      throw new Error(
        `Session checkpoint exceeds ${MAX_CHECKPOINT_COMPRESSED_BYTES} bytes: ${data.length} (${sessionDir})`,
      );
    }
    return { data, sha256: sha256Hex(data), sizeBytes: data.length, fileCount };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Extract a checkpoint archive into the session directory.
 * Validates gzip magic, size caps, and entry paths before/while unpacking.
 */
export async function extractSessionCheckpoint(buf: Buffer, targetDir: string): Promise<void> {
  if (buf.length === 0) throw new Error("Session checkpoint is empty");
  if (buf.length > MAX_CHECKPOINT_COMPRESSED_BYTES) {
    throw new Error(`Session checkpoint is too large: ${buf.length} bytes`);
  }
  if (!(buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
    throw new Error("Session checkpoint must be a gzip archive");
  }

  await fsp.mkdir(targetDir, { recursive: true });

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "siclaw-checkpoint-"));
  const archivePath = path.join(tmpDir, "session.tar.gz");
  try {
    await fsp.writeFile(archivePath, buf, { mode: 0o600 });

    // Throwing inside `filter` gets swallowed by node-tar's internal callback
    // chain (see skill-import.ts) — mark, skip, and reject after completion.
    let unsafeEntry: string | null = null;
    let totalUnpacked = 0;
    await tar.extract({
      file: archivePath,
      cwd: targetDir,
      filter: (entryPath, entry) => {
        const normalized = entryPath.replace(/\\/g, "/");
        if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
          unsafeEntry ??= entryPath;
          return false;
        }
        totalUnpacked += entry.size ?? 0;
        if (totalUnpacked > MAX_TOTAL_UNPACKED_BYTES) {
          unsafeEntry ??= `${entryPath} (unpacked size cap exceeded)`;
          return false;
        }
        return true;
      },
    });
    if (unsafeEntry !== null) {
      throw new Error(`Unsafe entry in session checkpoint: ${unsafeEntry}`);
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** True when the directory contains no pi-agent JSONL — i.e. hydration is worth attempting. */
export function sessionDirNeedsHydration(sessionDir: string): boolean {
  if (!fs.existsSync(sessionDir)) return true;
  try {
    return !fs.readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"));
  } catch {
    return true;
  }
}
