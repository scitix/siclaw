import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { capturePiSession, restorePiSession, validatePiSnapshot } from "./pi-session-snapshot.js";

const dirs: string[] = [];
function dir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-checkpoint-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

it("preserves messages before the first assistant creates a JSONL", () => {
  const sm = SessionManager.create("/old-runtime", dir());
  sm.appendMessage({ role: "user", content: "Keep this first input", timestamp: 123 });
  const snapshot = capturePiSession("business-session", sm);
  const restored = restorePiSession(snapshot, dir(), "/new-runtime");
  expect(restored.getEntries()).toEqual(sm.getEntries());
  expect(restored.buildSessionContext().messages).toEqual(sm.buildSessionContext().messages);
  expect(restored.getHeader()?.cwd).toBe("/new-runtime");
});

it("preserves the entire branch tree and the in-memory active leaf", () => {
  const sm = SessionManager.create("/old-runtime", dir());
  const one = sm.appendMessage({ role: "user", content: "one", timestamp: 1 });
  sm.appendMessage({ role: "user", content: "two", timestamp: 2 });
  sm.branch(one);
  const snapshot = capturePiSession("sid", sm);
  sm.appendMessage({ role: "user", content: "later", timestamp: 3 });
  const restored = restorePiSession(snapshot, dir(), "/new-runtime");
  expect(restored.getEntries()).toHaveLength(2);
  expect(restored.getLeafId()).toBe(one);
  expect(restored.buildSessionContext().messages).toHaveLength(1);
});

it("rejects broken trees, unknown leaves and the wrong business session", () => {
  const sm = SessionManager.create("/runtime", dir());
  sm.appendMessage({ role: "user", content: "one", timestamp: 1 });
  const snapshot = capturePiSession("sid", sm);
  expect(() => validatePiSnapshot(snapshot, "other")).toThrow();
  expect(() => validatePiSnapshot({ ...snapshot, activeLeafId: "missing" }, "sid")).toThrow();
  expect(() => validatePiSnapshot({ ...snapshot, entries: [...snapshot.entries, ...snapshot.entries] }, "sid")).toThrow();
});

it("restores compaction context and its selected branch without resurrecting pruned context", () => {
  const sm = SessionManager.create("/old-runtime", dir());
  sm.appendMessage({ role: "user", content: "old investigation details", timestamp: 1 });
  const kept = sm.appendMessage({ role: "user", content: "current question", timestamp: 2 });
  const compacted = sm.appendCompaction("Verified summary of earlier investigation", kept, 42000, { source: "test" });
  sm.appendMessage({ role: "user", content: "different branch", timestamp: 3 });
  sm.branch(compacted);
  const before = sm.buildSessionContext();
  const snapshot = capturePiSession("sid", sm);
  const restored = restorePiSession(snapshot, dir(), "/new-runtime");
  expect(restored.getEntries()).toEqual(sm.getEntries());
  expect(restored.getLeafId()).toBe(compacted);
  expect(restored.buildSessionContext()).toEqual(before);
  const messages = JSON.stringify(restored.buildSessionContext().messages);
  expect(messages).toContain("Verified summary of earlier investigation");
  expect(messages).toContain("current question");
  expect(messages).not.toContain("old investigation details");
  expect(messages).not.toContain("different branch");
});
