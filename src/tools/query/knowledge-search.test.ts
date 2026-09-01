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
    expect(payload.results[0].labels).toHaveLength(3);
    expect(payload.results[0]).not.toHaveProperty("content");
    expect(JSON.stringify(payload)).not.toContain("29.71 ms");
  });

  it("ranks a page with more matching labels ahead of a generic page", async () => {
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
