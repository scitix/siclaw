import path from "node:path";

/**
 * Return a path the model can pass directly to its filesystem tools.
 * AgentBox mounts may be workspace-relative, Agent-scoped, or outside cwd.
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
