import fs from "node:fs";
import path from "node:path";

/**
 * Library (multi-repository) awareness for one mounted knowledge directory.
 *
 * A mount holds either ONE library (its own `index.md` is the root catalog) or
 * SEVERAL, each unpacked under its own root with the root `index.md` listing one
 * line per library (`sync-handlers.ts` writes `- [[<root>/index]] - <name> v<n>
 * — <domain>`). Nothing here introduces a new data format: library roots come
 * from the materializer's `.citation-manifest.json` (authoritative, no hardcoded
 * `repos/` layout), and the display name / domain come from the root catalog
 * line the Agent already sees in its prompt.
 *
 * Name and domain are model-written routing metadata. They are used only for
 * matching and display, never executed, and are collapsed to one line by the
 * materializer before they reach disk.
 */
export interface KnowledgeLibraryInfo {
  /** Library root relative to the knowledge dir, "" for the single-library mount. */
  root: string;
  /** Display name from the root catalog line, or the root directory name. */
  name: string;
  /** One-sentence field description from the root catalog line, "" when absent. */
  domain: string;
  /** Library version from the root catalog line, null when absent. */
  version: number | null;
}

const CITATION_MANIFEST = ".citation-manifest.json";

/** `- [[repos/dir/index]] - Name v3 — domain` or `- [Name](repos/dir/index.md) - Name v3 — domain`. */
const CATALOG_LINE_RE =
  /^\s*[-*]\s+(?:\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]|\[[^\]]*\]\(([^)\s]+)\))\s*(?:-\s*(.*))?$/;
const NAME_VERSION_RE = /^(.*?)\s+v(\d+)\s*(?:—\s*(.*))?$/;

function normalizeRoot(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
}

function libraryRootFromLink(target: string): string | null {
  const clean = normalizeRoot(target.trim());
  const withoutIndex = clean.replace(/(?:^|\/)index(?:\.md)?$/, "");
  if (withoutIndex === clean) return null; // not an index link
  return withoutIndex;
}

/** Roots the materializer declared, "" meaning the root library. Empty when no manifest. */
export function readManifestLibraryRoots(knowledgeDir: string): string[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(knowledgeDir, CITATION_MANIFEST), "utf-8")) as {
      repos?: Array<{ root?: string }>;
    };
    if (!Array.isArray(parsed?.repos)) return null;
    return parsed.repos.map((repo) => normalizeRoot(repo.root ?? ""));
  } catch {
    return null;
  }
}

/** Parse the multi-library root catalog into per-root display metadata. */
export function parseRootCatalogLibraries(rootIndex: string): Map<string, Omit<KnowledgeLibraryInfo, "root">> {
  const out = new Map<string, Omit<KnowledgeLibraryInfo, "root">>();
  for (const line of rootIndex.split(/\r?\n/)) {
    const match = CATALOG_LINE_RE.exec(line);
    if (!match) continue;
    const root = libraryRootFromLink(match[1] ?? match[2] ?? "");
    if (root === null || root === "") continue;
    const rest = (match[3] ?? "").trim();
    const nv = NAME_VERSION_RE.exec(rest);
    if (nv) {
      out.set(root, { name: nv[1].trim() || path.posix.basename(root), version: Number(nv[2]), domain: (nv[3] ?? "").trim() });
    } else {
      const [name, ...domainParts] = rest.split("—");
      out.set(root, { name: name.trim() || path.posix.basename(root), version: null, domain: domainParts.join("—").trim() });
    }
  }
  return out;
}

/**
 * Discover the libraries of a mount. Returns a single entry with root "" for a
 * single-library mount (or a mount without manifest and without library links),
 * so callers can treat "one library" and "no library dimension" identically.
 */
export function discoverKnowledgeLibraries(knowledgeDir: string): KnowledgeLibraryInfo[] {
  let rootIndex = "";
  try { rootIndex = fs.readFileSync(path.join(knowledgeDir, "index.md"), "utf-8"); } catch { /* no catalog */ }
  const fromCatalog = parseRootCatalogLibraries(rootIndex);
  const manifestRoots = readManifestLibraryRoots(knowledgeDir);

  const roots = manifestRoots && manifestRoots.some((root) => root !== "")
    ? manifestRoots.filter((root) => root !== "")
    : [...fromCatalog.keys()];

  if (roots.length === 0) {
    return [{ root: "", name: "", domain: "", version: null }];
  }
  return roots.map((root) => {
    const meta = fromCatalog.get(root);
    return {
      root,
      name: meta?.name || path.posix.basename(root),
      domain: meta?.domain ?? "",
      version: meta?.version ?? null,
    };
  });
}

/** The library root a page belongs to, or "" when the mount has no library dimension. */
export function libraryRootForFile(file: string, roots: string[]): string {
  const normalized = normalizeRoot(file);
  let best = "";
  for (const root of roots) {
    if (root && (normalized === root || normalized.startsWith(root + "/")) && root.length > best.length) best = root;
  }
  return best;
}
