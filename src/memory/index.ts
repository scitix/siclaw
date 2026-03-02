import path from "node:path";
import { MemoryIndexer } from "./indexer.js";
import { createEmbeddingProvider } from "./embeddings.js";

export { MemoryIndexer } from "./indexer.js";
export { createEmbeddingProvider } from "./embeddings.js";
export type { MemoryChunk, MemorySearchResult, EmbeddingProvider } from "./types.js";

export interface MemoryIndexerOpts {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
}

/**
 * Create a MemoryIndexer with default settings.
 * DB stored at {memoryDir}/.memory.db
 */
export async function createMemoryIndexer(memoryDir: string, opts?: MemoryIndexerOpts): Promise<MemoryIndexer> {
  const dbPath = path.join(memoryDir, ".memory.db");
  const embedding = createEmbeddingProvider(opts);
  return new MemoryIndexer(dbPath, memoryDir, embedding);
}
