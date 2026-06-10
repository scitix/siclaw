import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  packSessionDir,
  extractSessionCheckpoint,
  sessionDirNeedsHydration,
  MAX_CHECKPOINT_COMPRESSED_BYTES,
} from "./session-checkpoint.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSessionFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "2026-06-10-abc.jsonl"), `{"type":"message"}\n{"type":"message"}\n`);
  fs.writeFileSync(path.join(dir, ".plan-ledger.json"), `{"tasks":[]}`);
  fs.mkdirSync(path.join(dir, "nested"));
  fs.writeFileSync(path.join(dir, "nested", "state.json"), `{"k":1}`);
}

/** Minimal ustar header for a single entry — used to forge traversal names. */
function forgeTarGz(entryName: string, content: string): Buffer {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  header.write(entryName, 0, "utf8");
  header.write("0000644\0", 100, "utf8"); // mode
  header.write("0000000\0", 108, "utf8"); // uid
  header.write("0000000\0", 116, "utf8"); // gid
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "utf8"); // size
  header.write("00000000000\0", 136, "utf8"); // mtime
  header.write("        ", 148, "utf8"); // checksum placeholder = spaces
  header.write("0", 156, "utf8"); // typeflag: regular file
  header.write("ustar\0", 257, "utf8");
  header.write("00", 263, "utf8");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");

  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  const end = Buffer.alloc(1024);
  return gzipSync(Buffer.concat([header, padded, end]));
}

describe("packSessionDir", () => {
  it("returns null for a missing directory", async () => {
    expect(await packSessionDir(path.join(tmpRoot, "nope"))).toBeNull();
  });

  it("returns null for an empty directory", async () => {
    const dir = path.join(tmpRoot, "empty");
    fs.mkdirSync(dir);
    expect(await packSessionDir(dir)).toBeNull();
  });

  it("packs and reports file count, size and sha256", async () => {
    const dir = path.join(tmpRoot, "session");
    writeSessionFixture(dir);
    const packed = await packSessionDir(dir);
    expect(packed).not.toBeNull();
    expect(packed!.fileCount).toBe(3);
    expect(packed!.sizeBytes).toBe(packed!.data.length);
    expect(packed!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: identical content yields identical sha256", async () => {
    const dir = path.join(tmpRoot, "session");
    writeSessionFixture(dir);
    const first = await packSessionDir(dir);
    await new Promise((r) => setTimeout(r, 30));
    // Touch mtimes — content unchanged must still dedup (noMtime).
    const f = path.join(dir, "2026-06-10-abc.jsonl");
    fs.utimesSync(f, new Date(), new Date());
    const second = await packSessionDir(dir);
    expect(second!.sha256).toBe(first!.sha256);
  });
});

describe("extractSessionCheckpoint", () => {
  it("round-trips a packed session directory", async () => {
    const src = path.join(tmpRoot, "src");
    writeSessionFixture(src);
    const packed = await packSessionDir(src);

    const dst = path.join(tmpRoot, "dst");
    await extractSessionCheckpoint(packed!.data, dst);

    expect(fs.readFileSync(path.join(dst, "2026-06-10-abc.jsonl"), "utf8"))
      .toBe(fs.readFileSync(path.join(src, "2026-06-10-abc.jsonl"), "utf8"));
    expect(fs.readFileSync(path.join(dst, ".plan-ledger.json"), "utf8")).toBe(`{"tasks":[]}`);
    expect(fs.readFileSync(path.join(dst, "nested", "state.json"), "utf8")).toBe(`{"k":1}`);
  });

  it("rejects empty buffers", async () => {
    await expect(extractSessionCheckpoint(Buffer.alloc(0), path.join(tmpRoot, "x")))
      .rejects.toThrow(/empty/);
  });

  it("rejects non-gzip buffers", async () => {
    await expect(extractSessionCheckpoint(Buffer.from("plain text"), path.join(tmpRoot, "x")))
      .rejects.toThrow(/gzip/);
  });

  it("rejects buffers over the compressed cap", async () => {
    const big = Buffer.alloc(MAX_CHECKPOINT_COMPRESSED_BYTES + 1, 0x1f);
    big[1] = 0x8b;
    await expect(extractSessionCheckpoint(big, path.join(tmpRoot, "x")))
      .rejects.toThrow(/too large/);
  });

  it("rejects parent-directory traversal entries", async () => {
    const evil = forgeTarGz("../evil.txt", "pwned");
    const dst = path.join(tmpRoot, "dst");
    await expect(extractSessionCheckpoint(evil, dst)).rejects.toThrow(/Unsafe entry/);
    expect(fs.existsSync(path.join(tmpRoot, "evil.txt"))).toBe(false);
  });
});

describe("sessionDirNeedsHydration", () => {
  it("true for missing dir", () => {
    expect(sessionDirNeedsHydration(path.join(tmpRoot, "nope"))).toBe(true);
  });

  it("true for dir without jsonl", () => {
    const dir = path.join(tmpRoot, "d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, ".plan-ledger.json"), "{}");
    expect(sessionDirNeedsHydration(dir)).toBe(true);
  });

  it("false once a jsonl exists", () => {
    const dir = path.join(tmpRoot, "d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.jsonl"), "{}");
    expect(sessionDirNeedsHydration(dir)).toBe(false);
  });
});
