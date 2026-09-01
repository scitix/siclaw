import { describe, expect, it, vi } from "vitest";

import type { KnowledgeLookupResult, KnowledgeResolver } from "../../knowledge/resolver-types.js";
import { createKnowledgeSearchTool, registration } from "./knowledge-search.js";

function readyResult(query: string): KnowledgeLookupResult {
  return {
    status: "ready",
    mode: "hybrid",
    query,
    results: [{
      rank: 1,
      file: "gpu.md",
      title: "GPU SOP",
      score: 0.9,
      readMode: "full_page",
      truncated: false,
      citationMode: "page",
      sections: [{ heading: "GPU SOP", startLine: 1, endLine: 2, content: "# GPU SOP\n升级步骤" }],
    }],
  };
}

function payload(result: any): KnowledgeLookupResult {
  return JSON.parse((result.content[0] as { text: string }).text) as KnowledgeLookupResult;
}

describe("knowledge_search", () => {
  it("returns the resolver's read evidence without exposing retrieval tuning parameters", async () => {
    const resolver: KnowledgeResolver = { lookup: vi.fn(async (query) => readyResult(query)) };
    const tool = createKnowledgeSearchTool(resolver);

    const result = await tool.execute("call-1", { query: "GPU 驱动怎么升级" });

    expect(resolver.lookup).toHaveBeenCalledWith("GPU 驱动怎么升级");
    expect(payload(result)).toMatchObject({ status: "ready", results: [{ file: "gpu.md" }] });
    expect((tool.parameters as any).properties).toEqual({
      query: expect.any(Object),
    });
  });

  it("reuses the first lookup in the same turn and refreshes on the next turn", async () => {
    const resolver: KnowledgeResolver = { lookup: vi.fn(async (query) => readyResult(query)) };
    const turnRef = { current: 7 };
    const tool = createKnowledgeSearchTool(resolver, turnRef);

    const first = await tool.execute("call-1", { query: "first" });
    const repeated = await tool.execute("call-2", { query: "rewritten" });
    turnRef.current += 1;
    const nextTurn = await tool.execute("call-3", { query: "next" });

    expect(resolver.lookup).toHaveBeenCalledTimes(2);
    expect(payload(first).query).toBe("first");
    expect(payload(repeated).query).toBe("first");
    expect(repeated.details).toMatchObject({ reused: true });
    expect(payload(nextTurn).query).toBe("next");
  });

  it("is registered only when a KnowledgeResolver is available", () => {
    expect(registration.available?.({ knowledgeResolver: undefined } as any)).toBe(false);
    expect(registration.available?.({ knowledgeResolver: { lookup: vi.fn() } } as any)).toBe(true);
  });
});
