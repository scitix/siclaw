import { describe, it, expect } from "vitest";
import { mmrRerank, DEFAULT_MMR } from "./mmr.js";

describe("DEFAULT_MMR", () => {
  it("is disabled by default", () => {
    expect(DEFAULT_MMR.enabled).toBe(false);
  });

  it("defaults lambda to 0.7 (balanced, relevance-leaning)", () => {
    expect(DEFAULT_MMR.lambda).toBe(0.7);
  });
});

describe("mmrRerank", () => {
  it("returns a copy (not the same array reference) when disabled", () => {
    const items = [{ content: "a", score: 1 }];
    const out = mmrRerank(items);
    expect(out).toEqual(items);
    expect(out).not.toBe(items);
  });

  it("returns a copy when enabled but input length <= 1", () => {
    const items = [{ content: "only-one", score: 0.9 }];
    const out = mmrRerank(items, { enabled: true });
    expect(out).toEqual(items);
    expect(out).not.toBe(items);
  });

  it("returns empty array for empty input when enabled", () => {
    expect(mmrRerank([], { enabled: true })).toEqual([]);
  });

  it("when lambda=1, sorts purely by score descending", () => {
    const items = [
      { content: "low", score: 0.1 },
      { content: "high", score: 0.9 },
      { content: "mid", score: 0.5 },
    ];
    const out = mmrRerank(items, { enabled: true, lambda: 1 });
    expect(out.map((i) => i.content)).toEqual(["high", "mid", "low"]);
  });

  it("when lambda=0 (max diversity), de-duplicates near-identical content", () => {
    const items = [
      { content: "kube apiserver crash loop", score: 0.9 },
      { content: "kube apiserver crash loop", score: 0.89 }, // duplicate
      { content: "etcd heartbeat timeout", score: 0.5 },
    ];
    const out = mmrRerank(items, { enabled: true, lambda: 0 });
    // With pure diversity, we should not get the duplicate right after the first.
    // The first selection is the top-relevance item; subsequent selections favor different content.
    expect(out.length).toBe(3);
    expect(out[0].content).toBe("kube apiserver crash loop");
    expect(out[1].content).toBe("etcd heartbeat timeout");
  });

  it("reorders to interleave diverse items with diversity-leaning lambda", () => {
    // With lambda=0.2 (mostly diversity), the near-duplicate of the top-relevance
    // item should be demoted below the dissimilar item.
    const items = [
      { content: "pod oom killed in prod namespace", score: 0.95 },
      { content: "pod oom killed in prod ns alt", score: 0.94 }, // very similar
      { content: "network mtu mismatch rdma bandwidth", score: 0.80 },
    ];
    const out = mmrRerank(items, { enabled: true, lambda: 0.2 });
    expect(out.length).toBe(3);
    // Most relevant always first
    expect(out[0].content).toContain("oom killed");
    // Second should be the dissimilar item, not the near-duplicate
    expect(out[1].content).toContain("mtu mismatch");
  });

  it("clamps lambda > 1 to 1 (pure relevance behavior)", () => {
    const items = [
      { content: "a", score: 0.1 },
      { content: "b", score: 0.9 },
    ];
    const out = mmrRerank(items, { enabled: true, lambda: 5 });
    expect(out.map((i) => i.content)).toEqual(["b", "a"]);
  });

  it("clamps lambda < 0 to 0", () => {
    // Should not throw; resulting ordering is well-defined.
    const items = [
      { content: "alpha bravo", score: 0.9 },
      { content: "charlie delta", score: 0.1 },
    ];
    const out = mmrRerank(items, { enabled: true, lambda: -2 });
    expect(out.length).toBe(2);
  });

  it("treats missing score as 0", () => {
    const items = [
      { content: "x" },
      { content: "y", score: 0.5 },
    ];
    const out = mmrRerank(items, { enabled: true, lambda: 1 });
    expect(out[0].content).toBe("y");
  });

  it("handles items with empty content (jaccard similarity = 1 when both empty)", () => {
    const items = [
      { content: "", score: 0.9 },
      { content: "", score: 0.5 },
      { content: "something unique here", score: 0.7 },
    ];
    const out = mmrRerank(items, { enabled: true, lambda: 0.5 });
    expect(out.length).toBe(3);
  });

  it("handles identical scores (tie-breaks are deterministic — all items selected)", () => {
    const items = [
      { content: "apple", score: 0.5 },
      { content: "banana", score: 0.5 },
      { content: "cherry", score: 0.5 },
    ];
    const out = mmrRerank(items, { enabled: true, lambda: 0.7 });
    expect(out.length).toBe(3);
    expect(new Set(out.map((i) => i.content))).toEqual(new Set(["apple", "banana", "cherry"]));
  });
});
