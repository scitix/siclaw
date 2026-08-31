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

  it("returns the GSP leaf page instead of treating a matching index as answer evidence", async () => {
    fs.mkdirSync(path.join(knowledgeDir, "运维"), { recursive: true });
    fs.writeFileSync(
      path.join(knowledgeDir, "运维", "_index.md"),
      "# 运维索引\n\nGSP GSP GSP GPU 固件关闭方法：参见 [GSP 禁用方法](GSP禁用方法.md)。",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "运维", "GSP禁用方法.md"),
      "# NVIDIA GSP 固件禁用方法\n\n宿主机设置 NVreg_EnableGpuFirmware=0，然后更新 initramfs 并重启。",
    );
    await indexer.sync();

    const tool = createKnowledgeSearchTool(indexer);
    const result = await tool.execute("call-gsp", { query: "关掉 GSP 怎么操作", topK: 5 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.results.map((row: { file: string }) => row.file)).toContain("运维/GSP禁用方法.md");
    expect(payload.results.map((row: { file: string }) => row.file)).not.toContain("运维/_index.md");
    expect(payload.navigationResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "运维/_index.md" }),
    ]));
    expect(payload.navigationNotice).toContain("routing hints only");
  });

  it("reports navigation-only matches without returning them as answer candidates", async () => {
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), "# Index\n\nunique-navigation-token");
    await indexer.sync();

    const tool = createKnowledgeSearchTool(indexer);
    const result = await tool.execute("call-navigation", { query: "unique-navigation-token" });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.results).toEqual([]);
    expect(payload.navigationResults[0].file).toBe("index.md");
    expect(payload.message).toContain("Only navigation pages matched");
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
