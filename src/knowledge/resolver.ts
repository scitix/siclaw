import type { MemoryIndexer } from "../memory/indexer.js";
import type { MemoryChunk, MemorySearchResult } from "../memory/types.js";
import { KnowledgeLabelIndex, type KnowledgeLabelCatalogResult } from "./labels.js";

/**
 * Keeps deterministic label routing usable while the heavier content index is
 * still hydrating. Content retrieval remains an optional peer signal rather
 * than an implementation dependency of labels.
 */
export class KnowledgeResolver {
  private contentReady = false;
  private contentSync: Promise<void> | null = null;
  private contentResyncRequested = false;
  private closed = false;
  private contentClosed = false;

  constructor(
    private readonly labels: KnowledgeLabelIndex,
    private readonly content: MemoryIndexer,
  ) {}

  async sync(): Promise<void> {
    if (this.closed) return;
    await this.labels.sync();
    this.contentReady = false;
    if (this.contentSync) {
      this.contentResyncRequested = true;
      return;
    }
    this.startContentSync();
  }

  private startContentSync(): void {
    if (this.closed || this.contentSync) return;
    this.contentSync = this.content.sync()
      .then(() => { this.contentReady = true; })
      .catch((error) => {
        this.contentReady = false;
        console.warn("[knowledge-resolver] Content index sync failed; label routing remains available:", error);
      })
      .finally(() => {
        this.contentSync = null;
        if (this.closed) {
          this.closeContent();
        } else if (this.contentResyncRequested) {
          this.contentResyncRequested = false;
          this.contentReady = false;
          this.startContentSync();
        }
      });
  }

  async waitForContentIndex(): Promise<void> {
    if (!this.closed) this.startContentSync();
    while (this.contentSync) {
      await this.contentSync;
    }
  }

  async search(query: string, topK = 10, minScore = 0): Promise<MemorySearchResult> {
    const labelResult = this.labels.search(query, topK);
    if (!this.contentReady) {
      this.startContentSync();
      return labelResult;
    }

    const contentResult = await this.content.search(query, topK, minScore);
    const merged: MemoryChunk[] = [];
    const seen = new Set<string>();
    const add = (chunk: MemoryChunk) => {
      const key = `${chunk.file}\u0000${chunk.heading}\u0000${chunk.startLine}`;
      if (seen.has(key)) return;
      seen.add(key);
      const labels = this.labels.labelsForFile(chunk.file);
      merged.push({
        ...chunk,
        ...(labels.length > 0 ? { labels } : {}),
        matchedLabels: chunk.matchedLabels ?? this.labels.matchedLabelsForFile(chunk.file, query),
      });
    };
    // Interleave the two channels so a broad/common label cannot crowd all
    // content candidates out of the bounded result window.
    const candidateCount = Math.max(labelResult.chunks.length, contentResult.chunks.length);
    for (let i = 0; i < candidateCount && merged.length < topK; i++) {
      const labelChunk = labelResult.chunks[i];
      const contentChunk = contentResult.chunks[i];
      if (labelChunk) add(labelChunk);
      if (contentChunk && merged.length < topK) add(contentChunk);
    }
    return {
      chunks: merged.slice(0, topK),
      totalFiles: Math.max(labelResult.totalFiles, contentResult.totalFiles),
      totalChunks: contentResult.totalChunks,
      retrievalMode: labelResult.chunks.length > 0 ? "labels+content" : "content",
      contentIndexReady: true,
      totalLabels: labelResult.totalLabels,
    };
  }

  catalog(opts: { query?: string; facet?: string; offset?: number; limit?: number } = {}): KnowledgeLabelCatalogResult {
    return this.labels.catalog(opts);
  }

  close(): void {
    this.closed = true;
    this.contentResyncRequested = false;
    if (!this.contentSync) this.closeContent();
  }

  private closeContent(): void {
    if (this.contentClosed) return;
    this.contentClosed = true;
    this.content.close();
  }
}
