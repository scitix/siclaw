import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createEmbeddingProvider } from "../memory/embeddings.js";
import { MemoryIndexer, type MemorySearchConfig } from "../memory/indexer.js";
import type { MemoryIndexerOpts } from "../memory/index.js";

const KNOWLEDGE_SEARCH_CONFIG: MemorySearchConfig = {
  temporalDecay: { enabled: false },
  mmr: { enabled: true, lambda: 0.75 },
};

/**
 * Build a durable hybrid index for exactly one mounted knowledge directory.
 * The database stays outside the atomically replaced knowledge mount.
 */
export function createKnowledgeIndexer(
  knowledgeDir: string,
  indexRoot: string,
  embeddingOpts?: MemoryIndexerOpts,
): MemoryIndexer {
  const resolvedKnowledgeDir = path.resolve(knowledgeDir);
  const scope = createHash("sha256").update(resolvedKnowledgeDir).digest("hex").slice(0, 24);
  fs.mkdirSync(resolvedKnowledgeDir, { recursive: true });
  fs.mkdirSync(indexRoot, { recursive: true });
  return new MemoryIndexer(
    path.join(indexRoot, `${scope}.db`),
    resolvedKnowledgeDir,
    createEmbeddingProvider(embeddingOpts),
    KNOWLEDGE_SEARCH_CONFIG,
  );
}
