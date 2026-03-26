import { describe, it, expect } from "vitest";
import { processToolOutput } from "./tool-render.js";

describe("processToolOutput", () => {
  it("returns text unchanged when under MAX_CHARS", () => {
    const text = "short output";
    expect(processToolOutput(text)).toBe(text);
  });

  it("returns text unchanged at exactly MAX_CHARS", () => {
    const text = "x".repeat(8000);
    expect(processToolOutput(text)).toBe(text);
  });

  it("truncates text over MAX_CHARS with head + tail", () => {
    // Build a string that's clearly over 8000 chars
    const text = "A".repeat(5000) + "B".repeat(5000);
    const result = processToolOutput(text);

    // Should start with the first 3000 chars (all A's)
    expect(result.startsWith("A".repeat(3000))).toBe(true);

    // Should end with the last 3000 chars (all B's)
    expect(result.endsWith("B".repeat(3000))).toBe(true);

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
