import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createKnowledgeSearchTool } from "./knowledge-search.js";

function makeIndexer(result: any) {
  return {
    search: async (_q: string, _topK?: number, _minScore?: number) => result,
  } as any;
}

describe("knowledge_search tool", () => {
  let originalGatewayUrl: string | undefined;

  beforeEach(() => {
    originalGatewayUrl = process.env.SICLAW_GATEWAY_URL;
    delete process.env.SICLAW_GATEWAY_URL;
  });

  afterEach(() => {
    if (originalGatewayUrl !== undefined) process.env.SICLAW_GATEWAY_URL = originalGatewayUrl;
    else delete process.env.SICLAW_GATEWAY_URL;
    vi.restoreAllMocks();
  });

  it("has correct metadata", () => {
    const tool = createKnowledgeSearchTool(makeIndexer({ chunks: [], totalFiles: 0, totalChunks: 0 }));
    expect(tool.name).toBe("knowledge_search");
    expect(tool.label).toBe("Knowledge Search");
  });

  it("returns error on empty query", async () => {
    const tool = createKnowledgeSearchTool(makeIndexer({ chunks: [], totalFiles: 0, totalChunks: 0 }));
    const result = await tool.execute("id", { query: "   " });
    expect(JSON.parse((result.content[0] as any).text).error).toBe("Empty query");
  });

  it("returns error when no indexer and no gateway url", async () => {
    const tool = createKnowledgeSearchTool(undefined);
    const result = await tool.execute("id", { query: "x" });
    expect(JSON.parse((result.content[0] as any).text).error).toContain("Knowledge base is not available");
  });

  it("returns empty results message", async () => {
    const tool = createKnowledgeSearchTool(makeIndexer({ chunks: [], totalFiles: 0, totalChunks: 0 }));
    const result = await tool.execute("id", { query: "x" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results).toEqual([]);
    expect(parsed.message).toContain("No matching knowledge base");
  });

  it("formats result chunks with rank + rounded score", async () => {
    const tool = createKnowledgeSearchTool(makeIndexer({
      chunks: [
        { file: "runbook.md", heading: "How to debug", score: 0.75199, content: "steps..." },
      ],
      totalFiles: 1, totalChunks: 1,
    }));
    const result = await tool.execute("id", { query: "debug" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results[0].rank).toBe(1);
    expect(parsed.results[0].score).toBe(0.752);
  });

  it("clamps topK at 20", async () => {
    let requestedTopK = -1;
    const indexer = {
      search: async (_q: string, topK: number) => {
        requestedTopK = topK;
        return { chunks: [], totalFiles: 0, totalChunks: 0 };
      },
    } as any;
    const tool = createKnowledgeSearchTool(indexer);
    await tool.execute("id", { query: "x", topK: 100 });
    expect(requestedTopK).toBe(20);
  });

  it("uses default topK of 5", async () => {
    let requestedTopK = -1;
    const indexer = {
      search: async (_q: string, topK: number) => {
        requestedTopK = topK;
        return { chunks: [], totalFiles: 0, totalChunks: 0 };
      },
    } as any;
    const tool = createKnowledgeSearchTool(indexer);
    await tool.execute("id", { query: "x" });
    expect(requestedTopK).toBe(5);
  });

  it("propagates indexer.search errors", async () => {
    const failing = { search: async () => { throw new Error("embed fail"); } } as any;
    const tool = createKnowledgeSearchTool(failing);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await tool.execute("id", { query: "x" });
    expect(JSON.parse((result.content[0] as any).text).error).toContain("embed fail");
    errSpy.mockRestore();
  });

  it("truncates content to 500 chars", async () => {
    const tool = createKnowledgeSearchTool(makeIndexer({
      chunks: [{ file: "f.md", heading: "x", score: 0.5, content: "x".repeat(1000) }],
      totalFiles: 1, totalChunks: 1,
    }));
    const result = await tool.execute("id", { query: "x" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results[0].content.length).toBe(500);
  });
});
