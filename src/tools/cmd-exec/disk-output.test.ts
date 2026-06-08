import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reloadConfig } from "../../core/config.js";
import {
  DiskTaskOutput,
  getTaskOutputPath,
  readTaskOutput,
  sweepStaleTaskOutputs,
} from "./disk-output.js";

let tmp: string;
let prevEnv: string | undefined;

beforeAll(() => {
  prevEnv = process.env.SICLAW_USER_DATA_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-diskout-"));
  process.env.SICLAW_USER_DATA_DIR = tmp;
  reloadConfig();
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.SICLAW_USER_DATA_DIR;
  else process.env.SICLAW_USER_DATA_DIR = prevEnv;
  reloadConfig();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("DiskTaskOutput.ensureCreated", () => {
  it("creates an empty file at launch so a pre-output read returns '' not ENOENT", async () => {
    const disk = new DiskTaskOutput("job-eager");
    await disk.ensureCreated();
    expect(fs.existsSync(getTaskOutputPath("job-eager"))).toBe(true);
    const r = await readTaskOutput("job-eager");
    expect(r).toEqual({ output: "", bytes: 0, truncated: false, exists: true });
  });

  it("is idempotent and never truncates already-written content", async () => {
    const disk = new DiskTaskOutput("job-idem");
    await disk.ensureCreated();
    disk.append("hello\n");
    await disk.flush();
    await disk.ensureCreated(); // second call must not clobber
    const r = await readTaskOutput("job-idem");
    expect(r.output).toContain("hello");
  });
});

describe("readTaskOutput", () => {
  it("returns empty (not a throw) for a job whose file was never created", async () => {
    const r = await readTaskOutput("job-never-created");
    expect(r).toEqual({ output: "", bytes: 0, truncated: false, exists: false });
  });

  it("returns the last N lines with truncated=true when tail_lines is smaller", async () => {
    const disk = new DiskTaskOutput("job-tail");
    await disk.ensureCreated();
    disk.append("l1\nl2\nl3\nl4\nl5\n");
    await disk.flush();
    const r = await readTaskOutput("job-tail", 2);
    expect(r.truncated).toBe(true);
    // trailing-newline aware: a tail of 2 returns the 2 REAL last lines (l4, l5), not l5 + a phantom empty.
    expect(r.output).toBe("l4\nl5");
  });

  it("returns all real lines (no phantom empty, not truncated) when tail_lines >= line count", async () => {
    const disk = new DiskTaskOutput("job-exact");
    await disk.ensureCreated();
    disk.append("a\nb\nc\n");
    await disk.flush();
    const r = await readTaskOutput("job-exact", 3);
    expect(r.output).toBe("a\nb\nc");
    expect(r.truncated).toBe(false);
  });

  it("does not throw or return empty for a large output (reads a bounded tail from the end)", async () => {
    const disk = new DiskTaskOutput("job-big");
    await disk.ensureCreated();
    // ~3MB of lines — exceeds the 2MB tail read cap.
    disk.append(Array.from({ length: 60_000 }, (_, i) => `line-${i}`).join("\n") + "\n");
    await disk.flush();
    const r = await readTaskOutput("job-big", 5);
    expect(r.exists).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.output.split("\n").length).toBe(5);
    expect(r.output).toContain("line-59999"); // last line is present
  });

  it("keeps the raw tail (not empty) for a large NEWLINE-LESS blob beyond the cap", async () => {
    const disk = new DiskTaskOutput("job-no-nl");
    await disk.ensureCreated();
    // ~3MB single line, no newlines at all — exceeds the 2MB tail cap. The byte-offset read
    // would drop a "first line" that never ends, so without the fallback this collapses to "".
    disk.append("x".repeat(3 * 1024 * 1024));
    await disk.flush();
    const r = await readTaskOutput("job-no-nl", 5);
    expect(r.exists).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeGreaterThan(0); // raw last-cap bytes, not empty
    expect(r.output).toMatch(/^x+$/);
  });
});

describe("sweepStaleTaskOutputs", () => {
  it("deletes files older than maxAge and keeps fresh ones", async () => {
    // Both represent FINISHED jobs (markFinal) — only mtime should decide their fate.
    const fresh = new DiskTaskOutput("job-fresh");
    await fresh.ensureCreated();
    const stale = new DiskTaskOutput("job-stale");
    await stale.ensureCreated();
    fresh.markFinal();
    stale.markFinal();
    const stalePath = getTaskOutputPath("job-stale");
    const old = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    fs.utimesSync(stalePath, old, old);

    await sweepStaleTaskOutputs(30 * 60 * 1000); // 30-min threshold

    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(getTaskOutputPath("job-fresh"))).toBe(true);
  });

  it("never deletes a protected (still-running) job's file even when its mtime is old", async () => {
    const disk = new DiskTaskOutput("job-silent-running");
    await disk.ensureCreated();
    const p = getTaskOutputPath("job-silent-running");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(p, old, old);

    await sweepStaleTaskOutputs(30 * 60 * 1000, new Set([path.basename(p)]));

    expect(fs.existsSync(p)).toBe(true); // protected — a long-running silent job keeps its file
    disk.markFinal();
  });

  it("protects a live writer process-wide WITHOUT an explicit protect set (cross-registry safety)", async () => {
    // A job owned by another session/agent (whose registry this sweep can't see) must still be
    // protected purely because it has a live DiskTaskOutput writer — this is the cross-registry fix.
    const disk = new DiskTaskOutput("job-live-elsewhere");
    await disk.ensureCreated();
    const p = getTaskOutputPath("job-live-elsewhere");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(p, old, old);

    await sweepStaleTaskOutputs(30 * 60 * 1000); // no protect arg — relies on the live-writer set
    expect(fs.existsSync(p)).toBe(true);

    disk.markFinal(); // writer done → now eligible
    fs.utimesSync(p, old, old); // ensureCreated/sweep may have touched nothing, but be explicit
    await sweepStaleTaskOutputs(30 * 60 * 1000);
    expect(fs.existsSync(p)).toBe(false);
  });

  it("is a no-op when the tasks dir does not exist", async () => {
    await expect(sweepStaleTaskOutputs(0)).resolves.toBeUndefined();
  });
});
