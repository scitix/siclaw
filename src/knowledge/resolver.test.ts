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

function pageReader(pages: Record<string, string>) {
  return vi.fn(async (absolutePath: string) => pages[path.basename(absolutePath)]);
}

describe("KnowledgeResolver", () => {
  it("returns one unique high-confidence page and reads it only after metadata inspection", async () => {
    const indexer = indexReturning([
      { file: "b200.md", heading: "B200 driver upgrade", content: "B200 Ubuntu driver upgrade", startLine: 8, endLine: 12, score: 0.91 },
      { file: "b200.md", heading: "Verify", content: "B200 Ubuntu driver upgrade verify", startLine: 30, endLine: 35, score: 0.83 },
      { file: "generic.md", heading: "Driver basics", content: "generic driver information", startLine: 3, endLine: 5, score: 0.72 },
    ]);
    const pages = {
      "b200.md": "---\ntitle: B200 Ubuntu driver upgrade\ndescription: Upgrade a B200 driver on Ubuntu\ntags: [B200, Ubuntu, driver, upgrade]\n---\n# B200 Ubuntu driver upgrade\n\nUpgrade and verify.",
      "generic.md": "---\ntitle: Driver basics\ndescription: Generic driver concepts\n---\n# Driver basics\n",
    };
    const inspectPage = pageReader(pages);
    const readPage = pageReader(pages);
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      inspectPage,
      readPage,
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("B200 Ubuntu driver upgrade");

    expect(result.status).toBe("direct_hit");
    expect(result.mode).toBe("accelerator");
    expect(result.wikiRoot).toBe(knowledgeDir);
    expect(result.indexPath).toBe(path.join(knowledgeDir, "index.md"));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      file: "b200.md",
      readPath: path.join(knowledgeDir, "b200.md"),
      title: "B200 Ubuntu driver upgrade",
      score: 0.91,
      routingConfidence: 0.982,
      metadataScore: 1,
      readMode: "full_page",
      truncated: false,
      metadata: { tags: ["B200", "Ubuntu", "driver", "upgrade"] },
    });
    expect(result.results[0].resultId).toMatch(/^[a-f0-9]{64}$/);
    expect(indexer.search).toHaveBeenCalledOnce();
    expect(indexer.search).toHaveBeenCalledWith("B200 Ubuntu driver upgrade", 40, 0.35);
    expect(inspectPage).toHaveBeenCalledTimes(2);
    expect(readPage).toHaveBeenCalledOnce();
    expect(readPage).toHaveBeenCalledWith(path.join(knowledgeDir, "b200.md"));
  });

  it("uses navigation pages only as exploration context", async () => {
    const indexer = indexReturning([
      { file: "index.md", heading: "Knowledge index", content: "GPU SOP upgrade", startLine: 1, endLine: 4, score: 0.97 },
      { file: "ops/gpu.md", heading: "GPU SOP upgrade", content: "GPU SOP upgrade", startLine: 1, endLine: 8, score: 0.9 },
    ]);
    const pages = {
      "gpu.md": "---\ntitle: GPU SOP upgrade\ndescription: GPU SOP upgrade steps\n---\n# GPU SOP upgrade\n\nExecute and verify.\n",
    };
    const inspectPage = pageReader(pages);
    const readPage = pageReader(pages);
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      inspectPage,
      readPage,
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("GPU SOP upgrade");

    expect(result.status).toBe("direct_hit");
    expect(result.results.map((page) => page.file)).toEqual(["ops/gpu.md"]);
    expect(result.navigationResults).toEqual([expect.objectContaining({ file: "index.md" })]);
    expect(result.navigationResults?.[0].readPath).toBe(path.join(knowledgeDir, "index.md"));
    expect(readPage).not.toHaveBeenCalledWith(path.join(knowledgeDir, "index.md"));
  });

  it("selects catcher over the tangential sichek SOP for a model-id request", async () => {
    const indexer = indexReturning([
      { file: "sichek.md", heading: "Server check", content: "server hardware configuration status", startLine: 1, endLine: 8, score: 0.93 },
      { file: "catcher.md", heading: "Catcher", content: "catcher server configuration model id", startLine: 1, endLine: 8, score: 0.86 },
    ]);
    const pages = {
      "sichek.md": "---\ntitle: Sicheck health SOP\ndescription: Inspect server hardware and software status\ntags: [sichek, health]\n---\n# Sicheck health SOP\n",
      "catcher.md": "---\ntitle: Catcher server configuration and model ID\ndescription: Catch server configuration and generate a model ID\ntags: [catcher, server, configuration, model]\n---\n# Catcher server configuration and model ID\n",
    };
    const inspectPage = pageReader(pages);
    const readPage = pageReader(pages);
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      inspectPage,
      readPage,
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("catcher server configuration model id");

    expect(result).toMatchObject({
      status: "direct_hit",
      results: [{ file: "catcher.md" }],
    });
    expect(readPage).toHaveBeenCalledOnce();
    expect(readPage).toHaveBeenCalledWith(path.join(knowledgeDir, "catcher.md"));
  });

  it("lets maintained question examples accelerate a clear semantic alias", async () => {
    const indexer = indexReturning([
      { file: "gsp-disable.md", heading: "GSP disable", content: "关掉 GSP 怎么操作", startLine: 1, endLine: 8, score: 0.87 },
    ]);
    const pages = {
      "gsp-disable.md": "---\ntitle: GSP 禁用方法\ndescription: 禁用 GPU System Processor\ntags: [GSP, 禁用]\nexample_questions: [关掉 GSP 怎么操作]\n---\n# GSP 禁用方法\n",
    };
    const inspectPage = pageReader(pages);
    const readPage = pageReader(pages);
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      inspectPage,
      readPage,
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("关掉 GSP 怎么操作");

    expect(result).toMatchObject({
      status: "direct_hit",
      results: [{ file: "gsp-disable.md", metadataScore: 1 }],
    });
    expect(readPage).toHaveBeenCalledOnce();
  });

  it("does not promote a weak tangential match into answer evidence", async () => {
    const indexer = indexReturning([
      { file: "sichek.md", heading: "Server check", content: "server configuration status and a related catcher link", startLine: 1, endLine: 8, score: 0.94 },
    ]);
    const pages = {
      "sichek.md": "---\ntitle: Sicheck health SOP\ndescription: Inspect server hardware status\ntags: [sichek, health]\n---\n# Sicheck health SOP\n",
    };
    const inspectPage = pageReader(pages);
    const readPage = pageReader(pages);
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      inspectPage,
      readPage,
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("generate server model automatically");

    expect(result.status).toBe("explore");
    expect(result.results).toEqual([]);
    expect(result.explorationHints).toEqual([expect.objectContaining({ file: "sichek.md" })]);
    expect(result.message).toContain("unverified leads");
    expect(readPage).not.toHaveBeenCalled();
  });

  it("does not direct-hit an opposite-action page after FTS drops negation", async () => {
    const indexer = indexReturning([
      { file: "enable-gsp.md", heading: "Enable GSP", content: "Enable GSP", startLine: 1, endLine: 5, score: 0.98 },
    ]);
    const body = "---\ntitle: Enable GSP\ndescription: Enable GSP on supported GPUs\n---\n# Enable GSP\n";
    const readPage = vi.fn(async () => body);
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      inspectPage: vi.fn(async () => body),
      readPage,
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("do not enable GSP");

    expect(result.status).toBe("explore");
    expect(result.results).toEqual([]);
    expect(readPage).not.toHaveBeenCalled();
  });

  it("does not direct-hit a page for a different requested version or year", async () => {
    const indexer = indexReturning([
      { file: "b200-2025.md", heading: "B200 driver upgrade 2025", content: "B200 driver upgrade 2025", startLine: 1, endLine: 5, score: 0.98 },
    ]);
    const body = "---\ntitle: B200 driver upgrade 2025\ndescription: B200 driver upgrade for the 2025 baseline\n---\n# B200 driver upgrade 2025\n";
    const readPage = vi.fn(async () => body);
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      inspectPage: vi.fn(async () => body),
      readPage,
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("B200 driver upgrade 2026");

    expect(result.status).toBe("explore");
    expect(result.results).toEqual([]);
    expect(readPage).not.toHaveBeenCalled();
  });

  it("preserves versions attached directly to a product name", async () => {
    const indexer = indexReturning([
      { file: "cuda-12-5.md", heading: "CUDA12.5 install", content: "CUDA12.5 install", startLine: 1, endLine: 5, score: 0.99 },
    ]);
    const body = "---\ntitle: CUDA12.5 install\ndescription: Install CUDA12.5\n---\n# CUDA12.5 install\n";
    const readPage = vi.fn(async () => body);
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      inspectPage: vi.fn(async () => body),
      readPage,
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("CUDA12.4 install");

    expect(result.status).toBe("explore");
    expect(readPage).not.toHaveBeenCalled();
  });

  it("leaves two similarly strong pages for Agent-led exploration", async () => {
    const indexer = indexReturning([
      { file: "b200-v1.md", heading: "B200 driver upgrade", content: "B200 Ubuntu driver upgrade", startLine: 1, endLine: 8, score: 0.9 },
      { file: "b200-v2.md", heading: "B200 driver upgrade", content: "B200 Ubuntu driver upgrade", startLine: 1, endLine: 8, score: 0.88 },
    ]);
    const pages = {
      "b200-v1.md": "---\ntitle: B200 Ubuntu driver upgrade\ndescription: B200 Ubuntu driver upgrade version one\n---\n# Version one\n",
      "b200-v2.md": "---\ntitle: B200 Ubuntu driver upgrade\ndescription: B200 Ubuntu driver upgrade version two\n---\n# Version two\n",
    };
    const inspectPage = pageReader(pages);
    const readPage = pageReader(pages);
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      inspectPage,
      readPage,
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("B200 Ubuntu driver upgrade");

    expect(result.status).toBe("explore");
    expect(result.results).toEqual([]);
    expect(result.explorationHints?.map((hint) => ({ rank: hint.rank, file: hint.file }))).toEqual([
      { rank: 1, file: "b200-v1.md" },
      { rank: 2, file: "b200-v2.md" },
    ]);
    expect(result.message).toContain("Several pages plausibly match");
    expect(readPage).not.toHaveBeenCalled();
  });

  it("does not rewrite or retry a query when no safe direct candidate exists", async () => {
    const indexer = indexReturning([]);
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      inspectPage: vi.fn(),
      readPage: vi.fn(),
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("unknown operational topic");

    expect(result).toMatchObject({
      status: "explore",
      results: [],
    });
    expect(result.message).toContain("not evidence that the Wiki lacks an answer");
    expect(indexer.search).toHaveBeenCalledOnce();
    expect(indexer.search).toHaveBeenCalledWith("unknown operational topic", 40, 0.35);
  });

  it("keeps an oversized page as an unverified exploration lead", async () => {
    const marker = '<!-- okf:evidence {"id":"step-1","sources":["source-1"]} -->';
    const target = "## B200 driver upgrade\nRun the B200 driver upgrade command.";
    const filler = Array.from({ length: 900 }, () => "Background material.").join("\n");
    const indexer = indexReturning([
      { file: "large.md", heading: "B200 driver upgrade", content: target, startLine: 907, endLine: 908, score: 0.95 },
    ]);
    const body = `---\ntitle: B200 driver upgrade\ndescription: B200 driver upgrade procedure\n---\n# B200 driver upgrade\n${filler}\n${marker}\n${target}`;
    const inspectPage = vi.fn(async () => body);
    const readPage = vi.fn(async () => body);
    const budget = 600;
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      inspectPage,
      readPage,
      evidenceBudgetCharsRef: { current: budget },
    });

    const result = await resolver.lookup("B200 driver upgrade");
    expect(result.status).toBe("explore");
    expect(result.results).toEqual([]);
    expect(result.explorationHints).toEqual([expect.objectContaining({
      file: "large.md",
      readPath: path.join(knowledgeDir, "large.md"),
    })]);
    expect(result.message).toContain("too large");
    expect(readPage).not.toHaveBeenCalled();
  });

  it("does not allow an index candidate to escape the mounted knowledge directory", async () => {
    const indexer = indexReturning([
      { file: "../secret.md", heading: "secret topic", content: "secret topic", startLine: 1, endLine: 1, score: 1 },
    ]);
    const readPage = vi.fn(async () => "secret");
    const resolver = createKnowledgeResolver({
      indexer,
      knowledgeDir,
      inspectPage: vi.fn(async () => "secret"),
      readPage,
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("secret topic");

    expect(result.status).toBe("unavailable");
    expect(result.results).toEqual([]);
    expect(readPage).not.toHaveBeenCalled();
  });

  it("reports accelerator failures without claiming the Wiki is unavailable", async () => {
    const resolver = createKnowledgeResolver({
      indexer: { search: vi.fn(async () => { throw new Error("index offline"); }) },
      knowledgeDir,
      inspectPage: vi.fn(),
      readPage: vi.fn(),
      evidenceBudgetCharsRef: { current: 8_000 },
    });

    const result = await resolver.lookup("GPU");

    expect(result).toMatchObject({ status: "unavailable", results: [] });
    expect(result.message).toContain("retrieval accelerator is unavailable");
    expect(result.message).toContain("does not mean the knowledge is absent");
  });
});
