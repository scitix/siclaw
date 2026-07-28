import { describe, expect, it, vi } from "vitest";
import { buildKnowledgeRuntime } from "./runtime.js";
import type { KnowledgeRuntimeBinding } from "./contracts.js";

const wikiBinding: KnowledgeRuntimeBinding = {
  repoId: "wiki-1",
  name: "Operations Wiki",
  version: "3",
  capabilities: [{ kind: "materialized", contract: "knowledge.materialize/v1", rootPath: "." }],
};

const retrievalBinding: KnowledgeRuntimeBinding = {
  repoId: "ticket-1",
  name: "Ticket History",
  description: "Resolved incidents",
  version: "index-7",
  capabilities: [{ kind: "retrieve", contract: "knowledge.retrieve/v1", features: ["citation"] }],
};

describe("buildKnowledgeRuntime", () => {
  it("keeps wiki-only bindings file-native without adding a retrieval tool", () => {
    const runtime = buildKnowledgeRuntime({ bindings: [wikiBinding], knowledgeDir: "/tmp/kb" });
    expect(runtime.tools).toEqual([]);
    expect(runtime.materializedRoots).toEqual(["/tmp/kb"]);
    expect(runtime.promptContext).toContain("Operations Wiki");
  });

  it("adds one stable retrieval tool for one or more retrieval bindings", async () => {
    const retrieve = vi.fn(async () => ({
      retrievalId: "ret-1",
      evidence: [{
        repoId: "ticket-1",
        sourceId: "INC-42",
        title: "GPU scheduling incident",
        content: "Restarted the device plugin.",
        citation: { url: "https://tickets.example/INC-42" },
      }],
    }));
    const runtime = buildKnowledgeRuntime({ bindings: [wikiBinding, retrievalBinding], retrieve });
    expect(runtime.tools.map((tool) => tool.name)).toEqual(["knowledge_retrieve"]);
    expect(runtime.promptContext).toContain("Wiki");
    expect(runtime.promptContext).toContain("retrieval");

    const result = await runtime.tools[0].execute("call-1", { query: "GPU scheduling" });
    expect(retrieve).toHaveBeenCalledWith({
      query: "GPU scheduling",
      repoIds: ["ticket-1"],
      filters: undefined,
      topK: undefined,
    }, undefined);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      retrievalId: "ret-1",
      evidence: [{ sourceId: "INC-42" }],
    });
  });

  it("rejects an unbound repo before crossing the retrieval seam", async () => {
    const retrieve = vi.fn();
    const runtime = buildKnowledgeRuntime({ bindings: [retrievalBinding], retrieve });
    const result = await runtime.tools[0].execute("call-1", {
      query: "secret",
      repo_ids: ["not-bound"],
    });
    expect(retrieve).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain("not bound");
  });
});
