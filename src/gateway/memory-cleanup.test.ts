import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearAgentMemory } from "./memory-cleanup.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-cleanup-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("clearAgentMemory", () => {
  it("deletes the complete memory directory including profile, db, and nested files", () => {
    const memoryDir = path.join(tmpDir, "agents", "a1", "memory");
    fs.mkdirSync(path.join(memoryDir, "investigations"), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, "topics"), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, "PROFILE.md"), "profile");
    fs.writeFileSync(path.join(memoryDir, ".memory.db"), "db");
    fs.writeFileSync(path.join(memoryDir, "2026-05-26-0502.md"), "longmen");
    fs.writeFileSync(path.join(memoryDir, "investigations", "case.md"), "case");
    fs.writeFileSync(path.join(memoryDir, "topics", "cilium.md"), "topic");

    const result = clearAgentMemory("a1", tmpDir);

    expect(result.deletedFiles).toBe(5);
    expect(result.memoryDir).toBe(memoryDir);
    expect(fs.existsSync(memoryDir)).toBe(false);
  });

  it("is idempotent when the memory directory is already absent", () => {
    const first = clearAgentMemory("missing", tmpDir);
    const second = clearAgentMemory("missing", tmpDir);

    expect(first.deletedFiles).toBe(0);
    expect(second.deletedFiles).toBe(0);
  });
});
