/**
 * Maximal Marginal Relevance (MMR) re-ranking.
 * Balances relevance with diversity: MMR = λ * relevance - (1-λ) * max_similarity_to_selected
 *
 * Ported from openclaw with adaptations for siclaw's MemoryChunk shape.
 *
 * @see Carbonell & Goldstein, "The Use of MMR, Diversity-Based Reranking" (1998)
 */

export interface MMRConfig {
  enabled: boolean;
  /** 0 = max diversity, 1 = max relevance. Default: 0.7 */
  lambda: number;
}

export const DEFAULT_MMR: MMRConfig = {
  enabled: false,
  lambda: 0.7,
};

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const t of smaller) {
    if (larger.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Re-rank items using MMR.
 * Items must have `content` (for diversity) and `score` (for relevance).
 */
export function mmrRerank<T extends { content: string; score?: number }>(
  items: T[],
  config: Partial<MMRConfig> = {},
): T[] {
  const { enabled = DEFAULT_MMR.enabled, lambda: rawLambda = DEFAULT_MMR.lambda } = config;
  if (!enabled || items.length <= 1) return [...items];

  const lambda = Math.max(0, Math.min(1, rawLambda));
  if (lambda === 1) return [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // Pre-tokenize
  const tokenCache = new Map<number, Set<string>>();
  for (let i = 0; i < items.length; i++) {
    tokenCache.set(i, tokenize(items[i].content));
  }

  // Normalize scores to [0, 1]
  const scores = items.map((it) => it.score ?? 0);
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const range = maxScore - minScore;
  const normalize = (s: number) => (range === 0 ? 1 : (s - minScore) / range);

  const selected: T[] = [];
  const selectedIdx: number[] = [];
  const remaining = new Set(items.map((_, i) => i));

  while (remaining.size > 0) {
    let bestIdx = -1;
    let bestMMR = -Infinity;

    for (const idx of remaining) {
      const relevance = normalize(scores[idx]);
      // Max similarity to already selected
      let maxSim = 0;
      const tokens = tokenCache.get(idx)!;
      for (const selIdx of selectedIdx) {
        const sim = jaccardSimilarity(tokens, tokenCache.get(selIdx)!);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestMMR || (mmr === bestMMR && scores[idx] > (bestIdx >= 0 ? scores[bestIdx] : -Infinity))) {
        bestMMR = mmr;
        bestIdx = idx;
      }
    }

    if (bestIdx < 0) break;
    selected.push(items[bestIdx]);
    selectedIdx.push(bestIdx);
    remaining.delete(bestIdx);
  }

  return selected;
}
