import { describe, expect, it } from "vitest";

import { isKnowledgeNavigationPage, isKnowledgeNavigationPath } from "./page-kind.js";

describe("knowledge page kind", () => {
  it.each(["index.md", "repos/gpu/_index.md", "repos\\gpu\\INDEX.md"])(
    "classifies %s as navigation by path",
    (file) => expect(isKnowledgeNavigationPath(file)).toBe(true),
  );

  it("classifies an explicitly typed compiled index", () => {
    expect(isKnowledgeNavigationPage("catalog.md", "---\ntype: index\n---\n# Catalog\n")).toBe(true);
  });

  it("keeps ordinary content pages citable", () => {
    expect(isKnowledgeNavigationPage(
      "运维/GSP禁用方法.md",
      "---\ntitle: GSP 禁用方法\nsources: []\n---\n# GSP\n",
    )).toBe(false);
  });
});
