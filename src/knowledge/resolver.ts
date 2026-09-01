import {
  KnowledgeLabelIndex,
  type KnowledgeLabelCatalogResult,
  type KnowledgeResolutionResult,
} from "./labels.js";

/**
 * Resolves mounted knowledge pages exclusively from typed page labels.
 *
 * The complete root index is injected separately as the compatibility route
 * for unlabeled packages. This resolver never reads page bodies, opens an
 * embedding provider, or builds an FTS/vector database; callers must Read the
 * selected page before treating it as evidence.
 */
export class KnowledgeResolver {
  private closed = false;

  constructor(private readonly labels: KnowledgeLabelIndex) {}

  async sync(): Promise<void> {
    if (this.closed) return;
    await this.labels.sync();
  }

  search(query: string, topK = 10): KnowledgeResolutionResult {
    if (this.closed) return { pages: [], totalPages: 0, totalLabels: 0 };
    return this.labels.search(query, topK);
  }

  catalog(opts: { query?: string; facet?: string; offset?: number; limit?: number } = {}): KnowledgeLabelCatalogResult {
    if (this.closed) {
      return { labels: [], totalLabels: 0, totalPages: 0, offset: 0, hasMore: false };
    }
    return this.labels.catalog(opts);
  }

  close(): void {
    this.closed = true;
  }
}
