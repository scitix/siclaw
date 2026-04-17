import { describe, it, expect } from "vitest";
import { createMemorySearchTool } from "./memory-search.js";

function makeIndexer(result: any) {
  return {
    search: async (_q: string, _topK?: number, _minScore?: number) => result,
  } as any;
}

describe("memory_search tool", () => {
  it("has correct metadata", () => {
    const tool = createMemorySearchTool(makeIndexer({ chunks: [], totalFiles: 0, totalChunks: 0 }));
    expect(tool.name).toBe("memory_search");
    expect(tool.label).toBe("Memory Search");
  });

  it("returns empty query error", async () => {
    const tool = createMemorySearchTool(makeIndexer({ chunks: [], totalFiles: 0, totalChunks: 0 }));
    const result = await tool.execute("id", { query: "   " });
    expect(JSON.parse((result.content[0] as any).text).error).toBe("Empty query");
  });

  it("returns no-results message when chunks empty", async () => {
    const tool = createMemorySearchTool(makeIndexer({ chunks: [], totalFiles: 5, totalChunks: 10 }));
    const result = await tool.execute("id", { query: "anything" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results).toEqual([]);
    expect(parsed.message).toContain("No matching memories");
    expect(parsed.totalFiles).toBe(5);
  });

  it("formats chunks with citation for single line", async () => {
    const tool = createMemorySearchTool(makeIndexer({
      chunks: [{
        file: "note.md", startLine: 5, endLine: 5,
        heading: "Goal", score: 0.9123, content: "text",
      }],
      totalFiles: 1, totalChunks: 1,
    }));
    const result = await tool.execute("id", { query: "x" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results[0].citation).toBe("note.md#L5");
    expect(parsed.results[0].rank).toBe(1);
    expect(parsed.results[0].score).toBe(0.912);
  });

  it("formats chunks with range citation for multi-line", async () => {
    const tool = createMemorySearchTool(makeIndexer({
      chunks: [{
        file: "note.md", startLine: 5, endLine: 10,
        heading: "G", score: 0.5, content: "t",
      }],
      totalFiles: 1, totalChunks: 1,
    }));
    const result = await tool.execute("id", { query: "x" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results[0].citation).toBe("note.md#L5-L10");
  });

  it("omits line range citation when startLine is 0", async () => {
    const tool = createMemorySearchTool(makeIndexer({
      chunks: [{ file: "f.md", startLine: 0, endLine: 0, heading: "", score: 0.4, content: "x" }],
      totalFiles: 1, totalChunks: 1,
    }));
    const result = await tool.execute("id", { query: "x" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results[0].citation).toBe("f.md");
  });

  it("truncates content to 500 chars", async () => {
    const big = "x".repeat(1000);
    const tool = createMemorySearchTool(makeIndexer({
      chunks: [{ file: "f.md", startLine: 1, endLine: 1, heading: "", score: 0.5, content: big }],
      totalFiles: 1, totalChunks: 1,
    }));
    const result = await tool.execute("id", { query: "x" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results[0].content.length).toBe(500);
  });

  it("propagates indexer.search errors", async () => {
    const failing = {
      search: async () => { throw new Error("embed service down"); },
    } as any;
    const tool = createMemorySearchTool(failing);
    const result = await tool.execute("id", { query: "anything" });
    expect(JSON.parse((result.content[0] as any).text).error).toContain("embed service down");
  });
});
