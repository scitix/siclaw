import path from "node:path";

import { KnowledgeLabelIndex } from "./labels.js";
import { KnowledgeResolver } from "./resolver.js";

/**
 * Build a labels-only resolver for exactly one mounted knowledge directory.
 * It scans page frontmatter in memory and creates no database or embedding
 * client; the complete root index remains the route for unlabeled packages.
 */
export function createKnowledgeResolver(knowledgeDir: string): KnowledgeResolver {
  const resolvedKnowledgeDir = path.resolve(knowledgeDir);
  return new KnowledgeResolver(new KnowledgeLabelIndex(resolvedKnowledgeDir));
}

export { KnowledgeResolver } from "./resolver.js";
