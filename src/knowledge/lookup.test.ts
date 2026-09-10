import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKnowledgeResolver } from "./indexer.js";
import { knowledgeTerms, LOOKUP_OUTPUT_BYTES } from "./lookup.js";

const dirs: string[] = [];
const resolvers: ReturnType<typeof createKnowledgeResolver>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  resolvers.splice(0).forEach((resolver) => resolver.close());
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

function fixture(pages: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-lookup-"));
  dirs.push(root);
  for (const [file, content] of Object.entries(pages)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  fs.writeFileSync(path.join(root, "index.md"), Object.keys(pages).map((file) => `- [${file}](${file})`).join("\n"));
  const resolver = createKnowledgeResolver(root);
  resolvers.push(resolver);
  return { root, resolver };
}

describe("mounted knowledge body lookup", () => {
  it("finds unlabeled body evidence and preserves complete conditions, exceptions and paths", async () => {
    const body = "# Recovery\nFor E_CONN_42 on v2.3, retry once.\n## Exception\nDo not retry during maintenance.\n[Prerequisite](prerequisite.md)\n";
    const { root, resolver } = fixture({ "guide.md": body, "other.md": "# Guide\nGeneral connection troubleshooting." });
    await resolver.sync();
    expect(resolver.search("E_CONN_42 v2.3").pages).toHaveLength(0);
    const result = await resolver.lookup({ query: "E_CONN_42 v2.3" });
    expect(result.results[0]).toMatchObject({ file: path.join(root, "guide.md"), content: body, readStatus: "full" });
  });

  it("uses matching CJK tokens on both sides and keeps identifiers, numbers and negations", async () => {
    expect(knowledgeTerms("k8s无法启动 v2.3 不要重试 no 0")).toEqual(expect.arrayContaining(["k8s", "无法", "启动", "v2.3", "不要", "重试", "no", "0"]));
    const { resolver } = fixture({ "a.md": "# Recovery\nk8s证书过期时禁止重试。", "b.md": "# Recovery\nGPU显存不足。" });
    expect((await resolver.lookup({ query: "证书过期如何处理" })).results[0].file).toMatch(/a.md$/);
  });

  it("searches ten libraries together, preserves duplicate names and filters by authoritative ID", async () => {
    const pages = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`repos/r${i}/guide.md`, `# Recovery\nRecover fleet${i} with its own configuration.`]));
    const { root, resolver } = fixture(pages);
    fs.writeFileSync(path.join(root, ".citation-manifest.json"), JSON.stringify({ repos: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, root: `repos/r${i}` })) }));
    fs.writeFileSync(path.join(root, ".sync-manifest.json"), JSON.stringify({ repos: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: "Same display name", version: `v${i}` })) }));
    const result = await resolver.lookup({ query: "fleet9", topK: 10 });
    expect(result.totalPages).toBe(10);
    expect(result.results[0].library).toEqual({ id: "r9", root: "repos/r9", name: "Same display name", version: "v9" });
    expect((await resolver.lookup({ query: "Recovery", repoIds: ["r2"], topK: 10 })).results.map((page) => page.library.id)).toEqual(["r2"]);
    await expect(resolver.lookup({ query: "Recovery", repoIds: ["missing"] })).rejects.toThrow("Unknown library");
  });

  it("does not retrieve unreachable files, navigation pages or symlinks", async () => {
    const { root, resolver } = fixture({ "leaf.md": "# Leaf\nvisible", "catalog.md": "---\ntype: index\n---\n# Hidden catalog keyword\n[Leaf](leaf.md)" });
    fs.writeFileSync(path.join(root, "orphan.md"), "secret orphan keyword");
    fs.symlinkSync(path.join(root, "orphan.md"), path.join(root, "link.md"));
    fs.appendFileSync(path.join(root, "index.md"), "\n[Link](link.md)\n[Escape](../outside.md)");
    expect((await resolver.lookup({ query: "keyword" })).results).toEqual([]);
    expect((await resolver.lookup({ query: "visible" })).totalPages).toBe(1);
  });

  it("reuses the warm index and rebuilds for sync, edits, deletions and changed versions", async () => {
    const { root, resolver } = fixture({ "guide.md": "# Guide\nfirst-token" });
    await resolver.lookup({ query: "first-token" });
    const reads = vi.spyOn(fs.promises, "readFile");
    await resolver.lookup({ query: "first-token", readCount: 0 });
    expect(reads).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(root, "guide.md"), "# Guide\nsecond-token");
    // A stale selected page is detected even before a managed sync notification.
    expect((await resolver.lookup({ query: "first-token" })).results).toEqual([]);
    expect((await resolver.lookup({ query: "second-token" })).results[0].content).toContain("second-token");
    fs.writeFileSync(path.join(root, "new.md"), "# New\nnew-token");
    fs.appendFileSync(path.join(root, "index.md"), "\n[New](new.md)");
    await resolver.sync();
    expect((await resolver.lookup({ query: "new-token" })).results[0].file).toMatch(/new.md$/);
    fs.unlinkSync(path.join(root, "new.md"));
    expect((await resolver.lookup({ query: "new-token" })).results).toEqual([]);
    fs.writeFileSync(path.join(root, ".citation-manifest.json"), JSON.stringify({ repos: [{ id: "r1", root: "" }] }));
    const first = await resolver.lookup({ query: "second-token" });
    fs.writeFileSync(path.join(root, ".sync-manifest.json"), JSON.stringify({ repos: [{ id: "r1", version: 2 }] }));
    const second = await resolver.lookup({ query: "second-token" });
    expect(second.generation).not.toBe(first.generation);
    expect(second.results[0].library.version).toBe(2);
  });

  it("caps serialized UTF-8 including escapes without truncating evidence", async () => {
    const { resolver } = fixture({ "big.md": `# Unique\n${'"\\中文'.repeat(5000)}` });
    const result = await resolver.lookup({ query: "Unique" });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(LOOKUP_OUTPUT_BYTES);
    expect(result.results[0]).toMatchObject({ readStatus: "budget_exceeded" });
    expect(result.results[0].content).toBeUndefined();
  });

  it("keeps co-located agents isolated and does not serve removed library evidence", async () => {
    const a = fixture({ "guide.md": "# Guide\nalphaonly" });
    const b = fixture({ "guide.md": "# Guide\nbetaonly" });
    await Promise.all([a.resolver.lookup({ query: "alphaonly" }), b.resolver.lookup({ query: "betaonly" })]);
    expect((await b.resolver.lookup({ query: "alphaonly" })).results).toEqual([]);
    fs.writeFileSync(path.join(a.root, ".citation-manifest.json"), JSON.stringify({ repos: [] }));
    expect((await a.resolver.lookup({ query: "alphaonly" })).results).toEqual([]);
  });

  it("rejects invalid parameters, SQL syntax and cancellation without altering the index", async () => {
    const { resolver } = fixture({ "guide.md": "# Guide\nunique" });
    await expect(resolver.lookup({ query: "unique", topK: NaN })).rejects.toThrow("topK");
    await expect(resolver.lookup({ query: "unique" }, AbortSignal.abort())).rejects.toThrow();
    expect((await resolver.lookup({ query: 'unique" OR 1=1 --' })).results[0].file).toMatch(/guide.md$/);
    resolver.close();
    await expect(resolver.lookup({ query: "unique" })).rejects.toThrow("unavailable");
  });

  it("shares concurrent builds and refuses a mount swapped during the initial build", async () => {
    const { root, resolver } = fixture({ "guide.md": "# Guide\nunique" });
    const [a, b] = await Promise.all([resolver.lookup({ query: "unique" }), resolver.lookup({ query: "unique" })]);
    expect(a).toEqual(b);
    await resolver.sync();
    const original = fs.promises.readFile;
    vi.spyOn(fs.promises, "readFile").mockImplementationOnce(async (...args: Parameters<typeof fs.promises.readFile>) => {
      const content = await original(...args);
      fs.writeFileSync(path.join(root, ".citation-manifest.json"), JSON.stringify({ repos: [{ id: "replacement", root: "" }] }));
      return content;
    });
    await expect(resolver.lookup({ query: "unique" })).rejects.toThrow("changed while indexing");
    expect((await resolver.lookup({ query: "unique" })).results[0].library.id).toBe("replacement");
  });
});
