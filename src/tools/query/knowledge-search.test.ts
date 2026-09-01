import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryIndexer } from "../../memory/indexer.js";
import type { EmbeddingProvider } from "../../memory/types.js";
import { KnowledgeLabelIndex } from "../../knowledge/labels.js";
import { KnowledgeResolver } from "../../knowledge/resolver.js";
import { createKnowledgeSearchTool } from "./knowledge-search.js";

const noEmbedding: EmbeddingProvider = {
  model: "fts-only",
  dimensions: 1,
  async embed() {
    return [];
  },
};

describe("knowledge_search", () => {
  let root: string;
  let knowledgeDir: string;
  let indexer: MemoryIndexer;
  let resolver: KnowledgeResolver;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-knowledge-search-"));
    knowledgeDir = path.join(root, "knowledge");
    fs.mkdirSync(knowledgeDir, { recursive: true });
    indexer = new MemoryIndexer(
      path.join(root, "knowledge-index.db"),
      knowledgeDir,
      noEmbedding,
      { temporalDecay: { enabled: false }, mmr: { enabled: true, lambda: 0.75 } },
    );
    resolver = new KnowledgeResolver(new KnowledgeLabelIndex(knowledgeDir), indexer);
  });

  afterEach(async () => {
    await resolver.waitForContentIndex();
    resolver.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds a relevant page by body terms without requiring its document title", async () => {
    fs.writeFileSync(
      path.join(knowledgeDir, "nvshmem-install.md"),
      "# NVSHMEM installation\n\nFor IBGDA transport, set NVSHMEM_IB_ENABLE_IBGDA=true before launch.",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "nccl-generic.md"),
      "# Generic NCCL settings\n\nUse the standard socket configuration for ordinary jobs.",
    );
    await resolver.sync();
    await resolver.waitForContentIndex();

    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-1", { query: "IBGDA 怎么启用", topK: 5 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.results[0]).toMatchObject({
      file: "nvshmem-install.md",
      heading: "NVSHMEM installation",
    });
    expect(payload.results[0].content).toContain("NVSHMEM_IB_ENABLE_IBGDA");
    expect(payload.results[0].startLine).toBeGreaterThan(0);
  });

  it("keeps keyword retrieval available when semantic embeddings are unavailable", async () => {
    fs.writeFileSync(
      path.join(knowledgeDir, "gpu-acceptance.md"),
      "# GPU acceptance tool\n\nRun the R595 acceptance workflow for RTX 5090 nodes.",
    );
    await resolver.sync();
    await resolver.waitForContentIndex();

    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-2", { query: "5090 R595 验收", topK: 3 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].file).toBe("gpu-acceptance.md");
    expect(payload.mode).toBe("content");
  });

  it("returns an explicit empty result instead of inventing a page", async () => {
    fs.writeFileSync(path.join(knowledgeDir, "network.md"), "# Network\n\nRoCE configuration.");
    await resolver.sync();
    await resolver.waitForContentIndex();

    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-3", { query: "unrelated-unique-token" });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.results).toEqual([]);
    expect(payload.message).toContain("No matching knowledge pages");
  });

  it("routes by page labels before the content index finishes hydrating", async () => {
    fs.writeFileSync(
      path.join(knowledgeDir, "b300-lstm.md"),
      "---\ntype: Benchmark\ntitle: B300 LSTM evaluation\nlabels:\n" +
      "  - facet: entity\n    value: B300\n" +
      "  - facet: topic\n    value: CUDA Graph\n    aliases: [cudagraph]\n" +
      "  - facet: task\n    value: performance evaluation\n---\n" +
      "# B300 LSTM evaluation\n\nMeasured FP32 results.",
    );
    await resolver.sync();

    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-label", { query: "B300 cudagraph 实测数据" });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.mode).toBe("labels");
    expect(payload.contentIndexReady).toBe(false);
    expect(payload.results[0].file).toBe("b300-lstm.md");
    expect(payload.results[0].matchedLabels).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "B300" }),
      expect.objectContaining({ value: "CUDA Graph", matchedBy: "cudagraph" }),
    ]));
    expect(payload.results[0].labels).toHaveLength(3);
  });

  it("keeps content candidates when a broad label matches more pages than topK", async () => {
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(
        path.join(knowledgeDir, `gpu-${i}.md`),
        `---\ntype: Topic\nlabels:\n  - facet: topic\n    value: GPU\n---\n# GPU ${i}\n\nGeneric notes.`,
      );
    }
    fs.writeFileSync(
      path.join(knowledgeDir, "content-only.md"),
      "# Content evidence\n\nGPU uniquefault diagnosis procedure.",
    );
    await resolver.sync();
    await resolver.waitForContentIndex();

    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-peer-signals", { query: "GPU uniquefault", topK: 2 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.mode).toBe("labels+content");
    expect(payload.results.map((row: { file: string }) => row.file)).toContain("content-only.md");
  });

  it("lists the complete typed label catalog through the same QA tool", async () => {
    fs.writeFileSync(
      path.join(knowledgeDir, "labels.md"),
      "---\ntype: Topic\nlabels:\n  - facet: entity\n    value: B300\n    aliases: [GB300]\n" +
      "  - facet: environment\n    value: siflow-test\n---\n# Labels\n",
    );
    await resolver.sync();

    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-catalog", { listLabels: true, limit: 100 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.mode).toBe("label_catalog");
    expect(payload.totalLabels).toBe(2);
    expect(payload.hasMore).toBe(false);
    expect(payload.labels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        facet: "entity",
        value: "B300",
        pages: ["labels.md"],
        pagesTruncated: false,
      }),
    ]));
  });

  it("rejects an unknown label facet instead of returning an empty catalog", async () => {
    await resolver.sync();
    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-invalid-facet", { listLabels: true, facet: "product" });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.error).toContain("Unknown label facet");
    expect(payload.allowedFacets).toContain("entity");
  });
});
