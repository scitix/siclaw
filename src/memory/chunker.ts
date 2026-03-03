export interface ChunkResult {
  heading: string;     // breadcrumb heading path
  content: string;     // chunk text
  startLine: number;   // 1-indexed start line in source file
  endLine: number;     // 1-indexed end line (inclusive)
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/** Rough token estimate: 1 token ≈ 4 bytes UTF-8 */
function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf-8") / 4);
}

const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_OVERLAP_TOKENS = 80;

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

/**
 * Split markdown content into chunks with heading context and line numbers.
 * Chunks are split by headings first, then by token budget with overlap.
 */
export function chunkMarkdown(text: string, opts?: ChunkOptions): ChunkResult[] {
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = opts?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  const lines = text.split("\n");
  const chunks: ChunkResult[] = [];

  // Track heading hierarchy: headings[level-1] = text
  const headings: string[] = [];

  // Accumulate sections (heading boundary → heading boundary)
  let sectionLines: string[] = [];
  let sectionStart = 1; // 1-indexed

  const flushSection = (endLineExclusive: number) => {
    const content = sectionLines.join("\n").trim();
    if (!content) {
      sectionLines = [];
      sectionStart = endLineExclusive;
      return;
    }

    const heading = headings.filter(Boolean).join(" > ");
    const actualStart = sectionStart;
    const actualEnd = endLineExclusive - 1; // inclusive

    // Split section into token-bounded chunks with overlap
    splitWithOverlap(sectionLines, actualStart, heading, maxTokens, overlapTokens, chunks);

    sectionLines = [];
    sectionStart = endLineExclusive;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(HEADING_RE);
    if (match) {
      flushSection(i + 1); // flush previous section
      const level = match[1].length;
      const title = match[2].trim();
      headings[level - 1] = title;
      headings.length = level;
      sectionLines.push(line);
    } else {
      sectionLines.push(line);
    }
  }
  flushSection(lines.length + 1);

  return chunks;
}

/**
 * Split a section's lines into token-bounded chunks with overlap.
 * Each chunk records its start/end line number (1-indexed).
 */
function splitWithOverlap(
  lines: string[],
  startLineOffset: number,
  heading: string,
  maxTokens: number,
  overlapTokens: number,
  out: ChunkResult[],
): void {
  let i = 0;
  while (i < lines.length) {
    let tokens = 0;
    let j = i;
    // Accumulate lines until token budget reached
    while (j < lines.length) {
      const lineTokens = estimateTokens(lines[j]);
      if (tokens + lineTokens > maxTokens && j > i) break;
      tokens += lineTokens;
      j++;
    }

    const chunkLines = lines.slice(i, j);
    const content = chunkLines.join("\n").trim();
    if (content) {
      out.push({
        heading,
        content,
        startLine: startLineOffset + i,
        endLine: startLineOffset + j - 1,
      });
    }

    if (j >= lines.length) break;

    // Step back by overlap amount
    let overlapCount = 0;
    let backtrack = j;
    while (backtrack > i + 1 && overlapCount < overlapTokens) {
      backtrack--;
      overlapCount += estimateTokens(lines[backtrack]);
    }
    i = backtrack;
  }
}
