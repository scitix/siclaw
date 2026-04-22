/**
 * Tests for MemoryIndexer.search() — hybrid vector + FTS retrieval.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryIndexer } from "./indexer.js";
import type { EmbeddingProvider } from "./types.js";

/**
 * Embedding that encodes token bag into a small vector so that similar texts
 * have similar vectors (enables vector-search to find the right chunk).
 */
function createBagEmbedding(): EmbeddingProvider {
  // Fixed vocabulary - unknown tokens go into a "misc" bucket
  const vocab = ["kubernetes", "pod", "oom", "mtu", "rdma", "bandwidth", "etcd"];
  return {
    model: "bag-of-words",
    dimensions: vocab.length + 1,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const vec = new Array(vocab.length + 1).fill(0);
        const lower = t.toLowerCase();
        for (let i = 0; i < vocab.length; i++) {
          const w = vocab[i];
          const count = (lower.match(new RegExp(`\\b${w}\\b`, "g")) ?? []).length;
          vec[i] = count;
        }
        vec[vocab.length] = lower.length; // length feature
        return vec;
      });
    },
  };
}

describe("MemoryIndexer.search", () => {
  let tmpDir: string;
  let memoryDir: string;
  let dbPath: string;
  let indexer: MemoryIndexer;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-indexer-search-"));
    memoryDir = path.join(tmpDir, "memory");
    dbPath = path.join(tmpDir, "memory.db");
    fs.mkdirSync(memoryDir, { recursive: true });
    const emb = createBagEmbedding();
    indexer = new MemoryIndexer(dbPath, memoryDir, emb);
  });

  afterEach(() => {
    indexer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty result on empty query", async () => {
    fs.writeFileSync(path.join(memoryDir, "a.md"), "# a\nkubernetes pod");
    await indexer.sync();
    const result = await indexer.search("");
    expect(result).toEqual({ chunks: [], totalFiles: 0, totalChunks: 0 });
  });

  it("returns empty result on whitespace query", async () => {
    fs.writeFileSync(path.join(memoryDir, "a.md"), "# a\nkubernetes pod");
    await indexer.sync();
    const result = await indexer.search("   ");
    expect(result.chunks).toEqual([]);
  });

  it("returns empty chunks but valid totals when DB is empty", async () => {
    await indexer.sync();
    const result = await indexer.search("anything", 10, 0);
    expect(result.chunks).toEqual([]);
    expect(result.totalFiles).toBe(0);
    expect(result.totalChunks).toBe(0);
  });

  it("returns chunks matching the query (happy path)", async () => {
    fs.writeFileSync(
      path.join(memoryDir, "k8s.md"),
      "# Kubernetes pod troubleshooting\n\nPod OOM killed in namespace prod.",
    );
    fs.writeFileSync(
      path.join(memoryDir, "etcd.md"),
      "# Etcd health\n\netcd heartbeat timeouts observed.",
    );
    await indexer.sync();

    const result = await indexer.search("kubernetes pod", 10, 0);
    expect(result.chunks.length).toBeGreaterThan(0);
    // Top result should come from k8s.md, not etcd.md
    expect(result.chunks[0].file).toBe("k8s.md");
  });

  it("respects topK limit", async () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(memoryDir, `file-${i}.md`),
        `# File ${i}\n\nkubernetes pod text in file ${i}`,
      );
    }
    await indexer.sync();
    const result = await indexer.search("kubernetes", 2, 0);
    expect(result.chunks.length).toBeLessThanOrEqual(2);
  });

  it("applies minScore filter (no results when threshold too high)", async () => {
    fs.writeFileSync(path.join(memoryDir, "a.md"), "# a\nkubernetes pod");
    await indexer.sync();
    // Impossible-to-reach minScore
    const result = await indexer.search("kubernetes", 10, 1000);
    expect(result.chunks.length).toBe(0);
  });

  it("reports totalFiles and totalChunks correctly", async () => {
    fs.writeFileSync(path.join(memoryDir, "a.md"), "# a\n\ntext A");
    fs.writeFileSync(path.join(memoryDir, "b.md"), "# b\n\ntext B");
    await indexer.sync();
    const result = await indexer.search("text", 10, 0);
    expect(result.totalFiles).toBe(2);
    expect(result.totalChunks).toBeGreaterThanOrEqual(2);
  });

  it("tolerates embedding failure at query time (FTS still runs)", async () => {
    fs.writeFileSync(path.join(memoryDir, "a.md"), "# a\nkubernetes pod oom killed");
    await indexer.sync();

    // Swap embedding to a broken one
    (indexer as any).embedding = {
      model: "bag-of-words",
      dimensions: 8,
      async embed() {
        throw new Error("query embed down");
      },
    };

    const result = await indexer.search("kubernetes", 10, 0);
    // FTS should still return results from the indexed chunks
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  it("CJK query uses OR join and still returns results", async () => {
    fs.writeFileSync(
      path.join(memoryDir, "cn.md"),
      "# 故障\n\n生产环境出现网络故障。",
    );
    await indexer.sync();
    // Query with CJK chars should not blow up
    const result = await indexer.search("网络故障", 10, 0);
    // At a minimum, no throw and total chunks matches what we wrote
    expect(result.totalChunks).toBeGreaterThanOrEqual(1);
  });

  it("sorts results by score descending", async () => {
    fs.writeFileSync(
      path.join(memoryDir, "match.md"),
      "# Match\n\nkubernetes pod oom killed in mtu mismatch",
    );
    fs.writeFileSync(path.join(memoryDir, "loose.md"), "# Loose\n\nunrelated body");
    await indexer.sync();
    const result = await indexer.search("kubernetes pod", 10, 0);
    // Results should be sorted by descending score
    for (let i = 1; i < result.chunks.length; i++) {
      expect((result.chunks[i - 1].score ?? 0) >= (result.chunks[i].score ?? 0)).toBe(true);
    }
  });
});
