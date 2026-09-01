import { describe, expect, it, vi } from "vitest";

import type { KnowledgeLookupResult, KnowledgeResolver } from "../../knowledge/resolver-types.js";
import { createKnowledgeSearchTool, registration } from "./knowledge-search.js";

function directHitResult(query: string): KnowledgeLookupResult {
  return {
    status: "direct_hit",
    mode: "accelerator",
    query,
    wikiRoot: ".siclaw/knowledge/a",
    indexPath: ".siclaw/knowledge/a/index.md",
    results: [{
      rank: 1,
      file: "gpu.md",
      readPath: ".siclaw/knowledge/a/gpu.md",
      title: "GPU SOP",
      score: 0.9,
      routingConfidence: 0.95,
      readMode: "full_page",
      truncated: false,
      citationMode: "page",
      sections: [{ heading: "GPU SOP", startLine: 1, endLine: 2, content: "# GPU SOP\n升级步骤" }],
    }],
  };
}

function payload(result: any): any {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe("knowledge_search", () => {
  it("returns the resolver's direct-hit snapshot without exposing retrieval tuning parameters", async () => {
    const resolver: KnowledgeResolver = { lookup: vi.fn(async (query) => directHitResult(query)) };
    const tool = createKnowledgeSearchTool(resolver);

    const result = await tool.execute("call-1", { query: "GPU 驱动怎么升级" });

    expect(resolver.lookup).toHaveBeenCalledWith("GPU 驱动怎么升级");
    expect(payload(result)).toMatchObject({ status: "direct_hit", results: [{ file: "gpu.md" }] });
    expect((tool.parameters as any).properties).toEqual({
      query: expect.any(Object),
    });
    expect(tool.description).toContain("returned indexPath");
    expect(tool.description).not.toContain(".siclaw/knowledge/index.md");
  });

  it("reuses the first lookup in the same turn and refreshes on the next turn", async () => {
    const resolver: KnowledgeResolver = { lookup: vi.fn(async (query) => directHitResult(query)) };
    const turnRef = { current: 7 };
    const tool = createKnowledgeSearchTool(resolver, turnRef);

    const first = await tool.execute("call-1", { query: "first" });
    const repeated = await tool.execute("call-2", { query: "rewritten" });
    turnRef.current += 1;
    const nextTurn = await tool.execute("call-3", { query: "next" });

    expect(resolver.lookup).toHaveBeenCalledTimes(2);
    expect(payload(first).query).toBe("first");
    expect(payload(repeated)).toEqual({
      status: "already_resolved",
      wikiRoot: ".siclaw/knowledge/a",
      indexPath: ".siclaw/knowledge/a/index.md",
      message: "The retrieval accelerator was already used this turn. Do not call it again; validate the direct page or continue Wiki exploration with Find/Grep/Read.",
    });
    expect(repeated.details).toMatchObject({ reused: true, resultCount: 1 });
    expect(payload(nextTurn).query).toBe("next");
  });

  it("is registered only when a KnowledgeResolver is available", () => {
    expect(registration.available?.({ knowledgeResolver: undefined } as any)).toBe(false);
    expect(registration.available?.({ knowledgeResolver: { lookup: vi.fn() } } as any)).toBe(true);
  });
});
