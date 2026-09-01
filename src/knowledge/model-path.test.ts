import path from "node:path";

import { describe, expect, it } from "vitest";

import { modelKnowledgeLocations, modelKnowledgePath } from "./model-path.js";

describe("model knowledge paths", () => {
  it("keeps an Agent-scoped mount directly usable from the current workspace", () => {
    const knowledgeDir = path.join(process.cwd(), ".siclaw", "knowledge", "agent-a");

    expect(modelKnowledgeLocations(knowledgeDir)).toEqual({
      wikiRoot: ".siclaw/knowledge/agent-a",
      indexPath: ".siclaw/knowledge/agent-a/index.md",
    });
    expect(modelKnowledgePath(knowledgeDir, "repos/gpu/page.md"))
      .toBe(".siclaw/knowledge/agent-a/repos/gpu/page.md");
  });

  it("uses an absolute path when the mount is outside the current workspace", () => {
    const knowledgeDir = path.resolve("/tmp/siclaw-agent-knowledge");

    expect(modelKnowledgePath(knowledgeDir)).toBe(knowledgeDir);
  });
});
