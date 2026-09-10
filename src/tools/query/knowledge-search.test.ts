import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KnowledgeLabelIndex } from "../../knowledge/labels.js";
import { KnowledgeResolver } from "../../knowledge/resolver.js";
import { createKnowledgeSearchTool, KNOWLEDGE_SEARCH_PAYLOAD_BUDGET_BYTES } from "./knowledge-search.js";

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

describe("knowledge_search on a multi-library mount", () => {
  let root: string;
  let knowledgeDir: string;
  let resolver: KnowledgeResolver;

  const page = (file: string, title: string, labels: string) =>
    fs.writeFileSync(path.join(knowledgeDir, file), `---\ntype: Topic\ntitle: ${title}\ndescription: ${title} page\nlabels:\n${labels}---\n# ${title}\n`);

  /** Three synthetic libraries exercise entity, procedure and record routing. */
  const mountThreeLibraries = () => {
    for (const lib of ["repos/a", "repos/b", "repos/c"]) fs.mkdirSync(path.join(knowledgeDir, lib), { recursive: true });
    fs.writeFileSync(path.join(knowledgeDir, ".citation-manifest.json"), JSON.stringify({
      version: 1,
      repos: [{ id: "a", root: "repos/a" }, { id: "b", root: "repos/b" }, { id: "c", root: "repos/c" }],
    }));
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), [
      "# Knowledge Index",
      "",
      "- [[repos/a/index]] - 示例甲库 v3 — Widget 示例对象与性能基线",
      "- [[repos/b/index]] - 示例 Beta v7 — 示例步骤与练习:操作方法、示例 Beta、练习记录",
      "- [[repos/c/index]] - 示例丙库 v1 — 示例记录、条目分类与数量申请",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(knowledgeDir, "repos/a/index.md"), "# Library A\n\n- [UnitA](unit-a.md)\n- [UnitB](unit-b.md)\n- [P2P](p2p.md)\n");
    page("repos/a/unit-a.md", "UnitA", "  - facet: entity\n    value: UnitA\n  - facet: topic\n    value: Widget\n");
    page("repos/a/unit-b.md", "UnitB", "  - facet: entity\n    value: UnitB\n  - facet: topic\n    value: Widget\n");
    page("repos/a/p2p.md", "连接与配对", "  - facet: topic\n    value: MeshLink\n    aliases: [FabricLink, 互联]\n  - facet: topic\n    value: Widget\n");
    fs.writeFileSync(path.join(knowledgeDir, "repos/b/index.md"), "# Library B\n\n- [LinkCheck acceptance](linkcheck.md)\n- [Component upgrade](component.md)\n");
    page("repos/b/linkcheck.md", "多项 LinkCheck 验收", "  - facet: task\n    value: linkcheck-test 验收\n    aliases: [LinkCheck test, 合格指标]\n  - facet: topic\n    value: FabricLink\n  - facet: entity\n    value: UnitA\n");
    page("repos/b/component.md", "Widget 组件升级", "  - facet: task\n    value: Widget component upgrade\n    aliases: [升级组件]\n  - facet: topic\n    value: Widget\n");
    fs.writeFileSync(path.join(knowledgeDir, "repos/c/index.md"), "# Library C\n\n- [Quota](quota.md)\n");
    page("repos/c/quota.md", "配额申请", "  - facet: task\n    value: 配额申请\n");
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-knowledge-multilib-"));
    knowledgeDir = path.join(root, "knowledge");
    fs.mkdirSync(knowledgeDir, { recursive: true });
    resolver = new KnowledgeResolver(new KnowledgeLabelIndex(knowledgeDir));
  });

  afterEach(() => {
    resolver.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("routes a task query to the library whose labels and domain match, and groups every match per library", async () => {
    mountThreeLibraries();
    await resolver.sync();
    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-route", { query: "UnitA FabricLink LinkCheck test 合格指标", topK: 3 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.routing).toMatchObject({ multiLibrary: true, selected: ["repos/b"], fallback: false });
    expect(payload.results.map((row: { file: string }) => row.file)).toEqual(["repos/b/linkcheck.md"]);
    expect(payload.results[0].library).toBe("repos/b");
    // The entity library also matched (UnitA, FabricLink alias) — it is ranked behind, not hidden.
    expect(payload.libraries.map((lib: { library: string }) => lib.library)).toEqual(["repos/b", "repos/a"]);
    expect(payload.libraries[0]).toMatchObject({ name: "示例 Beta", matchedPages: 1 });
    expect(payload.libraries[0].why).toEqual(expect.arrayContaining([expect.stringContaining("label:")]));
    expect(payload.libraries[1].topPages).toEqual(expect.arrayContaining(["repos/a/unit-a.md", "repos/a/p2p.md"]));
    expect(payload.libraries[0].index).toBe("repos/b/index.md");
    expect(payload).not.toHaveProperty("message");
  });

  it("counts label frequency inside each library so a rare label is not diluted by another library", async () => {
    mountThreeLibraries();
    // Ten record pages share the alias "升级"; the single procedure page with the same alias must still score as rare.
    const links: string[] = [];
    for (let i = 0; i < 10; i++) {
      page(`repos/c/plan-${i}.md`, `Plan ${i}`, `  - facet: task\n    value: Plan change ${i}\n    aliases: [升级]\n`);
      links.push(`- [Plan ${i}](plan-${i}.md)`);
    }
    fs.writeFileSync(path.join(knowledgeDir, "repos/c/index.md"), `# Library C\n\n- [Quota](quota.md)\n${links.join("\n")}\n`);
    page("repos/b/component.md", "Widget 组件升级", "  - facet: task\n    value: Widget component upgrade\n    aliases: [升级]\n");
    await resolver.sync();
    const tool = createKnowledgeSearchTool(resolver);
    const result = await tool.execute("call-per-library-counts", { query: "升级", topK: 20 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    // The rare procedure hit wins the route; the ten record pages stay visible in their library group.
    expect(payload.routing.selected).toEqual(["repos/b"]);
    const procedure = payload.results.find((row: { file: string }) => row.file === "repos/b/component.md");
    expect(procedure.matchedLabels[0].pageCount).toBe(1);
    expect(procedure.score).toBe(1);
    const records = payload.libraries.find((lib: { library: string }) => lib.library === "repos/c");
    expect(records.matchedPages).toBe(10);
    expect(records.score).toBeLessThan(payload.libraries[0].score);
  });

  it("routes to both libraries and flags the tie when neither leads", async () => {
    mountThreeLibraries();
    await resolver.sync();
    const tool = createKnowledgeSearchTool(resolver);
    // "UnitA" is a rare entity label in BOTH entity and procedure libraries: neither library leads.
    const result = await tool.execute("call-tie", { query: "UnitA", topK: 10 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.routing.fallback).toBe(false);
    expect([...payload.routing.selected].sort()).toEqual(["repos/a", "repos/b"]);
    expect(payload.routing.margin).toBeLessThan(0.1);
    expect(payload.results.map((row: { file: string }) => row.file).sort()).toEqual(["repos/a/unit-a.md", "repos/b/linkcheck.md"]);
    expect(payload.message).toContain("Several libraries match about equally");
  });

  it("restricts to one library by root or display name and rejects an unknown library", async () => {
    mountThreeLibraries();
    await resolver.sync();
    const tool = createKnowledgeSearchTool(resolver);

    const byRoot = JSON.parse((await tool.execute("c1", { query: "UnitA", library: "repos/a" })).content[0].text as string);
    expect(byRoot.results.map((row: { file: string }) => row.file)).toEqual(["repos/a/unit-a.md"]);
    expect(byRoot.routing).toMatchObject({ selected: ["repos/a"], fallback: false });
    // Inside one library the group does not repeat the page list the flat results already carry.
    expect(byRoot.libraries[0]).not.toHaveProperty("topPages");
    expect(byRoot.libraries[0].index).toBe("repos/a/index.md");

    const byName = JSON.parse((await tool.execute("c2", { query: "UnitA", library: "示例 Beta" })).content[0].text as string);
    expect(byName.results.map((row: { file: string }) => row.file)).toEqual(["repos/b/linkcheck.md"]);

    const unknown = JSON.parse((await tool.execute("c3", { query: "UnitA", library: "nope" })).content[0].text as string);
    expect(unknown.error).toContain("Unknown library");
    expect(unknown.libraries.map((lib: { library: string }) => lib.library)).toEqual(["repos/a", "repos/b", "repos/c"]);

    // The index matches names case-insensitively; a zero-hit search inside a
    // library selected that way is an empty result, not an "unknown library".
    const caseZero = JSON.parse((await tool.execute("c4", { query: "zzz", library: "示例 beta" })).content[0].text as string);
    expect(caseZero.error).toBeUndefined();
    expect(caseZero.results).toEqual([]);
    expect(caseZero.routing.selected).toEqual(["repos/b"]);
  });

  it("lists libraries with domain, page count and dominant labels in one call", async () => {
    mountThreeLibraries();
    await resolver.sync();
    const tool = createKnowledgeSearchTool(resolver);
    const payload = JSON.parse((await tool.execute("c-list", { listLibraries: true })).content[0].text as string);

    expect(payload.mode).toBe("libraries");
    expect(payload.multiLibrary).toBe(true);
    expect(payload.libraries).toHaveLength(3);
    expect(payload.libraries[0]).toMatchObject({
      library: "repos/a", name: "示例甲库", version: 3, domain: "Widget 示例对象与性能基线",
      pageCount: 3, index: "repos/a/index.md",
    });
    expect(payload.libraries[0].topLabels).toEqual(expect.arrayContaining([
      expect.objectContaining({ facet: "topic", value: "Widget", pageCount: 3 }),
    ]));
    expect(payload.libraries[0].unlabeledPages).toBe(0);
    expect(payload.libraries[0]).not.toHaveProperty("unlabeledSamples");
    expect(payload.message).toContain("Choose the library");
  });

  it("reports each library's unlabeled pages as a backfill worklist", async () => {
    mountThreeLibraries();
    fs.writeFileSync(path.join(knowledgeDir, "repos/b/acceptance.md"), "---\ntype: Topic\ntitle: 交付验收标准\n---\n# 验收\n");
    fs.writeFileSync(path.join(knowledgeDir, "repos/b/plain.md"), "# 无 frontmatter 的页\n");
    fs.writeFileSync(path.join(knowledgeDir, "repos/b/index.md"), "# Library B\n\n- [LinkCheck acceptance](linkcheck.md)\n- [Component upgrade](component.md)\n- [验收](acceptance.md)\n- [plain](plain.md)\n");
    await resolver.sync();
    const tool = createKnowledgeSearchTool(resolver);
    const payload = JSON.parse((await tool.execute("c-unlabeled", { listLibraries: true })).content[0].text as string);
    const procedure = payload.libraries.find((lib: { library: string }) => lib.library === "repos/b");
    expect(procedure.unlabeledPages).toBe(2);
    expect(procedure.unlabeledSamples).toEqual(["plain", "交付验收标准"]);
    const entities = payload.libraries.find((lib: { library: string }) => lib.library === "repos/a");
    expect(entities.unlabeledPages).toBe(0);
  });

  it("points a weak in-library match at that library's index instead of asking for another rewording", async () => {
    mountThreeLibraries();
    await resolver.sync();
    const tool = createKnowledgeSearchTool(resolver);
    // Only "Widget" matches, and it covers a third of the query: a weak match (score < 0.7) inside one library.
    const payload = JSON.parse((await tool.execute("c-weak", { query: "Widget 性能 基线 验收", library: "repos/a", topK: 5 })).content[0].text as string);
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results[0].score).toBeLessThan(0.7);
    expect(payload.message).toContain("Read repos/a/index.md");
    expect(payload.message).not.toContain("Refine the query");
  });

  it("keeps a large topK+includeLabels result under the payload budget without dropping any path", async () => {
    mountThreeLibraries();
    // Twenty richly labeled pages sharing one alias, long CJK titles, labels and
    // descriptions: synthetic payload pressure at three UTF-8 bytes
    // per character so the budget is exercised in bytes rather than characters.
    const links: string[] = [];
    for (let i = 0; i < 20; i++) {
      const labels = Array.from({ length: 8 }, (_, k) => `  - facet: topic\n    value: 多项验收主题${i}${k}${"验".repeat(20)}\n    aliases: [别名${i}${k}, 验收]\n`).join("");
      fs.writeFileSync(path.join(knowledgeDir, `repos/b/bulk-${i}.md`),
        `---\ntype: Topic\ntitle: 多项 LinkCheck 验收标准 第${i}版\ndescription: ${"很长的中文描述".repeat(60)}\nlabels:\n${labels}---\n# Bulk ${i}\n`);
      links.push(`- [Bulk ${i}](bulk-${i}.md)`);
    }
    fs.writeFileSync(path.join(knowledgeDir, "repos/b/index.md"), `# Library B\n\n- [LinkCheck acceptance](linkcheck.md)\n- [Component upgrade](component.md)\n${links.join("\n")}\n`);
    await resolver.sync();
    const tool = createKnowledgeSearchTool(resolver);
    const raw = (await tool.execute("c-budget", { query: "验收", topK: 20, includeLabels: true })).content[0].text as string;
    const payload = JSON.parse(raw);

    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(KNOWLEDGE_SEARCH_PAYLOAD_BUDGET_BYTES + 2_000);
    // Paths go last: labels, trails and descriptions are shed on every row before the list is cut.
    // Before the compact tier this adversarial all-CJK shape kept 3 paths of 20; it now keeps at least 10.
    expect(payload.results.length).toBeGreaterThanOrEqual(10);
    expect(payload.results.every((row: { matchedLabels: unknown[] }) => row.matchedLabels.length > 0)).toBe(true);
    expect(payload.results.every((row: { file: string; title: string; score: number }) => row.file && row.title && typeof row.score === "number")).toBe(true);
    // Full labels are the first thing shed; when even the top candidates lose them the omission says so.
    expect(payload.results[0].labels !== undefined || payload.omitted.includes("labels on every result; matchedLabels are kept")).toBe(true);
    expect(payload.omitted.join(" ")).toMatch(/labels beyond|descriptions shortened|truncated/);
    // 20 bulk pages plus linkcheck.md, whose task label "linkcheck-test 验收" also matches.
    expect(payload.matchedPages).toBe(21);
  });

  it("drops indexed pages that vanished from disk and reports them as stale", async () => {
    mountThreeLibraries();
    await resolver.sync();
    fs.rmSync(path.join(knowledgeDir, "repos/a/unit-b.md"));
    const tool = createKnowledgeSearchTool(resolver);
    const payload = JSON.parse((await tool.execute("c-stale", { query: "UnitB" })).content[0].text as string);

    expect(payload.results).toEqual([]);
    expect(payload.staleCandidates).toBe(1);
  });

  it("keeps single-library output free of library fields", async () => {
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), "# Knowledge Index\n\n- [UnitA](unit-a.md)\n");
    page("unit-a.md", "UnitA", "  - facet: entity\n    value: UnitA\n");
    await resolver.sync();
    const tool = createKnowledgeSearchTool(resolver);
    const payload = JSON.parse((await tool.execute("c-single", { query: "UnitA" })).content[0].text as string);

    expect(payload).not.toHaveProperty("libraries");
    expect(payload).not.toHaveProperty("routing");
    expect(payload).not.toHaveProperty("staleCandidates");
    expect(payload.results[0]).not.toHaveProperty("library");

    const list = JSON.parse((await tool.execute("c-single-list", { listLibraries: true })).content[0].text as string);
    expect(list.multiLibrary).toBe(false);
    expect(list.libraries).toEqual([expect.objectContaining({ library: "", index: "index.md", pageCount: 1 })]);
  });
});
