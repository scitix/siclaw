import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverKnowledgeLibraries, libraryRootForFile, parseRootCatalogLibraries } from "./libraries.js";

describe("knowledge libraries", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-knowledge-libraries-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("parses both catalog link grammars with name, version and domain", () => {
    const parsed = parseRootCatalogLibraries([
      "# Knowledge Index",
      "",
      "- [[repos/sample-b--1900/index]] - 示例 Beta v7 — 示例步骤与练习:操作方法、示例 Beta、练习记录",
      "- [Library A](repos/a/index.md) - Library A v2",
      "- [Bare](repos/bare/index.md)",
      "- [Not a library](topics/page.md) - a page link",
    ].join("\n"));
    expect(parsed.get("repos/sample-b--1900")).toEqual({
      name: "示例 Beta", version: 7, domain: "示例步骤与练习:操作方法、示例 Beta、练习记录",
    });
    expect(parsed.get("repos/a")).toEqual({ name: "Library A", version: 2, domain: "" });
    expect(parsed.get("repos/bare")).toEqual({ name: "bare", version: null, domain: "" });
    expect(parsed.has("topics")).toBe(false);
  });

  it("takes roots from the citation manifest and display metadata from the catalog", () => {
    fs.writeFileSync(path.join(dir, ".citation-manifest.json"), JSON.stringify({
      version: 1, repos: [{ id: "a", root: "repos/a" }, { id: "b", root: "repos/b" }],
    }));
    fs.writeFileSync(path.join(dir, "index.md"), "- [[repos/a/index]] - Alpha v1 — alpha domain\n");
    expect(discoverKnowledgeLibraries(dir)).toEqual([
      { root: "repos/a", name: "Alpha", domain: "alpha domain", version: 1 },
      { root: "repos/b", name: "b", domain: "", version: null },
    ]);
  });

  it("collapses a single library to one root \"\"", () => {
    fs.writeFileSync(path.join(dir, ".citation-manifest.json"), JSON.stringify({ version: 1, repos: [{ id: "a", root: "" }] }));
    fs.writeFileSync(path.join(dir, "index.md"), "- [Page](page.md) - a page\n");
    expect(discoverKnowledgeLibraries(dir)).toEqual([{ root: "", name: "", domain: "", version: null }]);
    expect(discoverKnowledgeLibraries(path.join(dir, "missing"))).toEqual([{ root: "", name: "", domain: "", version: null }]);
  });

  it("assigns a page to the longest matching library root", () => {
    const roots = ["repos/a", "repos/a-long", ""];
    expect(libraryRootForFile("repos/a-long/x.md", roots)).toBe("repos/a-long");
    expect(libraryRootForFile("repos/a/x.md", roots)).toBe("repos/a");
    expect(libraryRootForFile("elsewhere/x.md", roots)).toBe("");
  });
});
