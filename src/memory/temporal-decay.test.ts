import { describe, it, expect } from "vitest";
import { applyTemporalDecay } from "./temporal-decay.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("applyTemporalDecay", () => {
  // Use a fixed "now" for deterministic tests
  const now = Date.UTC(2026, 2, 18); // 2026-03-18

  // --- Date parsing for different filename formats ---

  it("decays YYYY-MM-DD.md files", () => {
    const results = [{ file: "memory/2026-03-17.md", score: 1.0 }];
    const decayed = applyTemporalDecay(results, { enabled: true, halfLifeDays: 30 }, now);
    expect(decayed[0].score).toBeLessThan(1.0);
    expect(decayed[0].score).toBeGreaterThan(0.9); // 1 day old, should barely decay
  });

  it("decays YYYY-MM-DD-HHmm.md files (session dump format)", () => {
    const results = [{ file: "memory/2026-03-17-1430.md", score: 1.0 }];
    const decayed = applyTemporalDecay(results, { enabled: true, halfLifeDays: 30 }, now);
    expect(decayed[0].score).toBeLessThan(1.0);
    expect(decayed[0].score).toBeGreaterThan(0.9);
  });

  it("decays YYYY-MM-DD-HHmm-N.md files (collision suffix)", () => {
    const results = [{ file: "memory/2026-03-17-1430-2.md", score: 1.0 }];
    const decayed = applyTemporalDecay(results, { enabled: true, halfLifeDays: 30 }, now);
    expect(decayed[0].score).toBeLessThan(1.0);
    expect(decayed[0].score).toBeGreaterThan(0.9);
  });

  it("extracts correct date from time-suffixed filenames", () => {
    // A file from 30 days ago should decay to ~0.5 with halfLife=30
    const thirtyDaysAgo = now - 30 * DAY_MS;
    const dateStr = new Date(thirtyDaysAgo).toISOString().slice(0, 10);
    const results = [{ file: `memory/${dateStr}-0900.md`, score: 1.0 }];
    const decayed = applyTemporalDecay(results, { enabled: true, halfLifeDays: 30 }, now);
    expect(decayed[0].score).toBeCloseTo(0.5, 1);
  });

  // --- Evergreen files ---

  it("does not decay MEMORY.md", () => {
    const results = [{ file: "MEMORY.md", score: 1.0 }];
    const decayed = applyTemporalDecay(results, { enabled: true, halfLifeDays: 30 }, now);
    expect(decayed[0].score).toBe(1.0);
  });

  it("does not decay PROFILE.md (non-dated under memory/)", () => {
    const results = [{ file: "memory/PROFILE.md", score: 1.0 }];
    const decayed = applyTemporalDecay(results, { enabled: true, halfLifeDays: 30 }, now);
    expect(decayed[0].score).toBe(1.0);
  });

  it("does not decay legacy topic files (non-dated under memory/)", () => {
    const results = [{ file: "memory/topics/environment.md", score: 1.0 }];
    const decayed = applyTemporalDecay(results, { enabled: true, halfLifeDays: 30 }, now);
    expect(decayed[0].score).toBe(1.0);
  });

  // --- Disabled / edge cases ---

  it("returns results unchanged when disabled", () => {
    const results = [{ file: "memory/2026-01-01.md", score: 1.0 }];
    const decayed = applyTemporalDecay(results, { enabled: false }, now);
    expect(decayed[0].score).toBe(1.0);
  });

  it("returns empty array for empty input", () => {
    expect(applyTemporalDecay([], {}, now)).toEqual([]);
  });
});
