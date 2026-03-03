/**
 * Temporal decay for memory search results.
 * Older memories score lower, evergreen knowledge (MEMORY.md, topic files) is exempt.
 *
 * Ported from openclaw with adaptations for siclaw's MemoryChunk shape.
 */

export interface TemporalDecayConfig {
  enabled: boolean;
  /** Number of days for score to halve. Default: 30 */
  halfLifeDays: number;
}

export const DEFAULT_TEMPORAL_DECAY: TemporalDecayConfig = {
  enabled: false,
  halfLifeDays: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DATED_MEMORY_RE = /(?:^|\/)(\d{4})-(\d{2})-(\d{2})\.md$/;

function toDecayLambda(halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 0;
  return Math.LN2 / halfLifeDays;
}

function parseDate(filePath: string): Date | null {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const match = DATED_MEMORY_RE.exec(normalized);
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const ts = Date.UTC(year, month - 1, day);
  const parsed = new Date(ts);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  return parsed;
}

function isEvergreen(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === "MEMORY.md" || normalized === "memory.md") return true;
  // Non-dated files under memory/ are topic files (evergreen)
  if (normalized.startsWith("memory/") && !DATED_MEMORY_RE.test(normalized)) return true;
  return false;
}

/**
 * Apply temporal decay to search results in-place.
 * Dated files (YYYY-MM-DD.md) get exponential decay; evergreen files are unaffected.
 */
export function applyTemporalDecay<T extends { file: string; score?: number }>(
  results: T[],
  config: Partial<TemporalDecayConfig> = {},
  nowMs = Date.now(),
): T[] {
  const { enabled = DEFAULT_TEMPORAL_DECAY.enabled, halfLifeDays = DEFAULT_TEMPORAL_DECAY.halfLifeDays } = config;
  if (!enabled || results.length === 0) return results;

  const lambda = toDecayLambda(halfLifeDays);
  if (lambda <= 0) return results;

  return results.map((r) => {
    if (isEvergreen(r.file)) return r;
    const date = parseDate(r.file);
    if (!date) return r;
    const ageInDays = Math.max(0, nowMs - date.getTime()) / DAY_MS;
    const multiplier = Math.exp(-lambda * ageInDays);
    return { ...r, score: (r.score ?? 0) * multiplier };
  });
}
