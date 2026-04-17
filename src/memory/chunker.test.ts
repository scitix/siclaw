import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "./chunker.js";

describe("chunkMarkdown", () => {
  it("returns empty array for empty input", () => {
    expect(chunkMarkdown("")).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(chunkMarkdown("   \n   \n\n")).toEqual([]);
  });

  it("creates a single chunk for short content without headings", () => {
    const chunks = chunkMarkdown("Hello world. This is plain markdown text.");
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe("Hello world. This is plain markdown text.");
    expect(chunks[0].heading).toBe(""); // No heading
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(1);
  });

  it("captures heading breadcrumb from H1", () => {
    const md = "# Root\n\nSome text under root.";
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBe(1);
    expect(chunks[0].heading).toBe("Root");
  });

  it("builds breadcrumb from nested headings", () => {
    const md = ["# Top", "", "## Sub", "", "### Leaf", "", "leaf content"].join("\n");
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // The leaf section should have all 3 breadcrumbs
    const leafChunk = chunks.find((c) => c.content.includes("leaf content"));
    expect(leafChunk).toBeDefined();
    expect(leafChunk!.heading).toBe("Top > Sub > Leaf");
  });

  it("resets deeper heading levels when shallower heading appears", () => {
    const md = [
      "# A",
      "## A.1",
      "### A.1.1",
      "text-a-1-1",
      "# B",
      "text-b",
    ].join("\n");
    const chunks = chunkMarkdown(md);
    const bChunk = chunks.find((c) => c.content.includes("text-b"));
    expect(bChunk).toBeDefined();
    expect(bChunk!.heading).toBe("B");
  });

  it("splits sections exceeding maxTokens with overlap", () => {
    // Each line ~100 chars => ~25 tokens. Build 20 lines under one heading.
    const bigText = Array.from({ length: 20 }, (_, i) => `line-${i} ` + "x".repeat(80)).join("\n");
    const md = `# Big\n\n${bigText}`;
    const chunks = chunkMarkdown(md, { maxTokens: 100, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    // All chunks under the same heading
    for (const c of chunks) {
      expect(c.heading).toBe("Big");
    }
    // Chunks should have valid line ranges
    for (const c of chunks) {
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
    }
  });

  it("produces line numbers that are 1-indexed and monotonic", () => {
    const md = [
      "# One",
      "content line 2",
      "# Two",
      "content line 4",
    ].join("\n");
    const chunks = chunkMarkdown(md);
    expect(chunks[0].startLine).toBeGreaterThanOrEqual(1);
    // Chunks from different sections should start at different lines
    if (chunks.length >= 2) {
      expect(chunks[1].startLine).toBeGreaterThan(chunks[0].startLine);
    }
  });

  it("supports options { maxTokens, overlapTokens } (uses defaults when omitted)", () => {
    const md = "# X\n\ncontent";
    const defaults = chunkMarkdown(md);
    const custom = chunkMarkdown(md, { maxTokens: 500, overlapTokens: 50 });
    expect(defaults.length).toBe(1);
    expect(custom.length).toBe(1);
  });

  it("skips sections that are heading-only with no body (no empty chunks)", () => {
    const md = "# Empty Section\n\n# Populated\n\nsome text";
    const chunks = chunkMarkdown(md);
    // No chunk should have empty content
    for (const c of chunks) {
      expect(c.content.length).toBeGreaterThan(0);
    }
  });

  it("treats sentinel line numbers correctly for multi-section input", () => {
    const md = ["# H1", "body-a", "", "## H2", "body-b"].join("\n");
    const chunks = chunkMarkdown(md);
    // Every chunk's endLine must be <= total lines (5)
    for (const c of chunks) {
      expect(c.endLine).toBeLessThanOrEqual(5);
      expect(c.startLine).toBeGreaterThanOrEqual(1);
    }
  });

  it("handles headings with trailing whitespace / extra hashes", () => {
    const md = "###   Spaced Title   \n\nbody";
    const chunks = chunkMarkdown(md);
    expect(chunks[0].heading).toBe("Spaced Title");
  });

  it("rejects invalid heading (7+ hashes) as plain text", () => {
    // ATX limit is 6 hashes; our regex is {1,6}. More hashes → treated as text.
    const md = "####### not a heading\n\nfollowed by content";
    const chunks = chunkMarkdown(md);
    // No heading extracted
    expect(chunks[0].heading).toBe("");
  });
});
