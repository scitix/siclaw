import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_UNPACKED_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 1000;

export interface KnowledgePackageInfo {
  sha256: string;
  fileCount: number;
  totalUnpackedBytes: number;
  manifestJson?: unknown;
}

interface TarEntry {
  name: string;
  type: string;
  size: number;
  dataOffset: number;
}

export function validateKnowledgePackage(buf: Buffer): KnowledgePackageInfo {
  if (buf.length === 0) throw new Error("Knowledge package is empty");
  if (buf.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Knowledge package is too large: ${buf.length} bytes`);
  }

  let tar: Buffer;
  try {
    tar = gunzipSync(buf);
  } catch {
    throw new Error("Knowledge package must be a valid tar.gz archive");
  }

  const entries = parseTarEntries(tar);
  let fileCount = 0;
  let totalUnpackedBytes = 0;
  let hasIndex = false;
  let manifestJson: unknown;

  for (const entry of entries) {
    const name = normalizePackagePath(entry.name);
    if (!name) continue;

    if (entry.type === "5") continue;
    if (entry.type !== "0" && entry.type !== "") {
      throw new Error(`Unsupported tar entry type for ${name}`);
    }

    const ext = path.posix.extname(name).toLowerCase();
    if (ext !== ".md" && ext !== ".json") {
      throw new Error(`Unsupported knowledge file type: ${name}`);
    }
    if (entry.size > MAX_FILE_BYTES) {
      throw new Error(`Knowledge file is too large: ${name}`);
    }

    fileCount++;
    totalUnpackedBytes += entry.size;
    if (fileCount > MAX_FILES) throw new Error(`Knowledge package has too many files`);
    if (totalUnpackedBytes > MAX_TOTAL_UNPACKED_BYTES) {
      throw new Error(`Knowledge package unpacked size is too large`);
    }
    if (name === "index.md") hasIndex = true;
    if (name === "manifest.json") {
      const content = readTarFileContent(tar, entry);
      try {
        manifestJson = JSON.parse(content.toString("utf8"));
      } catch {
        throw new Error("manifest.json is not valid JSON");
      }
    }
  }

  if (!hasIndex) throw new Error("Knowledge package must contain index.md at archive root");
  if (fileCount === 0) throw new Error("Knowledge package has no files");

  return {
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    fileCount,
    totalUnpackedBytes,
    manifestJson,
  };
}

export async function extractKnowledgePackageToDir(buf: Buffer, targetDir: string): Promise<KnowledgePackageInfo> {
  const info = validateKnowledgePackage(buf);
  await fs.mkdir(targetDir, { recursive: true });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-knowledge-"));
  const archivePath = path.join(tmpDir, "knowledge.tar.gz");
  try {
    await fs.writeFile(archivePath, buf, { mode: 0o600 });
    await execFileAsync("tar", ["-xzf", archivePath, "-C", targetDir]);
    return info;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function sanitizeKnowledgeRepoDir(name: string): string {
  const sanitized = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.slice(0, 80) || "repo";
}

export async function replaceDirectoryContentsFromStaging(targetDir: string, stagingDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const stagingBase = path.basename(stagingDir);

  for (const entry of await fs.readdir(targetDir)) {
    if (entry === stagingBase) continue;
    await fs.rm(path.join(targetDir, entry), { recursive: true, force: true });
  }

  for (const entry of await fs.readdir(stagingDir)) {
    await fs.rename(path.join(stagingDir, entry), path.join(targetDir, entry));
  }
  await fs.rm(stagingDir, { recursive: true, force: true });
}

function parseTarEntries(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;

  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(header)) break;

    const rawName = readNullTerminated(header, 0, 100);
    const prefix = readNullTerminated(header, 345, 155);
    const type = readNullTerminated(header, 156, 1);
    const size = readOctal(header, 124, 12);
    const headerName = prefix ? `${prefix}/${rawName}` : rawName;

    const dataOffset = offset + BLOCK_SIZE;
    const nextOffset = dataOffset + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (nextOffset > tar.length) throw new Error("Knowledge package tar is truncated");

    if (type === "L") {
      // GNU long name extension: next entry uses this name.
      pendingLongName = tar.subarray(dataOffset, dataOffset + size).toString("utf8").replace(/\0.*$/s, "");
    } else if (type === "x" || type === "g") {
      const pax = parsePaxRecords(tar.subarray(dataOffset, dataOffset + size));
      if (pax.linkpath) {
        throw new Error("PAX linkpath entries are not allowed in knowledge packages");
      }
      if (type === "g" && pax.path) {
        throw new Error("Global PAX path entries are not allowed in knowledge packages");
      }
      if (type === "x" && pax.path) {
        pendingPaxPath = pax.path;
      }
    } else {
      const name = pendingPaxPath ?? pendingLongName ?? headerName;
      pendingPaxPath = null;
      pendingLongName = null;
      entries.push({ name, type, size, dataOffset });
    }

    offset = nextOffset;
  }

  return entries;
}

function readTarFileContent(tar: Buffer, target: TarEntry): Buffer {
  return tar.subarray(target.dataOffset, target.dataOffset + target.size);
}

function parsePaxRecords(payload: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;

  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space < 0) break;

    const lenRaw = payload.subarray(offset, space).toString("ascii");
    const recordLength = Number.parseInt(lenRaw, 10);
    if (!Number.isFinite(recordLength) || recordLength <= 0 || offset + recordLength > payload.length) {
      throw new Error("Invalid PAX header in knowledge package");
    }

    const record = payload.subarray(space + 1, offset + recordLength).toString("utf8").replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0) {
      records[record.slice(0, eq)] = record.slice(eq + 1);
    }
    offset += recordLength;
  }

  return records;
}

function normalizePackagePath(input: string): string {
  if (!input || input.includes("\0") || input.includes("\\")) {
    throw new Error(`Invalid knowledge package path: ${input}`);
  }
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input)) {
    throw new Error(`Absolute paths are not allowed in knowledge package: ${input}`);
  }

  const normalized = path.posix.normalize(input.replace(/^\.\//, ""));
  if (normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Path traversal is not allowed in knowledge package: ${input}`);
  }
  return normalized;
}

function readNullTerminated(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul >= 0 ? nul : slice.length).toString("utf8");
}

function readOctal(buf: Buffer, start: number, len: number): number {
  const raw = readNullTerminated(buf, start, len).trim();
  if (!raw) return 0;
  const parsed = parseInt(raw, 8);
  if (!Number.isFinite(parsed)) throw new Error("Invalid tar size field");
  return parsed;
}

function isZeroBlock(buf: Buffer): boolean {
  for (const byte of buf) {
    if (byte !== 0) return false;
  }
  return true;
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve();
      }
    });
  });
}

export function directoryExists(p: string): boolean {
  return fsSync.existsSync(p) && fsSync.statSync(p).isDirectory();
}
