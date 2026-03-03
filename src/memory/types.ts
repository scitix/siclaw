export interface MemoryChunk {
  file: string;       // relative path within memory dir
  heading: string;    // markdown heading context (breadcrumb)
  content: string;    // chunk text
  startLine: number;  // 1-indexed start line in source file
  endLine: number;    // 1-indexed end line (inclusive)
  score?: number;     // search relevance score
}

export interface MemorySearchResult {
  chunks: MemoryChunk[];
  totalFiles: number;
  totalChunks: number;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
  model: string;
  /** Max input tokens per text. Texts exceeding this are truncated before embedding. */
  maxInputTokens?: number;
}
