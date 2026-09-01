import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createKnowledgeResolver } from "./resolver.js";
import type { KnowledgeSearchIndex } from "./resolver-types.js";

const knowledgeDir = path.resolve("/tmp/siclaw-knowledge-resolver-test");

function indexReturning(chunks: Awaited<ReturnType<KnowledgeSearchIndex["search"]>>["chunks"]): KnowledgeSearchIndex {
  return {
    search: vi.fn(async () => ({ chunks, totalFiles: 4, totalChunks: chunks.length })),
  };
}

describe("KnowledgeResolver", () => {
  it("aggregates chunks by leaf page and reads each selected page once", async () => {
    const indexer = indexReturning([
      { file: "gpu.md", heading: "升级前", content: "check", startLine: 8, endLine: 12, score: 0.91 },
      { file: "gpu.md", heading: "升级后", content: "verify", startLine: 30, endLine: 35, score: 0.83 },
      { file: "network.md", heading: "RoCE", content: "roce", startLine: 3, endLine: 5, score: 0.72 },
    ]);
    const readPage = vi.fn(async (absolutePath: string) => absolutePath.endsWith("gpu.md")
      ? "---\ntitle: GPU 驱动升级\ntags: [GPU, driver]\n---\n# GPU 驱动升级\n\n升级前检查，升级后验收。"
      : "# RoCE\n\n网络检查。\n");
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      readPage,
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("GPU 驱动怎么升级");

    expect(result.status).toBe("ready");
    expect(result.results.map((page) => page.file)).toEqual(["gpu.md", "network.md"]);
    expect(result.results[0]).toMatchObject({
      title: "GPU 驱动升级",
      score: 0.91,
      readMode: "full_page",
      truncated: false,
      metadata: { tags: ["GPU", "driver"] },
    });
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(readPage).toHaveBeenCalledWith(path.join(knowledgeDir, "gpu.md"));
  });

  it("uses navigation pages only as routing hints", async () => {
    const indexer = indexReturning([
      { file: "index.md", heading: "知识索引", content: "GPU GPU", startLine: 1, endLine: 4, score: 0.97 },
      { file: "ops/gpu.md", heading: "GPU SOP", content: "GPU", startLine: 1, endLine: 8, score: 0.82 },
    ]);
    const readPage = vi.fn(async () => "# GPU SOP\n\n执行升级并验收。\n");
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      readPage,
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("GPU SOP");

    expect(result.results.map((page) => page.file)).toEqual(["ops/gpu.md"]);
    expect(result.navigationResults).toEqual([
      expect.objectContaining({ file: "index.md" }),
    ]);
    expect(readPage).not.toHaveBeenCalledWith(path.join(knowledgeDir, "index.md"));
  });

  it("reranks a bounded candidate set with page metadata before registering selected reads", async () => {
    const indexer = indexReturning([
      { file: "generic.md", heading: "GPU 驱动", content: "通用说明", startLine: 1, endLine: 8, score: 0.9 },
      { file: "b200.md", heading: "升级", content: "驱动升级", startLine: 1, endLine: 8, score: 0.82 },
    ]);
    const pages: Record<string, string> = {
      "generic.md": "---\ntitle: GPU 驱动基础\ndescription: 通用概念\n---\n# GPU 驱动基础\n",
      "b200.md": "---\ntitle: B200 驱动升级 SOP\ndescription: Ubuntu 22.04 的 B200 升级步骤\ntags: [B200, Ubuntu, driver]\nenvironment: Ubuntu 22.04\n---\n# B200 驱动升级 SOP\n",
    };
    const inspectPage = vi.fn(async (absolutePath: string) => pages[path.basename(absolutePath)]);
    const readPage = vi.fn(async (absolutePath: string) => pages[path.basename(absolutePath)]);
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      inspectPage,
      readPage,
      evidenceBudgetCharsRef: { current: 8_000 },
      maxPages: 1,
      rerankCandidates: 2,
    });

    const result = await resolver.lookup("B200 Ubuntu 驱动升级 SOP");

    expect(result.results[0]).toMatchObject({ file: "b200.md", metadataScore: 1 });
    expect(inspectPage).toHaveBeenCalledTimes(2);
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(readPage).toHaveBeenCalledWith(path.join(knowledgeDir, "b200.md"));
    expect(result.results[0].resultId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses one entity-focused fallback query only when the original search has no leaf page", async () => {
    const search = vi.fn(async (query: string) => query === "请问 GPU 驱动怎么升级"
      ? {
          chunks: [{ file: "index.md", heading: "索引", content: "GPU", startLine: 1, endLine: 2, score: 0.9 }],
          totalFiles: 3,
          totalChunks: 1,
        }
      : {
          chunks: [{ file: "gpu.md", heading: "升级", content: "步骤", startLine: 1, endLine: 3, score: 0.8 }],
          totalFiles: 3,
          totalChunks: 1,
        });
    const resolver = createKnowledgeResolver({
      indexer: { search },
      knowledgeDir,
      readPage: vi.fn(async () => "# GPU 驱动升级\n\n执行步骤。"),
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("请问 GPU 驱动怎么升级");

    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenNthCalledWith(1, "请问 GPU 驱动怎么升级", 40, 0);
    expect(search).toHaveBeenNthCalledWith(2, "gpu 驱动 升级", 40, 0);
    expect(result).toMatchObject({
      status: "ready",
      queryVariants: ["请问 GPU 驱动怎么升级", "gpu 驱动 升级"],
      results: [{ file: "gpu.md" }],
    });
  });

  it("does not expand a query that already found leaf pages", async () => {
    const indexer = indexReturning([
      { file: "gpu.md", heading: "升级", content: "步骤", startLine: 1, endLine: 3, score: 0.8 },
    ]);
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      readPage: vi.fn(async () => "# GPU 驱动升级\n\n执行步骤。"),
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("GPU 驱动怎么升级");

    expect(indexer.search).toHaveBeenCalledTimes(1);
    expect(result.queryVariants).toEqual(["GPU 驱动怎么升级"]);
  });

  it("returns matched sections instead of an oversized page", async () => {
    const marker = '<!-- okf:evidence {"id":"step-1","sources":["source-1"]} -->';
    const target = "## 驱动升级\n运行升级命令。";
    const filler = Array.from({ length: 900 }, () => "背景材料。").join("\n");
    const indexer = indexReturning([
      { file: "large.md", heading: "驱动升级", content: target, startLine: 906, endLine: 907, score: 0.95 },
    ]);
    const readPage = vi.fn(async () => `---\ntitle: 超长 SOP\n---\n# 超长 SOP\n${filler}\n${marker}\n${target}`);
    const budget = 600;
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      readPage,
      evidenceBudgetCharsRef: { current: budget },
    });

    const result = await resolver.lookup("怎么升级驱动");
    const page = result.results[0];
    const returnedChars = page.sections.reduce((sum, section) => sum + section.content.length, 0);

    expect(page).toMatchObject({
      readMode: "matched_sections",
      truncated: true,
      citationMode: "evidence",
      evidenceRefs: ["large.md#step-1"],
    });
    expect(returnedChars).toBeLessThanOrEqual(budget);
    expect(page.sections[0].content).toContain(marker);
    expect(page.sections[0].content).toContain("运行升级命令");
  });

  it("does not allow an index candidate to escape the mounted knowledge directory", async () => {
    const indexer = indexReturning([
      { file: "../secret.md", heading: "secret", content: "secret", startLine: 1, endLine: 1, score: 1 },
    ]);
    const readPage = vi.fn(async () => "secret");
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      readPage,
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("secret");

    expect(result.status).toBe("unavailable");
    expect(result.results).toEqual([]);
    expect(readPage).not.toHaveBeenCalled();
  });

  it("returns not_found without inventing evidence", async () => {
    const resolver = createKnowledgeResolver({
      indexer: indexReturning([]),
      knowledgeDir,
      readPage: vi.fn(),
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    await expect(resolver.lookup("不存在的主题")).resolves.toMatchObject({
      status: "not_found",
      results: [],
      message: "No matching knowledge leaf pages found.",
    });
  });

  it("reports retrieval failures as unavailable", async () => {
    const resolver = createKnowledgeResolver({
      indexer: { search: vi.fn(async () => { throw new Error("index offline"); }) },
      knowledgeDir,
      readPage: vi.fn(),
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    await expect(resolver.lookup("GPU")).resolves.toMatchObject({
      status: "unavailable",
      results: [],
      message: "Knowledge retrieval is unavailable: index offline",
    });
  });
});
