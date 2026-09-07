import { describe, it, expect } from "vitest";
import { sampleOutputRanges, preserveOutputReferences } from "./output-sampling.js";

describe("equal-gap output sampling", () => {
  it("samples 36k with 2k edges, three 1.6k interior excerpts, and four 6.8k gaps", () => {
    const ranges = sampleOutputRanges("x".repeat(36_000));
    expect(ranges).toEqual([
      { start: 0, end: 2000 },
      { start: 8800, end: 10400 },
      { start: 17200, end: 18800 },
      { start: 25600, end: 27200 },
      { start: 34000, end: 36000 },
    ]);
  });

  it.each([
    [8000, 8000], [8001, 8000], [16000, 8000], [16001, 8000],
    [24001, 8000], [32000, 8000], [32001, 8800], [99999, 10769], [1_000_003, 11873],
  ])("keeps both ends and the expanded source budget at length %i", (length, budget) => {
    const ranges = sampleOutputRanges("x".repeat(length));
    expect(ranges).toHaveLength(Math.ceil(length / 8000));
    expect(ranges[0].start).toBe(0);
    expect(ranges.at(-1)?.end).toBe(length);
    expect(ranges.reduce((sum, r) => sum + r.end - r.start, 0)).toBe(budget);
    expect(ranges[0].end).toBeGreaterThanOrEqual(2000);
    expect(length - ranges.at(-1)!.start).toBeGreaterThanOrEqual(2000);
    const gaps = ranges.slice(1).map((r, i) => r.start - ranges[i].end);
    if (gaps.length) expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it("does not split surrogate pairs at excerpt boundaries", () => {
    const text = "a" + "🙂".repeat(18_000);
    const ranges = sampleOutputRanges(text);
    for (const r of ranges) expect(text.slice(r.start, r.end).isWellFormed()).toBe(true);
    expect(ranges[0].end).toBeGreaterThanOrEqual(2000);
    expect(text.length - ranges.at(-1)!.start).toBeGreaterThanOrEqual(2000);
    expect(ranges.reduce((sum, r) => sum + r.end - r.start, 0)).toBeLessThanOrEqual(8802);
  });

  it("preserves retrieval references without multiplying them on repeated trims", () => {
    const ref = '[siclaw-output 36000 chars; read selected lines with tool_output({"output_id":"abc"})]';
    const original = `head\n${ref}\ntail`;
    const trimmed = preserveOutputReferences(original, "[cleared]");
    expect(trimmed).toBe(`${ref}\n[cleared]`);
    expect(preserveOutputReferences(original, trimmed)).toBe(trimmed);
  });
});
