import path from "node:path";
import yaml from "js-yaml";

/** Index pages route readers to content; they are not answer evidence. */
export function isKnowledgeNavigationPath(filePath: string): boolean {
  const basename = path.posix.basename(filePath.replaceAll("\\", "/")).toLowerCase();
  return basename === "index.md" || basename === "_index.md";
}

/**
 * Classify a mounted page using both its stable path and compiled frontmatter.
 * The body is optional because retrieval candidates only carry chunks, while
 * citation validation has the exact Read snapshot available.
 */
export function isKnowledgeNavigationPage(filePath: string, body?: string): boolean {
  if (isKnowledgeNavigationPath(filePath)) return true;
  if (!body?.startsWith("---\n")) return false;
  const end = body.indexOf("\n---", 4);
  if (end < 0 || end > 64 * 1024) return false;
  try {
    const frontmatter = yaml.load(body.slice(4, end)) as Record<string, unknown> | null;
    return typeof frontmatter?.type === "string" && frontmatter.type.trim().toLowerCase() === "index";
  } catch {
    return false;
  }
}
