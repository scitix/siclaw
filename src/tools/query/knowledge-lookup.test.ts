import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKnowledgeResolver } from "../../knowledge/indexer.js";
import { createKnowledgeCitationSupport } from "../../core/knowledge-citation-tool.js";
import { ToolResultArtifactStore, withToolResultArtifactCapture } from "../../core/tool-result-artifact.js";
import { createKnowledgeLookupTool, registration } from "./knowledge-lookup.js";
import type { ToolRefs } from "../../core/tool-registry.js";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((fn) => fn()); });

function fixture(large = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-lookup-tool-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const body = (resource: string) => `---\nsources:\n  - resource: raw/${resource}.md\n---\n# Recovery\nRecover a failed worker.\n${large ? "Long text. ".repeat(2000) : "Do not restart during maintenance.\n"}`;
  fs.writeFileSync(path.join(root, "guide.md"), body("guide"));
  fs.writeFileSync(path.join(root, "other.md"), body("other"));
  fs.writeFileSync(path.join(root, "index.md"), "[Guide](guide.md)\n[Other](other.md)");
  fs.writeFileSync(path.join(root, ".citation-manifest.json"), JSON.stringify({
    version: 1, repos: [{ id: "repo", root: "", sources: ["guide", "other"].map((name) => ({
      resource: `${name}.md`, title: name, url: `https://example.com/${name}`,
    })) }],
  }));
  const resolver = createKnowledgeResolver(root);
  cleanup.push(() => resolver.close());
  const turnRef = { current: 1 };
  const events: unknown[] = [];
  const support = createKnowledgeCitationSupport({ knowledgeDir: root, turnRef, sessionEventEmitter: (event) => events.push(event) });
  const tool = createKnowledgeLookupTool(resolver, support);
  const cite = (file: string) => support.tool.execute("cite", { pages: [{ path: file, claim: "Do not restart workers during maintenance." }] });
  return { root, resolver, support, tool, cite, events, turnRef };
}

describe("knowledge_lookup tool evidence registration", () => {
  it("returns and registers complete pages in one call while rejecting unread candidates", async () => {
    const { tool, cite, events, turnRef } = fixture();
    const output = await tool.execute("lookup", { query: "Recovery", readCount: 1 });
    const result = JSON.parse((output.content[0] as { text: string }).text);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].content).toContain("Do not restart during maintenance.");
    expect((await cite(result.results[1].file)).details).toEqual({ cited: 0 });
    expect((await cite(result.results[0].file)).details).toEqual({ cited: 1 });
    expect(events).toHaveLength(1);
    turnRef.current++;
    expect((await cite(result.results[0].file)).details).toEqual({ cited: 0 });
  });

  it.each([0, 2])("never registers absent or over-budget content (readCount=%i)", async (readCount) => {
    const { tool, cite } = fixture(true);
    const output = await tool.execute("lookup", { query: "Recovery", readCount });
    const result = JSON.parse((output.content[0] as { text: string }).text);
    for (const page of result.results) {
      expect(page.content).toBeUndefined();
      expect((await cite(page.file)).details).toEqual({ cited: 0 });
    }
  });

  it.each([
    { name: "ASCII page above the inline character limit", text: "x".repeat(8_500), full: false },
    { name: "multibyte page within both inline limits", text: "内容".repeat(1_400), full: true },
  ])("keeps evidence registration aligned with the runtime wrapper: $name", async ({ text, full }) => {
    const { root, tool, cite } = fixture();
    fs.appendFileSync(path.join(root, "guide.md"), `\nINLINE_BOUNDARY_EVIDENCE\n${text}`);
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-lookup-artifacts-"));
    cleanup.push(() => fs.rmSync(artifactRoot, { recursive: true, force: true }));
    const store = new ToolResultArtifactStore({
      rootDir: artifactRoot,
      getScope: () => ({ agentId: "agent", sessionId: "session" }),
    });
    await store.initialize();
    const wrapped = withToolResultArtifactCapture(tool, store, 4096);
    const output = await wrapped.execute("lookup", { query: "INLINE_BOUNDARY_EVIDENCE", topK: 1, readCount: 1 });
    const visible = (output.content[0] as { text: string }).text;
    const result = JSON.parse(visible);
    expect(visible.length).toBeLessThanOrEqual(8000);
    expect(Buffer.byteLength(visible)).toBeLessThanOrEqual(12000);
    expect(result.results[0].readStatus).toBe(full ? "full" : "budget_exceeded");
    expect(result.results[0].content).toBe(full ? fs.readFileSync(path.join(root, "guide.md"), "utf8") : undefined);
    expect((await cite(result.results[0].file)).details).toEqual({ cited: full ? 1 : 0 });
  });

  it("refuses to register evidence if the citation mount changes across lookup", async () => {
    const { tool, resolver, support } = fixture();
    const note = vi.spyOn(support, "noteRead");
    const lookup = resolver.lookup.bind(resolver);
    vi.spyOn(resolver, "lookup").mockImplementation(async (options, signal) => {
      const result = await lookup(options, signal);
      vi.spyOn(support, "captureMount").mockReturnValue({ json: "changed" });
      return result;
    });
    await expect(tool.execute("lookup", { query: "Recovery" })).rejects.toThrow("mount changed");
    expect(note).not.toHaveBeenCalled();
  });

  it("is available without investigation memory and can run without a citation emitter", async () => {
    const { resolver } = fixture();
    expect(registration.available!({ knowledgeIndexer: resolver } as ToolRefs)).toBe(true);
    expect(registration.available!({} as ToolRefs)).toBe(false);
    const output = await createKnowledgeLookupTool(resolver).execute("lookup", { query: "Recovery" });
    expect(output.details).toMatchObject({ readPages: 2 });
  });
});
