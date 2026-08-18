import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKnowledgeCitationSupport, KNOWLEDGE_CITATION_MANIFEST } from "./knowledge-citation-tool.js";

describe("knowledge_cite", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-"));
    dirs.push(dir);
    const page = path.join(dir, "guide.md");
    fs.writeFileSync(page, "---\nsources:\n  - resource: raw/feishu/runbook.md\n---\n# Guide\n");
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [{
        resource: "feishu/runbook.md", title: "GPU Runbook", url: "https://docs.feishu.cn/wiki/abc",
      }] }],
    }));
    return { dir, page };
  }

  it("emits only sources from pages successfully read in the current turn", async () => {
    const { dir, page } = fixture();
    const events: Record<string, unknown>[] = [];
    const turnRef = { current: 1 };
    const support = createKnowledgeCitationSupport({ knowledgeDir: dir, turnRef, sessionEventEmitter: (e) => events.push(e) });
    support.noteRead(page);
    const output = await support.tool.execute("call", { pages: [page] } as never);
    expect(output.details).toEqual({ cited: 1 });
    expect(events).toEqual([{ type: "knowledge_sources", sources: [{
      title: "GPU Runbook", url: "https://docs.feishu.cn/wiki/abc", resource: "feishu/runbook.md", page: "guide.md",
    }] }]);

    turnRef.current = 2;
    const unread = await support.tool.execute("call", { pages: [page] } as never);
    expect(unread.details).toEqual({ cited: 0 });
    expect(events).toHaveLength(1);
  });
});
