import path from "node:path";

import { KnowledgeLabelIndex } from "./labels.js";
import { KnowledgeResolver } from "./resolver.js";
import { KnowledgeLookupIndex } from "./lookup.js";

/**
 * Build label navigation and lazy body lookup for one mounted directory.
 * The disposable FTS index is built only on the first lookup, without embeddings.
 */
export function createKnowledgeResolver(knowledgeDir: string): KnowledgeResolver {
  const resolvedKnowledgeDir = path.resolve(knowledgeDir);
  return new KnowledgeResolver(new KnowledgeLabelIndex(resolvedKnowledgeDir), new KnowledgeLookupIndex(resolvedKnowledgeDir));
}

export { KnowledgeResolver } from "./resolver.js";
