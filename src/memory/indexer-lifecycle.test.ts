/**
 * Tests for MemoryIndexer.purgeStaleInvestigations() — retention policy enforcement.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initMemoryDb } from "./schema.js";
import type { InvestigationRecord } from "./types.js";
import { MemoryIndexer } from "./indexer.js";

function createTestDb(): DatabaseSync {
  return initMemoryDb(":memory:");
}

function insertRecord(
  db: DatabaseSync,
  rec: Partial<InvestigationRecord> & { id: string; question: string; createdAt: number },
) {
  db.prepare(
    `INSERT OR REPLACE INTO investigations
     (id, question, root_cause_category, affected_entities, environment_tags,
      causal_chain, confidence, conclusion, remediation_steps, duration_ms, total_tool_calls,
      hypotheses_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rec.id,
    rec.question,
    rec.rootCauseCategory ?? "unknown",
    JSON.stringify(rec.affectedEntities ?? []),
    JSON.stringify(rec.environmentTags ?? []),
    JSON.stringify(rec.causalChain ?? []),
    rec.confidence ?? 50,
    rec.conclusion ?? "",
    rec.remediationSteps ? JSON.stringify(rec.remediationSteps) : null,
    rec.durationMs ?? 1000,
    rec.totalToolCalls ?? 5,
    JSON.stringify(rec.hypotheses ?? []),
    rec.createdAt,
  );
}

function setFeedback(db: DatabaseSync, id: string, signal: number, feedbackAt: number) {
  db.prepare("UPDATE investigations SET feedback_signal = ?, feedback_at = ? WHERE id = ?").run(
    signal,
    feedbackAt,
    id,
  );
}

function createTestIndexer(db: DatabaseSync): MemoryIndexer {
  const fakeEmbedding = {
    embed: async () => [[]],
    dimensions: 128,
    model: "test",
  };
  const indexer = new MemoryIndexer(":memory:", "/tmp/nonexistent-memory-dir", fakeEmbedding);
  (indexer as any).db = db;
  (indexer as any)._stmts = undefined;
  return indexer;
}

function countInvestigations(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM investigations").get() as { c: number }).c;
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("purgeStaleInvestigations", () => {
  let db: DatabaseSync;
  let indexer: MemoryIndexer;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    indexer = createTestIndexer(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-purge-test-"));
    fs.mkdirSync(path.join(tmpDir, "investigations"), { recursive: true });
  });

  afterEach(() => {
    indexer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 0 when no investigations exist", async () => {
    const count = await indexer.purgeStaleInvestigations(tmpDir);
    expect(count).toBe(0);
  });

  it("purges negated investigations older than 90 days", async () => {
    const now = Date.now();
    const old = now - 91 * DAY_MS;

    insertRecord(db, { id: "negated-old", question: "old negated", createdAt: old });
    setFeedback(db, "negated-old", 0.2, old + 1000);

    expect(countInvestigations(db)).toBe(1);

    const purged = await indexer.purgeStaleInvestigations(tmpDir);
    expect(purged).toBe(1);
    expect(countInvestigations(db)).toBe(0);
  });

  it("purges no-feedback investigations older than 365 days", async () => {
    const now = Date.now();
    const old = now - 366 * DAY_MS;

    // No feedback — feedback_at IS NULL, default signal=1.0
    insertRecord(db, { id: "no-fb-old", question: "old no feedback", createdAt: old });

    expect(countInvestigations(db)).toBe(1);

    const purged = await indexer.purgeStaleInvestigations(tmpDir);
    expect(purged).toBe(1);
    expect(countInvestigations(db)).toBe(0);
  });

  it("keeps explicitly confirmed investigations forever", async () => {
    const now = Date.now();
    const veryOld = now - 500 * DAY_MS;

    insertRecord(db, { id: "confirmed", question: "confirmed old", createdAt: veryOld });
    setFeedback(db, "confirmed", 1.5, veryOld + 1000);

    const purged = await indexer.purgeStaleInvestigations(tmpDir);
    expect(purged).toBe(0);
    expect(countInvestigations(db)).toBe(1);
  });

  it("keeps recent negated investigations (< 90 days old)", async () => {
    const now = Date.now();
    const recent = now - 30 * DAY_MS;

    insertRecord(db, { id: "negated-recent", question: "recent negated", createdAt: recent });
    setFeedback(db, "negated-recent", 0.3, recent + 1000);

    const purged = await indexer.purgeStaleInvestigations(tmpDir);
    expect(purged).toBe(0);
    expect(countInvestigations(db)).toBe(1);
  });

  it("keeps recent no-feedback investigations (< 365 days old)", async () => {
    const now = Date.now();
    const recent = now - 100 * DAY_MS;

    insertRecord(db, { id: "no-fb-recent", question: "recent no feedback", createdAt: recent });

    const purged = await indexer.purgeStaleInvestigations(tmpDir);
    expect(purged).toBe(0);
    expect(countInvestigations(db)).toBe(1);
  });

  it("handles missing .md files gracefully (still deletes DB record)", async () => {
    const now = Date.now();
    const old = now - 400 * DAY_MS;

    // Insert a record whose .md file does not exist on disk
    insertRecord(db, { id: "missing-file", question: "missing file", createdAt: old });

    expect(countInvestigations(db)).toBe(1);

    const purged = await indexer.purgeStaleInvestigations(tmpDir);
    expect(purged).toBe(1);
    expect(countInvestigations(db)).toBe(0);
  });

  it("is idempotent — running twice does not error", async () => {
    const now = Date.now();
    const old = now - 400 * DAY_MS;

    insertRecord(db, { id: "idem", question: "idempotent test", createdAt: old });

    const first = await indexer.purgeStaleInvestigations(tmpDir);
    expect(first).toBe(1);

    const second = await indexer.purgeStaleInvestigations(tmpDir);
    expect(second).toBe(0);
    expect(countInvestigations(db)).toBe(0);
  });
});
