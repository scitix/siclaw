import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryIndexer } from "../../memory/indexer.js";
import type { EmbeddingProvider } from "../../memory/types.js";
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
  });

  afterEach(() => {
    indexer.close();
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
    await indexer.sync();

    const tool = createKnowledgeSearchTool(indexer);
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
    await indexer.sync();

    const tool = createKnowledgeSearchTool(indexer);
    const result = await tool.execute("call-2", { query: "5090 R595 验收", topK: 3 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].file).toBe("gpu-acceptance.md");
    expect(payload.mode).toBe("hybrid");
  });

  it("returns an explicit empty result instead of inventing a page", async () => {
    fs.writeFileSync(path.join(knowledgeDir, "network.md"), "# Network\n\nRoCE configuration.");
    await indexer.sync();

    const tool = createKnowledgeSearchTool(indexer);
    const result = await tool.execute("call-3", { query: "unrelated-unique-token" });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.results).toEqual([]);
    expect(payload.message).toContain("No matching knowledge pages");
  });
});
