import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyKnowledgeLabelManifest } from "./label-backfill.js";
import { parseKnowledgeLabels } from "./labels.js";

describe("knowledge label backfill", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("labels every declared catalog leaf without changing its body or the source tree", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-label-backfill-"));
    roots.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    fs.mkdirSync(path.join(source, "topics"), { recursive: true });
    fs.writeFileSync(
      path.join(source, "index.md"),
      "# Index\n\n- [B300 benchmark](topics/b300.md)\n- [README](README.md)\n",
    );
    fs.writeFileSync(path.join(source, "README.md"), "# Maintenance\n");
    const original = "---\ntype: Topic\ntitle: B300 benchmark\ndescription: LSTM CUDA Graph measurements\n---\n# Result\n\n29.71 ms\n";
    fs.writeFileSync(path.join(source, "topics", "b300.md"), original);

    const report = applyKnowledgeLabelManifest(source, output, {
      version: 1,
      pages: {
        "topics/b300.md": [
          { facet: "entity", value: "B300", aliases: ["B30X"] },
          { facet: "component", value: "LSTM", aliases: [] },
          { facet: "task", value: "CUDA Graph optimization", aliases: ["cudagraph"] },
          { facet: "topic", value: "operator benchmark", aliases: [] },
        ],
      },
      excluded: { "README.md": "maintenance navigation" },
    });

    const migrated = fs.readFileSync(path.join(output, "topics", "b300.md"), "utf8");
    expect(parseKnowledgeLabels(migrated)?.labels).toHaveLength(4);
    expect(migrated.slice(migrated.indexOf("# Result"))).toBe("# Result\n\n29.71 ms\n");
    expect(fs.readFileSync(path.join(source, "topics", "b300.md"), "utf8")).toBe(original);
    expect(report).toEqual({ reachableLeafPages: 2, taggedPages: 1, excludedPages: 1 });
  });

  it("fails closed when a reachable leaf is absent from the manifest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-label-backfill-"));
    roots.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "index.md"), "# Index\n\n- [Published page](published.md)\n");
    fs.writeFileSync(path.join(source, "published.md"), "---\ntitle: Published page\n---\n# Published\n");

    expect(() => applyKnowledgeLabelManifest(source, output, {
      version: 1,
      pages: {},
      excluded: {},
    })).toThrow("Manifest does not cover reachable leaf pages: published.md");
    expect(fs.existsSync(output)).toBe(false);
  });
});
