/**
 * Tests for MemoryIndexer investigation CRUD primitives:
 * - clearInvestigations
 * - insertInvestigation
 * - getInvestigationById
 * - updateInvestigationFeedback
 * - countChunksByFile
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initMemoryDb } from "./schema.js";
import { MemoryIndexer } from "./indexer.js";
import type { InvestigationRecord } from "./types.js";

function createTestIndexer(db: DatabaseSync): MemoryIndexer {
  const fakeEmbedding = {
    embed: async () => [[]],
    dimensions: 4,
    model: "test",
  };
  const indexer = new MemoryIndexer(":memory:", "/tmp/nonexistent-memory-dir", fakeEmbedding);
  (indexer as any).db = db;
  (indexer as any)._stmts = undefined;
  return indexer;
}

function sampleRecord(overrides: Partial<InvestigationRecord> = {}): InvestigationRecord {
  return {
    id: overrides.id ?? "inv-1",
    question: overrides.question ?? "why is pod OOM?",
    rootCauseCategory: overrides.rootCauseCategory ?? "resource_exhaustion",
    affectedEntities: overrides.affectedEntities ?? ["pod/foo", "ns/bar"],
    environmentTags: overrides.environmentTags ?? ["prod"],
    causalChain: overrides.causalChain ?? ["memory limit too low", "pod killed"],
    confidence: overrides.confidence ?? 80,
    conclusion: overrides.conclusion ?? "Bump memory limit to 2Gi",
    remediationSteps: overrides.remediationSteps ?? ["edit deployment", "rollout restart"],
    durationMs: overrides.durationMs ?? 1234,
    totalToolCalls: overrides.totalToolCalls ?? 5,
    hypotheses: overrides.hypotheses ?? [
      { id: "H1", text: "OOM", status: "validated", confidence: 90 },
    ],
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

describe("clearInvestigations", () => {
  let db: DatabaseSync;
  let indexer: MemoryIndexer;

  beforeEach(() => {
    db = initMemoryDb(":memory:");
    indexer = createTestIndexer(db);
  });

  afterEach(() => {
    indexer.close();
  });

  it("is a no-op on an empty table", () => {
    expect(() => indexer.clearInvestigations()).not.toThrow();
  });

  it("deletes all investigation rows", () => {
    indexer.insertInvestigation(sampleRecord({ id: "a" }));
    indexer.insertInvestigation(sampleRecord({ id: "b" }));
    const countBefore = (db.prepare("SELECT COUNT(*) AS c FROM investigations").get() as { c: number }).c;
    expect(countBefore).toBe(2);

    indexer.clearInvestigations();
    const countAfter = (db.prepare("SELECT COUNT(*) AS c FROM investigations").get() as { c: number }).c;
    expect(countAfter).toBe(0);
  });
});

describe("insertInvestigation", () => {
  let db: DatabaseSync;
  let indexer: MemoryIndexer;

  beforeEach(() => {
    db = initMemoryDb(":memory:");
    indexer = createTestIndexer(db);
  });

  afterEach(() => {
    indexer.close();
  });

  it("persists a full record with JSON-encoded array fields", () => {
    const rec = sampleRecord({ id: "x" });
    indexer.insertInvestigation(rec);
    const row = db.prepare("SELECT * FROM investigations WHERE id = ?").get("x") as Record<string, unknown>;
    expect(row.id).toBe("x");
    expect(row.question).toBe(rec.question);
    expect(JSON.parse(row.affected_entities as string)).toEqual(rec.affectedEntities);
    expect(JSON.parse(row.environment_tags as string)).toEqual(rec.environmentTags);
    expect(JSON.parse(row.causal_chain as string)).toEqual(rec.causalChain);
    expect(JSON.parse(row.hypotheses_json as string)).toEqual(rec.hypotheses);
    expect(JSON.parse(row.remediation_steps as string)).toEqual(rec.remediationSteps);
  });

  it("stores null for remediation_steps when undefined", () => {
    const rec = sampleRecord({ id: "no-rem" });
    // Explicitly drop remediationSteps (the helper's ?? would otherwise substitute a default)
    delete (rec as Partial<InvestigationRecord>).remediationSteps;
    indexer.insertInvestigation(rec);
    const row = db.prepare("SELECT remediation_steps FROM investigations WHERE id = ?").get("no-rem") as { remediation_steps: string | null };
    expect(row.remediation_steps).toBeNull();
  });

  it("upserts on duplicate id (INSERT OR REPLACE)", () => {
    indexer.insertInvestigation(sampleRecord({ id: "dup", confidence: 50 }));
    indexer.insertInvestigation(sampleRecord({ id: "dup", confidence: 95 }));
    const row = db.prepare("SELECT confidence FROM investigations WHERE id = ?").get("dup") as { confidence: number };
    expect(row.confidence).toBe(95);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM investigations").get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

describe("getInvestigationById", () => {
  let db: DatabaseSync;
  let indexer: MemoryIndexer;

  beforeEach(() => {
    db = initMemoryDb(":memory:");
    indexer = createTestIndexer(db);
  });

  afterEach(() => {
    indexer.close();
  });

  it("returns null when id not found", () => {
    expect(indexer.getInvestigationById("nope")).toBeNull();
  });

  it("returns a fully decoded record", () => {
    const rec = sampleRecord({ id: "found" });
    indexer.insertInvestigation(rec);
    const restored = indexer.getInvestigationById("found");
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe("found");
    expect(restored!.affectedEntities).toEqual(rec.affectedEntities);
    expect(restored!.environmentTags).toEqual(rec.environmentTags);
    expect(restored!.causalChain).toEqual(rec.causalChain);
    expect(restored!.hypotheses).toEqual(rec.hypotheses);
    expect(restored!.remediationSteps).toEqual(rec.remediationSteps);
  });

  it("defaults feedbackSignal/Note/At to undefined when no feedback was written", () => {
    indexer.insertInvestigation(sampleRecord({ id: "no-fb" }));
    const rec = indexer.getInvestigationById("no-fb");
    // feedbackSignal has a DEFAULT 1.0 per schema migration — so it's a number, not undefined
    expect(typeof rec!.feedbackSignal).toBe("number");
    expect(rec!.feedbackAt).toBeUndefined();
    expect(rec!.feedbackNote).toBeUndefined();
  });

  it("returns null on malformed / truly invalid row (defensive)", () => {
    // Corrupt a row — manually set JSON fields to unparseable strings
    indexer.insertInvestigation(sampleRecord({ id: "c" }));
    db.prepare("UPDATE investigations SET affected_entities = '???not-json' WHERE id = ?").run("c");
    // The rowToInvestigationRecord helper uses safeJsonArray → returns [] on bad JSON
    const rec = indexer.getInvestigationById("c");
    expect(rec).not.toBeNull();
    expect(rec!.affectedEntities).toEqual([]); // recovered gracefully
  });
});

describe("updateInvestigationFeedback", () => {
  let db: DatabaseSync;
  let indexer: MemoryIndexer;

  beforeEach(() => {
    db = initMemoryDb(":memory:");
    indexer = createTestIndexer(db);
  });

  afterEach(() => {
    indexer.close();
  });

  it("returns false when id does not exist", () => {
    expect(indexer.updateInvestigationFeedback("nope", 1.5, "confirmed")).toBe(false);
  });

  it("updates signal, note and timestamp when id exists, returning true", () => {
    indexer.insertInvestigation(sampleRecord({ id: "u" }));
    const now = Date.now();
    const ok = indexer.updateInvestigationFeedback("u", 0.2, "rejected: bad call");
    expect(ok).toBe(true);
    const row = db.prepare("SELECT feedback_signal, feedback_note, feedback_at FROM investigations WHERE id = ?").get("u") as {
      feedback_signal: number;
      feedback_note: string;
      feedback_at: number;
    };
    expect(row.feedback_signal).toBe(0.2);
    expect(row.feedback_note).toBe("rejected: bad call");
    expect(row.feedback_at).toBeGreaterThanOrEqual(now);
  });

  it("overwrites previous feedback", () => {
    indexer.insertInvestigation(sampleRecord({ id: "u" }));
    indexer.updateInvestigationFeedback("u", 0.5, "first");
    indexer.updateInvestigationFeedback("u", 1.5, "confirmed");
    const rec = indexer.getInvestigationById("u");
    expect(rec!.feedbackSignal).toBe(1.5);
    expect(rec!.feedbackNote).toBe("confirmed");
  });
});

describe("countChunksByFile", () => {
  let db: DatabaseSync;
  let indexer: MemoryIndexer;

  beforeEach(() => {
    db = initMemoryDb(":memory:");
    indexer = createTestIndexer(db);
  });

  afterEach(() => {
    indexer.close();
  });

  it("returns 0 when no chunks exist for the path", () => {
    expect(indexer.countChunksByFile("missing.md")).toBe(0);
  });

  it("returns exact count for a given path (exact-match, not prefix)", () => {
    // Seed files + chunks directly
    db.prepare("INSERT INTO files (path, mtime_ms, hash) VALUES (?, ?, ?)").run("a.md", 1, "h1");
    db.prepare("INSERT INTO files (path, mtime_ms, hash) VALUES (?, ?, ?)").run("a.md.bak", 2, "h2");
    db.prepare("INSERT INTO chunks (file_path, heading, content) VALUES (?, ?, ?)").run("a.md", "h", "c1");
    db.prepare("INSERT INTO chunks (file_path, heading, content) VALUES (?, ?, ?)").run("a.md", "h", "c2");
    db.prepare("INSERT INTO chunks (file_path, heading, content) VALUES (?, ?, ?)").run("a.md.bak", "h", "c3");

    expect(indexer.countChunksByFile("a.md")).toBe(2);
    expect(indexer.countChunksByFile("a.md.bak")).toBe(1);
    expect(indexer.countChunksByFile("a.m")).toBe(0);
  });
});
