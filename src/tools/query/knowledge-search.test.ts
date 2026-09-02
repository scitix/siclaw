import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KnowledgeLabelIndex } from "../../knowledge/labels.js";
import { KnowledgeResolver } from "../../knowledge/resolver.js";
import { createKnowledgeSearchTool } from "./knowledge-search.js";

describe("knowledge_search", () => {
  let root: string;
  let knowledgeDir: string;
  let resolver: KnowledgeResolver;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-knowledge-search-"));
    knowledgeDir = path.join(root, "knowledge");
    fs.mkdirSync(knowledgeDir, { recursive: true });
    resolver = new KnowledgeResolver(new KnowledgeLabelIndex(knowledgeDir));
  });

  afterEach(() => {
    resolver.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not search unlabeled page bodies", async () => {
    fs.writeFileSync(
      path.join(knowledgeDir, "nvshmem-install.md"),
      "# NVSHMEM installation\n\nFor IBGDA transport, set NVSHMEM_IB_ENABLE_IBGDA=true before launch.",
    );
    await resolver.sync();

    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-1", { query: "IBGDA 怎么启用", topK: 5 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.mode).toBe("labels");
    expect(payload.results).toEqual([]);
    expect(payload.message).toContain("No label-matched knowledge page");
  });

  it("returns an explicit empty result instead of inventing a page", async () => {
    fs.writeFileSync(path.join(knowledgeDir, "network.md"), "# Network\n\nRoCE configuration.");
    await resolver.sync();

    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-3", { query: "unrelated-unique-token" });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.results).toEqual([]);
    expect(payload.message).toContain("No label-matched knowledge page");
  });

  it("routes by page labels and returns navigation metadata instead of page body content", async () => {
    fs.writeFileSync(
      path.join(knowledgeDir, "index.md"),
      "# Knowledge Index\n\n- [B300 LSTM evaluation](b300-lstm.md) - Giga B300 operator benchmark\n",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "b300-lstm.md"),
      "---\ntype: Benchmark\ntitle: B300 LSTM evaluation\ndescription: Giga B300 operator benchmark\nlabels:\n" +
      "  - facet: entity\n    value: B300\n" +
      "  - facet: topic\n    value: CUDA Graph\n    aliases: [cudagraph]\n" +
      "  - facet: task\n    value: performance evaluation\n---\n" +
      "# B300 LSTM evaluation\n\nSecret measured FP32 result: 29.71 ms.",
    );
    await resolver.sync();

    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-label", { query: "B300 cudagraph 实测数据" });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.mode).toBe("labels");
    expect(payload.results[0].file).toBe("b300-lstm.md");
    expect(payload.results[0].title).toBe("B300 LSTM evaluation");
    expect(payload.results[0].description).toBe("Giga B300 operator benchmark");
    expect(payload.results[0].matchedLabels).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "B300" }),
      expect.objectContaining({ value: "CUDA Graph", matchedBy: "cudagraph" }),
    ]));
    expect(payload.results[0]).not.toHaveProperty("labels");
    expect(payload.results[0].routeProof).toEqual({
      reachable: true,
      trail: [
        { file: "index.md", kind: "catalog" },
        { file: "b300-lstm.md", kind: "leaf", via: "B300 LSTM evaluation" },
      ],
    });
    expect(payload.results[0]).not.toHaveProperty("content");
    expect(JSON.stringify(payload)).not.toContain("29.71 ms");

    const expanded = await tool.execute("call-label-expanded", {
      query: "B300 cudagraph 实测数据",
      includeLabels: true,
    });
    const expandedPayload = JSON.parse((expanded.content[0] as { text: string }).text);
    expect(expandedPayload.results[0].labels).toHaveLength(3);
  });

  it("ranks a page with more matching labels ahead of a generic page", async () => {
    fs.writeFileSync(
      path.join(knowledgeDir, "index.md"),
      "# Knowledge Index\n\n- [B300](generic-b300.md)\n- [Giga B300 LSTM](giga-b300-lstm.md)\n",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "generic-b300.md"),
      "---\ntype: Entity\ntitle: B300\nlabels:\n  - facet: entity\n    value: B300\n---\n# B300\n",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "giga-b300-lstm.md"),
      "---\ntype: Benchmark\ntitle: Giga B300 LSTM\nlabels:\n" +
      "  - facet: entity\n    value: B300\n" +
      "  - facet: component\n    value: torch.nn.LSTM\n    aliases: [LSTM]\n" +
      "  - facet: topic\n    value: CUDA Graph\n    aliases: [cudagraph]\n---\n# Result\n",
    );
    await resolver.sync();

    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-ranked", { query: "B300 LSTM cudagraph", topK: 2 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.results.map((row: { file: string }) => row.file)).toEqual([
      "giga-b300-lstm.md",
      "generic-b300.md",
    ]);
    expect(payload.results[0].score - payload.results[1].score).toBeGreaterThan(0.2);
  });

  it("downranks a generic alias that covers little of a multi-term query", async () => {
    fs.writeFileSync(
      path.join(knowledgeDir, "index.md"),
      "# Knowledge Index\n\n- [GPU driver](gpu-driver.md)\n- [Generic upgrade](generic-upgrade.md)\n",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "gpu-driver.md"),
      "---\ntype: Procedure\ntitle: GPU driver upgrade\nlabels:\n" +
      "  - facet: entity\n    value: GPU\n" +
      "  - facet: task\n    value: GPU driver installation\n    aliases: [升级GPU驱动]\n" +
      "  - facet: topic\n    value: SOP\n---\n# GPU driver\n",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "generic-upgrade.md"),
      "---\ntype: Procedure\ntitle: Generic upgrade\nlabels:\n" +
      "  - facet: task\n    value: Change management\n    aliases: [升级]\n---\n# Upgrade\n",
    );
    await resolver.sync();

    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-specific-alias", {
      query: "升级GPU驱动SOP",
      topK: 2,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.results.map((row: { file: string }) => row.file)).toEqual([
      "gpu-driver.md",
      "generic-upgrade.md",
    ]);
    expect(payload.results[0].score - payload.results[1].score).toBeGreaterThan(0.2);
  });

  it("downranks an exact alias shared across many pages and reports truncation", async () => {
    const links: string[] = [];
    for (let i = 0; i < 10; i++) {
      const file = `upgrade-${i}.md`;
      links.push(`- [Upgrade ${i}](${file})`);
      fs.writeFileSync(
        path.join(knowledgeDir, file),
        "---\ntype: Procedure\ntitle: Upgrade " + i + "\nlabels:\n" +
        `  - facet: task\n    value: Upgrade process ${i}\n    aliases: [升级]\n` +
        "---\n# Upgrade\n",
      );
    }
    fs.writeFileSync(
      path.join(knowledgeDir, "zhaoyao.md"),
      "---\ntype: Topic\ntitle: 招摇B30X\nlabels:\n" +
      "  - facet: topic\n    value: 招摇B30X\n---\n# 招摇B30X\n",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "index.md"),
      `# Knowledge Index\n\n${links.join("\n")}\n- [招摇B30X](zhaoyao.md)\n`,
    );
    await resolver.sync();

    const tool = createKnowledgeSearchTool(resolver);
    const broadResult = await tool.execute("call-broad-exact", { query: "升级" });
    const broad = JSON.parse((broadResult.content[0] as { text: string }).text);

    expect(broad.results).toHaveLength(3);
    expect(broad.matchedPages).toBe(10);
    expect(broad.hasMore).toBe(true);
    expect(broad.results.every((row: { score: number }) => row.score < 0.7)).toBe(true);
    expect(broad.results[0].matchedLabels[0].pageCount).toBe(10);
    expect(broad.message).toContain("Weak or ambiguous label match");

    const rareResult = await tool.execute("call-rare-exact", { query: "招摇B30X" });
    const rare = JSON.parse((rareResult.content[0] as { text: string }).text);
    expect(rare.results[0].score).toBe(1);
    expect(rare.results[0].matchedLabels[0].pageCount).toBe(1);
    expect(rare.matchedPages).toBe(1);
    expect(rare.hasMore).toBe(false);
    expect(rare).not.toHaveProperty("message");
  });

  it("does not route to a labeled page that is unreachable from the root catalog", async () => {
    fs.writeFileSync(
      path.join(knowledgeDir, "index.md"),
      "# Knowledge Index\n\n- [Published B300 guide](published.md)\n",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "published.md"),
      "---\ntype: Topic\ntitle: Published B300 guide\nlabels:\n  - facet: entity\n    value: B300\n---\n# Published\n",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "orphan.md"),
      "---\ntype: Topic\ntitle: Unpublished scratch page\nlabels:\n  - facet: entity\n    value: B300\n  - facet: task\n    value: LSTM benchmark\n---\n# Scratch\n",
    );
    await resolver.sync();

    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-reachable", { query: "B300 LSTM benchmark", topK: 5 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.results.map((row: { file: string }) => row.file)).toEqual(["published.md"]);
    expect(payload.unreachableLabeledPages).toBe(1);

    const catalogResult = await tool.execute("call-reachable-catalog", {
      listLabels: true,
      includePages: true,
      limit: 100,
    });
    const catalog = JSON.parse((catalogResult.content[0] as { text: string }).text);
    expect(catalog.labels).toEqual([
      expect.objectContaining({ facet: "entity", value: "B300", pages: ["published.md"] }),
    ]);
    expect(catalog.totalPages).toBe(1);
    expect(catalog.unreachableLabeledPages).toBe(1);
  });

  it("reports invalid label declarations separately from unlabeled pages", async () => {
    fs.writeFileSync(
      path.join(knowledgeDir, "index.md"),
      "# Knowledge Index\n\n- [Valid](valid.md)\n- [Invalid](invalid.md)\n- [Unlabeled](unlabeled.md)\n",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "valid.md"),
      "---\ntype: Topic\ntitle: Valid\nlabels:\n  - facet: entity\n    value: B300\n---\n# Valid\n",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "invalid.md"),
      "---\ntype: Topic\ntitle: Invalid\nlabels:\n  - facet: unsupported\n    value: broken\n---\n# Invalid\n",
    );
    fs.writeFileSync(path.join(knowledgeDir, "unlabeled.md"), "# Unlabeled\n");
    await resolver.sync();

    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-observability", { query: "B300" });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.totalPages).toBe(1);
    expect(payload.invalidLabeledPages).toBe(1);
    expect(payload.unlabeledPages).toBe(1);
    expect(payload.unreachableLabeledPages).toBe(0);

    const catalogResult = await tool.execute("call-observability-catalog", { listLabels: true });
    const catalog = JSON.parse((catalogResult.content[0] as { text: string }).text);
    expect(catalog.invalidLabeledPages).toBe(1);
    expect(catalog.unlabeledPages).toBe(1);
  });

  it("keeps labeled navigation pages out of the label index", async () => {
    // Citation validation rejects navigation pages as evidence, so a labeled
    // navigation page in the index would route the agent to a page it cannot
    // cite — the search layer must classify pages the same way.
    fs.writeFileSync(
      path.join(knowledgeDir, "index.md"),
      "# Knowledge Index\n\n- [Routes](routes-guide.md)\n- [Sub](sub/_index.md)\n- [Topic](topic.md)\n",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "routes-guide.md"),
      "---\ntype: index\ntitle: 检索路由\nlabels:\n  - facet: topic\n    value: RouteGuide\n---\n# Routes\n\n- [Topic](topic.md)\n",
    );
    fs.mkdirSync(path.join(knowledgeDir, "sub"), { recursive: true });
    fs.writeFileSync(
      path.join(knowledgeDir, "sub", "_index.md"),
      "---\ntype: Catalog\ntitle: Sub\nlabels:\n  - facet: topic\n    value: SubCatalog\n---\n# Sub\n",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "topic.md"),
      "---\ntype: Topic\ntitle: B300\nlabels:\n  - facet: entity\n    value: B300\n---\n# B300\n",
    );
    await resolver.sync();

    const tool = createKnowledgeSearchTool(resolver);
    const search = await tool.execute("call-nav-search", { query: "RouteGuide" });
    const payload = JSON.parse((search.content[0] as { text: string }).text);
    expect(payload.results).toEqual([]);
    expect(payload.totalPages).toBe(1);
    // Navigation pages are routing surfaces, not content pages missing labels.
    expect(payload.unlabeledPages).toBe(0);
    expect(payload.invalidLabeledPages).toBe(0);

    const catalogResult = await tool.execute("call-nav-catalog", { listLabels: true });
    const catalog = JSON.parse((catalogResult.content[0] as { text: string }).text);
    expect(catalog.labels.map((label: { value: string }) => label.value)).toEqual(["B300"]);
  });

  it("returns the canonical multi-library catalog trail without requiring intermediate reads", async () => {
    fs.mkdirSync(path.join(knowledgeDir, "repos", "gpu", "topics"), { recursive: true });
    fs.writeFileSync(
      path.join(knowledgeDir, "index.md"),
      "# Knowledge Index\n\n- [[repos/gpu/index|GPU Wiki]] - GPU evaluation and operations\n",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "repos", "gpu", "index.md"),
      "# GPU Wiki\n\n- [B300 LSTM evaluation](topics/b300-lstm.md)\n",
    );
    fs.writeFileSync(
      path.join(knowledgeDir, "repos", "gpu", "topics", "b300-lstm.md"),
      "---\ntype: Topic\ntitle: B300 LSTM evaluation\nlabels:\n" +
      "  - facet: entity\n    value: B300\n" +
      "  - facet: task\n    value: CUDA Graph optimization\n    aliases: [cudagraph]\n---\n# Result\n",
    );
    await resolver.sync();

    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-multi-repo", { query: "B300 cudagraph" });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.results[0].routeProof).toEqual({
      reachable: true,
      trail: [
        { file: "index.md", kind: "catalog" },
        { file: "repos/gpu/index.md", kind: "catalog", via: "GPU Wiki" },
        {
          file: "repos/gpu/topics/b300-lstm.md",
          kind: "leaf",
          via: "B300 LSTM evaluation",
        },
      ],
    });
  });

  it("lists the complete typed label catalog through the same QA tool", async () => {
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), "# Knowledge Index\n\n- [Labels](labels.md)\n");
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
        pageCount: 1,
      }),
    ]));
    expect(payload.labels[0]).not.toHaveProperty("pages");
    expect(payload.labels[0]).not.toHaveProperty("pagesTruncated");

    const expanded = await tool.execute("call-catalog-expanded", {
      listLabels: true,
      includePages: true,
      limit: 100,
    });
    const expandedPayload = JSON.parse((expanded.content[0] as { text: string }).text);
    expect(expandedPayload.labels).toEqual(expect.arrayContaining([
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
