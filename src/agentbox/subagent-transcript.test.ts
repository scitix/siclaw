import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MAX_SUBAGENT_TRANSCRIPT_BYTES, openSubagentTranscript } from "./subagent-transcript.js";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-resume-")); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

function transcript() {
  const session = SessionManager.create("/previous-runtime-cwd", directory);
  const userId = session.appendMessage({ role: "user", content: "Inspect both interfaces", timestamp: Date.now() });
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "eth0 verified" }], api: "openai-responses", provider: "fixture", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  return { session, userId };
}

it("restores the same native session including compaction despite a changed cwd", () => {
  const { session, userId } = transcript();
  session.appendCompaction("Earlier checks were read-only", userId, 1000);
  const restored = openSubagentTranscript(directory);
  expect(restored.getSessionId()).toBe(session.getSessionId());
  expect(restored.getSessionFile()).toBe(session.getSessionFile());
  expect(restored.buildSessionContext()).toEqual(session.buildSessionContext());
  expect(JSON.stringify(restored.buildSessionContext())).toContain("Earlier checks were read-only");
  expect(restored.getCwd()).toBe("/previous-runtime-cwd");
});

it.each(["", "{}\n", '{"type":"session","id":"broken"}\n'])
("rejects an unusable transcript without creating another file (%j)", content => {
  fs.writeFileSync(path.join(directory, "broken.jsonl"), content);
  expect(() => openSubagentTranscript(directory)).toThrow(/recoverable transcript/);
  expect(fs.readdirSync(directory)).toEqual(["broken.jsonl"]);
  expect(fs.readFileSync(path.join(directory, "broken.jsonl"), "utf8")).toBe(content);
});

it("does not discard a damaged tail or fall back to an older valid transcript", () => {
  const { session } = transcript();
  const file = session.getSessionFile()!;
  const intact = fs.readFileSync(file, "utf8");
  const newest = path.join(directory, "newest.jsonl");
  fs.writeFileSync(newest, intact + '{"type":"message"');
  fs.utimesSync(newest, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
  expect(() => openSubagentTranscript(directory)).toThrow(/recoverable transcript/);
  expect(fs.readFileSync(file, "utf8")).toBe(intact);
});

it("rejects missing paths and symlinked transcripts", () => {
  expect(() => openSubagentTranscript(path.join(directory, "missing"))).toThrow(/recoverable transcript/);
  expect(() => openSubagentTranscript(directory)).toThrow(/recoverable transcript/);
  fs.writeFileSync(path.join(directory, "outside"), "{}");
  fs.symlinkSync(path.join(directory, "outside"), path.join(directory, "linked.jsonl"));
  expect(() => openSubagentTranscript(directory)).toThrow(/recoverable transcript/);
});

it("rejects oversized transcripts before parsing them", () => {
  const file = path.join(directory, "oversized.jsonl");
  fs.writeFileSync(file, '{"type":"session","id":"oversized"}\n');
  fs.truncateSync(file, MAX_SUBAGENT_TRANSCRIPT_BYTES + 1);

  expect(() => openSubagentTranscript(directory)).toThrow(/64 MiB resume limit/);
});
