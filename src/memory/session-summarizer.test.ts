import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findLatestJsonl,
  extractMessages,
  saveSessionMemory,
  saveSessionKnowledge,
} from "./session-summarizer.js";

function writeJsonl(filePath: string, entries: unknown[]): void {
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n"), "utf-8");
}

describe("findLatestJsonl", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-find-jsonl-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when directory does not exist", () => {
    expect(findLatestJsonl(path.join(tmpDir, "nope"))).toBeNull();
  });

  it("returns null when directory is empty", () => {
    expect(findLatestJsonl(tmpDir)).toBeNull();
  });

  it("returns null when directory has no .jsonl files", () => {
    fs.writeFileSync(path.join(tmpDir, "foo.txt"), "x");
    fs.writeFileSync(path.join(tmpDir, "bar.md"), "x");
    expect(findLatestJsonl(tmpDir)).toBeNull();
  });

  it("returns the single .jsonl file when only one exists", () => {
    const p = path.join(tmpDir, "only.jsonl");
    fs.writeFileSync(p, "");
    expect(findLatestJsonl(tmpDir)).toBe(p);
  });

  it("returns the most recently modified .jsonl", () => {
    const older = path.join(tmpDir, "older.jsonl");
    const newer = path.join(tmpDir, "newer.jsonl");
    fs.writeFileSync(older, "");
    fs.writeFileSync(newer, "");
    // Force mtime difference
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(older, past, past);
    expect(findLatestJsonl(tmpDir)).toBe(newer);
  });
});

describe("extractMessages", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-extract-msg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts user and assistant messages with string content", async () => {
    const file = path.join(tmpDir, "s.jsonl");
    writeJsonl(file, [
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "assistant", content: "hi" } },
    ]);
    const msgs = await extractMessages(file);
    expect(msgs).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ]);
  });

  it("extracts text from content-array blocks (filters non-text)", async () => {
    const file = path.join(tmpDir, "s.jsonl");
    writeJsonl(file, [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "hello" },
            { type: "tool_use", name: "x" },
            { type: "text", text: "world" },
          ],
        },
      },
    ]);
    const msgs = await extractMessages(file);
    expect(msgs).toEqual([{ role: "assistant", text: "hello\nworld" }]);
  });

  it("skips malformed JSON lines without throwing", async () => {
    const file = path.join(tmpDir, "s.jsonl");
    fs.writeFileSync(
      file,
      [
        "not json",
        JSON.stringify({ type: "message", message: { role: "user", content: "good" } }),
        "{ broken",
      ].join("\n"),
    );
    const msgs = await extractMessages(file);
    expect(msgs).toEqual([{ role: "user", text: "good" }]);
  });

  it("skips non-message entries", async () => {
    const file = path.join(tmpDir, "s.jsonl");
    writeJsonl(file, [
      { type: "snapshot", data: {} },
      { type: "message", message: { role: "user", content: "keep me" } },
      { type: "system", payload: "ignored" },
    ]);
    const msgs = await extractMessages(file);
    expect(msgs).toEqual([{ role: "user", text: "keep me" }]);
  });

  it("skips slash-prefix commands from user role", async () => {
    const file = path.join(tmpDir, "s.jsonl");
    writeJsonl(file, [
      { type: "message", message: { role: "user", content: "/help" } },
      { type: "message", message: { role: "user", content: "real question" } },
    ]);
    const msgs = await extractMessages(file);
    expect(msgs).toEqual([{ role: "user", text: "real question" }]);
  });

  it("skips [System]-prefixed injected user messages", async () => {
    const file = path.join(tmpDir, "s.jsonl");
    writeJsonl(file, [
      { type: "message", message: { role: "user", content: "[System] sync" } },
      { type: "message", message: { role: "user", content: "user asked X" } },
    ]);
    const msgs = await extractMessages(file);
    expect(msgs).toEqual([{ role: "user", text: "user asked X" }]);
  });

  it("skips empty-text messages and whitespace-only content", async () => {
    const file = path.join(tmpDir, "s.jsonl");
    writeJsonl(file, [
      { type: "message", message: { role: "user", content: "   " } },
      { type: "message", message: { role: "assistant", content: "" } },
      { type: "message", message: { role: "user", content: "real" } },
    ]);
    const msgs = await extractMessages(file);
    expect(msgs).toEqual([{ role: "user", text: "real" }]);
  });

  it("ignores non user/assistant roles", async () => {
    const file = path.join(tmpDir, "s.jsonl");
    writeJsonl(file, [
      { type: "message", message: { role: "system", content: "x" } },
      { type: "message", message: { role: "tool", content: "y" } },
      { type: "message", message: { role: "user", content: "z" } },
    ]);
    const msgs = await extractMessages(file);
    expect(msgs).toEqual([{ role: "user", text: "z" }]);
  });
});

