import { describe, expect, it } from "vitest";
import { appendKnowledgeSourceCitations, normalizeKnowledgeSourceCitations } from "./knowledge-citations.js";

describe("knowledge source citation rendering", () => {
  it("deduplicates, caps and appends trusted source links", () => {
    const sources = [
      { title: "GPU Runbook", url: "https://docs.feishu.cn/wiki/a" },
      { title: "duplicate", url: "https://docs.feishu.cn/wiki/a" },
      { title: "Policy", url: "https://example.com/policy" },
    ];
    expect(normalizeKnowledgeSourceCitations(sources)).toHaveLength(2);
    expect(appendKnowledgeSourceCitations("结论", sources)).toBe(
      "结论\n\n### 参考原文\n\n- [GPU Runbook](https://docs.feishu.cn/wiki/a)\n- [Policy](https://example.com/policy)",
    );
  });

  it("does not add a section without valid https citations", () => {
    expect(appendKnowledgeSourceCitations("answer", [{ title: "x", url: "javascript:alert(1)" }])).toBe("answer");
  });

  it("keeps parentheses in an https URL inside one Markdown destination", () => {
    const rendered = appendKnowledgeSourceCitations("answer", [{
      title: "Title",
      url: "https://ok.example/)[Login](https://evil.example/",
    }]);

    expect(rendered.match(/\]\(/g)).toHaveLength(1);
    expect(rendered).toContain(
      "- [Title](https://ok.example/%29[Login]%28https://evil.example/)",
    );
  });
});
