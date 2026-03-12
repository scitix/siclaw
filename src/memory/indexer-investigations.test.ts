/**
 * Tests for MemoryIndexer investigation-related methods:
 * - getInvestigationPatterns (time-weighted aggregation)
 * - searchInvestigations (keyword relevance scoring)
 * - lookupInvestigationsByFiles (date-based reverse lookup)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initMemoryDb } from "./schema.js";
import type { InvestigationRecord } from "./types.js";

// Minimal MemoryIndexer that only exposes the investigation methods under test.
// We bypass the full constructor (which needs memoryDir + embedding provider)
// and operate directly on the DB.

function createTestDb(): DatabaseSync {
  return initMemoryDb(":memory:");
}

function insertRecord(db: DatabaseSync, rec: Partial<InvestigationRecord> & { id: string; question: string; createdAt: number }) {
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

// We need to access the MemoryIndexer methods. Since the constructor requires
// filesystem + embedding, we'll import the module and create a minimal instance
// using a trick: construct with a fake memoryDir and no-op embedding, then
// replace the internal db.
import { MemoryIndexer } from "./indexer.js";

function createTestIndexer(db: DatabaseSync): MemoryIndexer {
  // Create with in-memory db path — the constructor will create its own db,
  // but we need to use our pre-populated one. Use Object.assign to swap it.
  const fakeEmbedding = {
    embed: async () => [[]],
    dimensions: 128,
    model: "test",
  };
  const indexer = new MemoryIndexer(":memory:", "/tmp/nonexistent-memory-dir", fakeEmbedding);
  // Swap the db with our pre-populated one
  // Access private field via any — only for testing
  (indexer as any).db = db;
  (indexer as any)._stmts = undefined; // Reset cached prepared statements
  return indexer;
}

describe("getInvestigationPatterns", () => {
  let db: DatabaseSync;
  let indexer: MemoryIndexer;

  beforeEach(() => {
    db = createTestDb();
    indexer = createTestIndexer(db);
  });

  afterEach(() => {
    indexer.close();
  });

  it("returns empty array when no investigations exist", () => {
    expect(indexer.getInvestigationPatterns()).toEqual([]);
  });

  it("groups by root_cause_category and counts", () => {
    const now = Date.now();
    insertRecord(db, { id: "1", question: "q1", rootCauseCategory: "mtu_mismatch", confidence: 80, createdAt: now });
    insertRecord(db, { id: "2", question: "q2", rootCauseCategory: "mtu_mismatch", confidence: 90, createdAt: now });
    insertRecord(db, { id: "3", question: "q3", rootCauseCategory: "pcie_error", confidence: 70, createdAt: now });

    const patterns = indexer.getInvestigationPatterns();
    expect(patterns.length).toBe(2);
    expect(patterns[0].rootCauseCategory).toBe("mtu_mismatch");
    expect(patterns[0].count).toBe(2);
    expect(patterns[1].rootCauseCategory).toBe("pcie_error");
    expect(patterns[1].count).toBe(1);
  });

  it("applies time decay — recent investigations rank higher", () => {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;

    // 5 old pcie_error investigations
    for (let i = 0; i < 5; i++) {
      insertRecord(db, { id: `old-${i}`, question: `old q${i}`, rootCauseCategory: "pcie_error", confidence: 80, createdAt: ninetyDaysAgo });
    }
    // 2 recent mtu_mismatch investigations
    insertRecord(db, { id: "new-1", question: "new q1", rootCauseCategory: "mtu_mismatch", confidence: 85, createdAt: now });
    insertRecord(db, { id: "new-2", question: "new q2", rootCauseCategory: "mtu_mismatch", confidence: 90, createdAt: now - 1000 });

    const patterns = indexer.getInvestigationPatterns();
    // Despite pcie_error having more raw count (5 vs 2), mtu_mismatch should rank first
    // because its weighted count is higher (recent investigations)
    expect(patterns[0].rootCauseCategory).toBe("mtu_mismatch");
    expect(patterns[0].count).toBe(2); // raw count preserved
  });

  it("extracts validated hypotheses and remediations", () => {
    const now = Date.now();
    insertRecord(db, {
      id: "1", question: "q1", rootCauseCategory: "mtu_mismatch", createdAt: now,
      hypotheses: [
        { id: "H1", text: "MTU 1500 vs 9000", status: "validated", confidence: 90 },
        { id: "H2", text: "PCIe degraded", status: "invalidated", confidence: 20 },
      ],
      remediationSteps: ["Set MTU to 9000 on all interfaces"],
    });

    const patterns = indexer.getInvestigationPatterns();
    expect(patterns[0].validatedHypotheses).toContain("MTU 1500 vs 9000");
    expect(patterns[0].validatedHypotheses).not.toContain("PCIe degraded");
    expect(patterns[0].commonRemediations).toContain("Set MTU to 9000 on all interfaces");
  });

  it("respects topK parameter", () => {
    const now = Date.now();
    insertRecord(db, { id: "1", question: "q1", rootCauseCategory: "cat_a", createdAt: now });
    insertRecord(db, { id: "2", question: "q2", rootCauseCategory: "cat_b", createdAt: now });
    insertRecord(db, { id: "3", question: "q3", rootCauseCategory: "cat_c", createdAt: now });

    const patterns = indexer.getInvestigationPatterns(2);
    expect(patterns.length).toBe(2);
  });
});

describe("searchInvestigations", () => {
  let db: DatabaseSync;
  let indexer: MemoryIndexer;

  beforeEach(() => {
    db = createTestDb();
    indexer = createTestIndexer(db);
  });

  afterEach(() => {
    indexer.close();
  });

  it("returns empty array when no investigations exist", () => {
    expect(indexer.searchInvestigations("any query")).toEqual([]);
  });

  it("returns results ranked by keyword relevance", () => {
    const now = Date.now();
    insertRecord(db, { id: "1", question: "RDMA bandwidth low on node-A", rootCauseCategory: "mtu_mismatch", conclusion: "MTU was 1500", createdAt: now - 2000 });
    insertRecord(db, { id: "2", question: "Pod OOMKilled in namespace default", rootCauseCategory: "resource_exhaustion", conclusion: "Memory limit too low", createdAt: now - 1000 });
    insertRecord(db, { id: "3", question: "RDMA bandwidth degraded after firmware update", rootCauseCategory: "firmware_bug", conclusion: "Firmware regression in RDMA path", createdAt: now });

    const results = indexer.searchInvestigations("RDMA bandwidth");
    expect(results.length).toBeGreaterThan(0);
    // RDMA-related investigations should rank higher than the OOM one
    const rdmaIds = results.filter(r => r.question.includes("RDMA")).map(r => r.id);
    const oomIdx = results.findIndex(r => r.id === "2");
    if (oomIdx >= 0) {
      // OOM result should be after RDMA results
      expect(oomIdx).toBeGreaterThanOrEqual(rdmaIds.length);
    }
  });

  it("falls back to recency when no keywords match", () => {
    const now = Date.now();
    insertRecord(db, { id: "old", question: "old investigation", createdAt: now - 10000 });
    insertRecord(db, { id: "new", question: "new investigation", createdAt: now });

    // Query with gibberish that won't match anything
    const results = indexer.searchInvestigations("xyzzy123nonexistent");
    expect(results.length).toBe(2);
    expect(results[0].id).toBe("new"); // most recent first
  });

  it("filters by rootCauseCategory when specified", () => {
    const now = Date.now();
    insertRecord(db, { id: "1", question: "q1", rootCauseCategory: "mtu_mismatch", createdAt: now });
    insertRecord(db, { id: "2", question: "q2", rootCauseCategory: "pcie_error", createdAt: now });

    const results = indexer.searchInvestigations("q", { rootCauseCategory: "mtu_mismatch" });
    expect(results.length).toBe(1);
    expect(results[0].rootCauseCategory).toBe("mtu_mismatch");
  });

  it("respects topK parameter", () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      insertRecord(db, { id: `${i}`, question: `RDMA issue ${i}`, rootCauseCategory: "mtu_mismatch", createdAt: now - i * 1000 });
    }

    const results = indexer.searchInvestigations("RDMA", { topK: 3 });
    expect(results.length).toBe(3);
  });
});

describe("lookupInvestigationsByFiles", () => {
  let db: DatabaseSync;
  let indexer: MemoryIndexer;

  beforeEach(() => {
    db = createTestDb();
    indexer = createTestIndexer(db);
  });

  afterEach(() => {
    indexer.close();
  });

  it("returns empty array for empty input", () => {
    expect(indexer.lookupInvestigationsByFiles([])).toEqual([]);
  });

  it("returns empty array when no dates match", () => {
    const now = Date.now();
    insertRecord(db, { id: "1", question: "q1", createdAt: now });

    const results = indexer.lookupInvestigationsByFiles(["investigations/1999-01-01-00-00-00.md"]);
    expect(results.length).toBe(0);
  });

  it("finds records matching full datetime within ±60s window", () => {
    // Create a record at a known time
    const targetDate = new Date("2026-03-08T12:00:00Z");
    insertRecord(db, { id: "match", question: "RDMA issue", createdAt: targetDate.getTime() });

    // Create a record at a different time (same day, 2 hours later)
    const sameDayOther = new Date("2026-03-08T14:00:00Z");
    insertRecord(db, { id: "same-day-other", question: "other issue same day", createdAt: sameDayOther.getTime() });

    // Filename format matches writeInvestigationToMemory: "2026-03-08-12-00-00.md"
    const results = indexer.lookupInvestigationsByFiles(["investigations/2026-03-08-12-00-00.md"]);
    expect(results.some(r => r.id === "match")).toBe(true);
    // Same-day record 2 hours away should NOT match (outside ±60s window)
    expect(results.some(r => r.id === "same-day-other")).toBe(false);
  });

  it("falls back to date-only match for filenames without full timestamp", () => {
    const targetDate = new Date("2026-03-08T12:00:00Z");
    insertRecord(db, { id: "match", question: "RDMA issue", createdAt: targetDate.getTime() });

    const otherDate = new Date("2026-03-07T12:00:00Z");
    insertRecord(db, { id: "other", question: "other issue", createdAt: otherDate.getTime() });

    // Date-only filename (no HH-MM-SS) — falls back to date matching
    const results = indexer.lookupInvestigationsByFiles(["investigations/2026-03-08.md"]);
    expect(results.some(r => r.id === "match")).toBe(true);
    expect(results.some(r => r.id === "other")).toBe(false);
  });

  it("handles paths without dates gracefully", () => {
    const results = indexer.lookupInvestigationsByFiles(["investigations/no-date-here.md"]);
    expect(results).toEqual([]);
  });
});