describe("saveSessionMemory", () => {
  let tmpDir: string;
  let sessionDir: string;
  let memoryDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-save-mem-"));
    sessionDir = path.join(tmpDir, "session");
    memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(sessionDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when sessionDir has no .jsonl file", async () => {
    const result = await saveSessionMemory({ sessionDir, memoryDir });
    expect(result).toBeNull();
  });

  it("returns null when fewer than MIN_MESSAGES_TO_SAVE (3) messages", async () => {
    writeJsonl(path.join(sessionDir, "s.jsonl"), [
      { type: "message", message: { role: "user", content: "one" } },
      { type: "message", message: { role: "assistant", content: "two" } },
    ]);
    const result = await saveSessionMemory({ sessionDir, memoryDir });
    expect(result).toBeNull();
    expect(fs.existsSync(memoryDir)).toBe(false);
  });

  it("writes markdown file when there are enough messages", async () => {
    writeJsonl(path.join(sessionDir, "s.jsonl"), [
      { type: "message", message: { role: "user", content: "q1" } },
      { type: "message", message: { role: "assistant", content: "a1" } },
      { type: "message", message: { role: "user", content: "q2" } },
      { type: "message", message: { role: "assistant", content: "a2" } },
    ]);
    const result = await saveSessionMemory({ sessionDir, memoryDir });
    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);
    const content = fs.readFileSync(result!, "utf-8");
    expect(content).toContain("# Session Summary:");
    expect(content).toContain("## Conversation");
    expect(content).toContain("**user**: q1");
    expect(content).toContain("**assistant**: a2");
  });

  it("truncates long messages at 2000 chars with ellipsis", async () => {
    const long = "x".repeat(2500);
    const msgs = [
      { type: "message", message: { role: "user", content: long } },
      { type: "message", message: { role: "assistant", content: "short" } },
      { type: "message", message: { role: "user", content: "ok" } },
    ];
    writeJsonl(path.join(sessionDir, "s.jsonl"), msgs);
    const result = await saveSessionMemory({ sessionDir, memoryDir });
    expect(result).not.toBeNull();
    const content = fs.readFileSync(result!, "utf-8");
    // Should contain 2000 x's + ellipsis marker, NOT the full 2500
    expect(content).toContain("x".repeat(2000) + "...");
    expect(content).not.toContain("x".repeat(2001));
  });

  it("respects maxMessages and keeps only the last N messages", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      type: "message",
      message: { role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i}` },
    }));
    writeJsonl(path.join(sessionDir, "s.jsonl"), many);
    const result = await saveSessionMemory({ sessionDir, memoryDir, maxMessages: 3 });
    expect(result).not.toBeNull();
    const content = fs.readFileSync(result!, "utf-8");
    // Last 3 messages: msg-7, msg-8, msg-9
    expect(content).toContain("msg-9");
    expect(content).toContain("msg-8");
    expect(content).toContain("msg-7");
    expect(content).not.toContain("msg-0");
    expect(content).not.toContain("msg-6");
  });

  it("creates memoryDir if missing", async () => {
    const enoughMsgs = Array.from({ length: 3 }, (_, i) => ({
      type: "message",
      message: { role: "user", content: `m${i}` },
    }));
    writeJsonl(path.join(sessionDir, "s.jsonl"), enoughMsgs);
    expect(fs.existsSync(memoryDir)).toBe(false);
    const result = await saveSessionMemory({ sessionDir, memoryDir });
    expect(result).not.toBeNull();
    expect(fs.existsSync(memoryDir)).toBe(true);
  });

  it("appends counter when same-minute file exists", async () => {
    const msgs = Array.from({ length: 3 }, (_, i) => ({
      type: "message",
      message: { role: "user", content: `m${i}` },
    }));
    writeJsonl(path.join(sessionDir, "s.jsonl"), msgs);

    const first = await saveSessionMemory({ sessionDir, memoryDir });
    const second = await saveSessionMemory({ sessionDir, memoryDir });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
    expect(fs.existsSync(first!)).toBe(true);
    expect(fs.existsSync(second!)).toBe(true);
    // Second should have -2 suffix
    expect(path.basename(second!)).toMatch(/-2\.md$/);
  });
});

describe("saveSessionKnowledge", () => {
  let tmpDir: string;
  let sessionDir: string;
  let memoryDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-save-know-"));
    sessionDir = path.join(tmpDir, "session");
    memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(sessionDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when nothing saved", async () => {
    const result = await saveSessionKnowledge({ sessionDir, memoryDir });
    expect(result).toBeNull();
  });

  it("returns an array with the written path when save succeeds", async () => {
    writeJsonl(path.join(sessionDir, "s.jsonl"), [
      { type: "message", message: { role: "user", content: "q1" } },
      { type: "message", message: { role: "assistant", content: "a1" } },
      { type: "message", message: { role: "user", content: "q2" } },
    ]);
    const result = await saveSessionKnowledge({ sessionDir, memoryDir });
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBe(1);
    expect(fs.existsSync(result![0])).toBe(true);
  });
});
