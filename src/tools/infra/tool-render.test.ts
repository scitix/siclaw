import { describe, it, expect } from "vitest";
import { processToolOutput } from "./tool-render.js";

describe("processToolOutput", () => {
  it("reports the expanded preview size and recalculated gaps", () => {
    const result = processToolOutput("x".repeat(36000));
    expect(result).toContain("8800 sampled chars");
    expect(result).toContain("[chars 1-2000;");
    expect(result).toContain("[omitted chars 2001-8800;");
    expect(result).toContain("[chars 34001-36000;");
  });
  it("returns text unchanged when under MAX_CHARS", () => {
    const text = "short output";
    expect(processToolOutput(text)).toBe(text);
  });

  it("returns text unchanged at exactly MAX_CHARS", () => {
    const text = "x".repeat(8000);
    expect(processToolOutput(text)).toBe(text);
  });

  it("samples text over MAX_CHARS with a retrieval reference and an explicit gap", () => {
    // Build a string that's clearly over 8000 chars
    const text = "A".repeat(5000) + "B".repeat(5000);
    const result = processToolOutput(text);

    expect(result).toContain("A".repeat(4000));
    expect(result.endsWith("B".repeat(4000))).toBe(true);
    expect(result).toContain("omitted chars 4001-6000");
    expect(result).toContain('"offset":1,"limit":100');
    expect(result).toContain('lines 1-1; block 1; expand with read(');
    expect(result).toContain('"offset":1,"limit":1');

    // Should contain the truncation marker
    expect(result).toContain("output truncated");
    expect(result).toContain("lines total");

    // Should be smaller than the original
    expect(result.length).toBeLessThan(text.length);
  });

  it("includes line count in truncation message", () => {
    // Create multiline content that exceeds 8000 chars
    const lines = Array.from({ length: 500 }, (_, i) =>
      `line ${i}: ${"x".repeat(20)}`
    );
    const text = lines.join("\n");
    expect(text.length).toBeGreaterThan(8000);

    const result = processToolOutput(text);
    expect(result).toContain("500 lines total");
  });

  it("preserves content under limit even with many lines", () => {
    // Many short lines but under 8000 total chars
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const text = lines.join("\n");
    expect(text.length).toBeLessThan(8000);
    expect(processToolOutput(text)).toBe(text);
  });
});
