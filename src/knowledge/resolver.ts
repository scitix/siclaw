import {
  KnowledgeLabelIndex,
  type KnowledgeLabelCatalogResult,
  type KnowledgeResolutionResult,
} from "./labels.js";
import { KnowledgeLookupIndex, type LookupOptions, type LookupResult } from "./lookup.js";

/**
 * Keeps label navigation and optional body lookup scoped to one Agent mount.
 */
export class KnowledgeResolver {
  private closed = false;

  constructor(private readonly labels: KnowledgeLabelIndex, private readonly content?: KnowledgeLookupIndex) {}

  get supportsLookup(): boolean { return Boolean(this.content) && !this.closed; }

  async lookup(options: LookupOptions, signal?: AbortSignal): Promise<LookupResult> {
    if (this.closed || !this.content) throw new Error("Knowledge lookup is unavailable.");
    return this.content.lookup(options, signal);
  }

  async sync(): Promise<void> {
    if (this.closed) return;
    this.content?.invalidate();
    await this.labels.sync();
  }

  search(query: string, topK = 10): KnowledgeResolutionResult {
    if (this.closed) return {
      pages: [], matchedPages: 0, totalPages: 0, totalLabels: 0,
      invalidLabeledPages: 0, unlabeledPages: 0, unreachableLabeledPages: 0,
    };
    return this.labels.search(query, topK);
  }

  catalog(opts: { query?: string; facet?: string; offset?: number; limit?: number } = {}): KnowledgeLabelCatalogResult {
    if (this.closed) {
      return {
        labels: [], totalLabels: 0, totalPages: 0, offset: 0, hasMore: false,
        invalidLabeledPages: 0, unlabeledPages: 0, unreachableLabeledPages: 0,
      };
    }
    return this.labels.catalog(opts);
  }

  close(): void {
    this.closed = true;
    this.content?.close();
  }
}
