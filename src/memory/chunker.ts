export interface ChunkResult {
  heading: string;  // breadcrumb heading path
  content: string;  // chunk text
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const MAX_CHUNK_CHARS = 2000;

/**
 * Split markdown content into chunks by headings.
 * Tracks heading hierarchy as breadcrumb path.
 * Oversized chunks are further split on paragraph boundaries.
 */
export function chunkMarkdown(text: string): ChunkResult[] {
  const lines = text.split("\n");
  const chunks: ChunkResult[] = [];

  // Track heading hierarchy: headings[level-1] = text
  const headings: string[] = [];
  let currentLines: string[] = [];

  const flush = () => {
    const content = currentLines.join("\n").trim();
    if (!content) return;

    const heading = headings.filter(Boolean).join(" > ");
    if (content.length <= MAX_CHUNK_CHARS) {
      chunks.push({ heading, content });
    } else {
      // Split oversized chunk on paragraph boundaries
      splitByParagraphs(content, heading, chunks);
    }
    currentLines = [];
  };

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      flush();
      const level = match[1].length;
      const title = match[2].trim();
      // Set current level and clear deeper levels
      headings[level - 1] = title;
      headings.length = level;
      currentLines.push(line);
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return chunks;
}

function splitByParagraphs(
  content: string,
  heading: string,
  out: ChunkResult[],
): void {
  const paragraphs = content.split(/\n{2,}/);
  let buffer = "";

  for (const para of paragraphs) {
    // Segment oversized paragraphs (e.g., very long lines, base64 data)
    const segments = para.length > MAX_CHUNK_CHARS ? segmentLongText(para) : [para];
    for (const seg of segments) {
      if (buffer.length + seg.length + 2 > MAX_CHUNK_CHARS && buffer) {
        out.push({ heading, content: buffer.trim() });
        buffer = "";
      }
      buffer += (buffer ? "\n\n" : "") + seg;
    }
  }
  if (buffer.trim()) {
    out.push({ heading, content: buffer.trim() });
  }
}

/** Split text exceeding MAX_CHUNK_CHARS into segments */
function segmentLongText(text: string): string[] {
  const segments: string[] = [];
  for (let start = 0; start < text.length; start += MAX_CHUNK_CHARS) {
    segments.push(text.slice(start, start + MAX_CHUNK_CHARS));
  }
  return segments;
}
