import path from "node:path";

/**
 * Return a model-usable path for the current knowledge mount.
 *
 * AgentBox paths are deployment-shaped: K8s normally uses the configured
 * `.siclaw/knowledge` root, while LocalSpawner scopes that root by Agent ID and
 * the Portal CLI may use a cache elsewhere. The model should receive the path
 * that its filesystem tools can actually resolve instead of a hardcoded mount.
 */
export function modelKnowledgePath(knowledgeDir: string, file = ""): string {
  const absolute = path.resolve(knowledgeDir, file);
  const relative = path.relative(process.cwd(), absolute);
  const usable = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
    ? relative || "."
    : absolute;
  return usable.split(path.sep).join("/");
}

export function modelKnowledgeLocations(knowledgeDir: string): {
  wikiRoot: string;
  indexPath: string;
} {
  return {
    wikiRoot: modelKnowledgePath(knowledgeDir),
    indexPath: modelKnowledgePath(knowledgeDir, "index.md"),
  };
}
