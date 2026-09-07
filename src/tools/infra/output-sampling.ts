/** Character budgets apply to source text; range labels and retrieval hints are extra. */
export const OUTPUT_CHAR_BUDGET = 8_000;
export const OUTPUT_EDGE_MIN_CHARS = 2_000;

export interface OutputRange {
  /** Zero-based, end-exclusive UTF-16 offsets (the same units as String.length). */
  start: number;
  end: number;
}

/** Equal base allocations, with extra head/tail minima and equal blank gaps. */
export function sampleOutputRanges(text: string): OutputRange[] {
  if (text.length <= OUTPUT_CHAR_BUDGET) return [{ start: 0, end: text.length }];
  // At most one sample per budget character for pathological, enormous outputs.
  const count = Math.min(OUTPUT_CHAR_BUDGET, Math.ceil(text.length / OUTPUT_CHAR_BUDGET));
  const headExtra = Math.max(0, OUTPUT_EDGE_MIN_CHARS - Math.floor(OUTPUT_CHAR_BUDGET / count));
  const tailExtra = Math.max(0, OUTPUT_EDGE_MIN_CHARS - (OUTPUT_CHAR_BUDGET - Math.floor((count - 1) * OUTPUT_CHAR_BUDGET / count)));
  const omitted = text.length - OUTPUT_CHAR_BUDGET - headExtra - tailExtra;
  return Array.from({ length: count }, (_, i) => {
    const baseBefore = Math.floor(i * OUTPUT_CHAR_BUDGET / count);
    const keptBefore = baseBefore + (i > 0 ? headExtra : 0);
    let start = keptBefore + Math.round(i * omitted / (count - 1));
    let end = start + Math.floor((i + 1) * OUTPUT_CHAR_BUDGET / count) - baseBefore
      + (i === 0 ? headExtra : 0) + (i === count - 1 ? tailExtra : 0);
    // Avoid splitting emoji. Only expand outward when shrinking would violate
    // an edge's 2k minimum (at most one extra UTF-16 unit per edge).
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1])) {
      start += i === count - 1 && end - start <= OUTPUT_EDGE_MIN_CHARS ? -1 : 1;
    }
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]) && /[\uD800-\uDBFF]/.test(text[end - 1])) {
      end += i === 0 && end - start <= OUTPUT_EDGE_MIN_CHARS ? 1 : -1;
    }
    return { start, end };
  });
}

export function outputLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

export function outputLineAt(starts: number[], offset: number): number {
  let low = 0, high = starts.length;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid;
  }
  return low + 1;
}

export interface OmittedOutputBlock extends OutputRange {
  id: number;
  startLine: number;
  endLine: number;
}

/** Stable 1-based gap ids, shared by the preview and its expansion tool. */
export function omittedOutputBlocks(ranges: OutputRange[], starts: number[]): OmittedOutputBlock[] {
  const blocks: OmittedOutputBlock[] = [];
  for (let i = 1; i < ranges.length; i++) {
    const start = ranges[i - 1].end;
    const end = ranges[i].start;
    if (end > start) blocks.push({
      id: blocks.length + 1, start, end,
      startLine: outputLineAt(starts, start), endLine: outputLineAt(starts, end - 1),
    });
  }
  return blocks;
}

/** Keep retrieval breadcrumbs through every subsequent context/persistence trim. */
export function outputReferences(text: string): string {
  return [...new Set(text.match(/^\[siclaw-output [^\r\n]+\]$/gm) ?? [])].join("\n");
}

export function preserveOutputReferences(original: string, replacement: string): string {
  const refs = outputReferences(original).split("\n").filter((line) => line && !replacement.includes(line));
  return refs.length ? `${refs.join("\n")}\n${replacement}` : replacement;
}
