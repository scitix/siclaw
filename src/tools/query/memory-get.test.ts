import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMemoryGetTool } from "./memory-get.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-get-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("memory_get tool", () => {
  it("has correct metadata", () => {
    const tool = createMemoryGetTool(dir);
    expect(tool.name).toBe("memory_get");
    expect(tool.label).toBe("Memory Get");
  });

  it("returns error on empty path", async () => {
    const tool = createMemoryGetTool(dir);
    const result = await tool.execute("id", { path: "" });
    expect(JSON.parse((result.content[0] as any).text).error).toBe("Empty path");
  });

  it("rejects path traversal via ..", async () => {
    const tool = createMemoryGetTool(dir);
    const result = await tool.execute("id", { path: "../escape.md" });
    expect(JSON.parse((result.content[0] as any).text).error).toBe("Path traversal blocked");
  });

  it("rejects absolute path traversal", async () => {
    const tool = createMemoryGetTool(dir);
    const result = await tool.execute("id", { path: "/etc/passwd" });
    expect(JSON.parse((result.content[0] as any).text).error).toBe("Path traversal blocked");
  });

  it("returns error when file not found", async () => {
    const tool = createMemoryGetTool(dir);
    const result = await tool.execute("id", { path: "missing.md" });
    expect(JSON.parse((result.content[0] as any).text).error).toContain("File not found");
  });

  it("reads full file when no range given", async () => {
    const file = path.join(dir, "MEMORY.md");
    fs.writeFileSync(file, "line1\nline2\nline3");
    const tool = createMemoryGetTool(dir);
    const result = await tool.execute("id", { path: "MEMORY.md" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.totalLines).toBe(3);
    expect(parsed.content).toBe("line1\nline2\nline3");
    expect(parsed.lines).toBe(3);
  });

  it("honors from + lines window", async () => {
    const file = path.join(dir, "MEMORY.md");
    const content = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n");
    fs.writeFileSync(file, content);
    const tool = createMemoryGetTool(dir);
    const result = await tool.execute("id", { path: "MEMORY.md", from: 3, lines: 2 });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.from).toBe(3);
    expect(parsed.lines).toBe(2);
    expect(parsed.content).toBe("L3\nL4");
  });

  it("clamps from to at least 1", async () => {
    const file = path.join(dir, "MEMORY.md");
    fs.writeFileSync(file, "a\nb\nc");
    const tool = createMemoryGetTool(dir);
    const result = await tool.execute("id", { path: "MEMORY.md", from: 0 });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.from).toBe(1);
  });

  it("rejects very large files without from/lines", async () => {
    const file = path.join(dir, "big.md");
    fs.writeFileSync(file, "x".repeat(200 * 1024));
    const tool = createMemoryGetTool(dir);
    const result = await tool.execute("id", { path: "big.md" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.error).toContain("File too large");
  });

  it("allows reading big files when from/lines provided", async () => {
    const file = path.join(dir, "big.md");
    fs.writeFileSync(file, "x".repeat(200 * 1024));
    const tool = createMemoryGetTool(dir);
    const result = await tool.execute("id", { path: "big.md", from: 1, lines: 1 });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.lines).toBe(1);
  });
});
