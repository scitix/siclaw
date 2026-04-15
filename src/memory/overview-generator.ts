import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OverviewOpts {
  reposDir?: string;
  docsDir?: string;
}

/**
 * Build a concise knowledge overview from content directories.
 * Scans repos/ and docs/ only. Past investigations live under
 * memory/investigations/ but are intentionally NOT auto-injected into the
 * prompt — the agent pulls them on demand via the `memory_search` tool.
 * Pure sync filesystem scan — no DB dependency.
 * Returns empty string if no knowledge files exist.
 */
export function buildKnowledgeOverview(opts: OverviewOpts): string {
  const { reposDir, docsDir } = opts;
  const TOTAL_BUDGET = 1200;

  const repoEntries = reposDir ? scanRepos(reposDir) : [];
  const docEntries = docsDir ? scanDocs(docsDir) : [];

  if (repoEntries.length === 0 && docEntries.length === 0) {
    return "";
  }

  const parts: string[] = ["## Knowledge Overview"];
  let currentLen = parts[0].length;

  // --- Code Repositories (~400 chars budget) ---
  if (repoEntries.length > 0) {
    const header = "\n\n### Code Repositories\n| Repo | Files | Top languages |\n|------|-------|--------------|";

    const rows: string[] = [];
    let sectionLen = header.length;
    for (const entry of repoEntries) {
      const langs = entry.topExtensions.length > 0 ? entry.topExtensions.join(", ") : "-";
      const row = `\n| ${entry.name} | ${entry.fileCount} | ${langs} |`;
      if (currentLen + sectionLen + row.length > TOTAL_BUDGET - 400) break; // reserve for docs + footer
      rows.push(row);
      sectionLen += row.length;
    }

    if (rows.length > 0) {
      parts.push(header + rows.join(""));
      currentLen += sectionLen;
    }
  }

  // --- Documentation (~300 chars budget) ---
  if (docEntries.length > 0) {
    const header = "\n\n### Documentation\n| Category | Files |\n|----------|-------|";

    const rows: string[] = [];
    let sectionLen = header.length;
    for (const entry of docEntries) {
      const row = `\n| ${entry.category} | ${entry.fileCount} |`;
      if (currentLen + sectionLen + row.length > TOTAL_BUDGET - 100) break; // reserve for footer
      rows.push(row);
      sectionLen += row.length;
    }

    if (rows.length > 0) {
      parts.push(header + rows.join(""));
      currentLen += sectionLen;
    }
  }

  // --- Footer ---
  parts.push('\n\nUse `read` to view files in repos/ or docs/, or `memory_search` to find specific facts.');

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RepoInfo {
  name: string;
  fileCount: number;
  topExtensions: string[];
}

interface DocEntry {
  category: string;
  fileCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a Dirent is a directory, following symlinks. */
function isDir(parentDir: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (entry.isSymbolicLink()) {
    try { return fs.statSync(path.join(parentDir, entry.name)).isDirectory(); } catch { return false; }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scanners
// ---------------------------------------------------------------------------

/**
 * Scan repos/ — list top-level subdirectories with recursive file count and top 3 extensions.
 */
function scanRepos(reposDir: string): RepoInfo[] {
  if (!fs.existsSync(reposDir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(reposDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const repos: RepoInfo[] = [];
  for (const entry of entries) {
    if (!isDir(reposDir, entry)) continue;
    const repoPath = path.join(reposDir, entry.name);
    const { fileCount, extensionCounts } = countFilesRecursive(repoPath);
    const topExtensions = getTopExtensions(extensionCounts, 3);
    repos.push({ name: entry.name, fileCount, topExtensions });
  }

  // Sort by file count descending
  repos.sort((a, b) => b.fileCount - a.fileCount);
  return repos;
}

/**
 * Recursively count files and tally extensions in a directory.
 * Skips hidden directories (starting with .) and node_modules.
 */
function countFilesRecursive(dir: string): { fileCount: number; extensionCounts: Map<string, number> } {
  const extensionCounts = new Map<string, number>();
  let fileCount = 0;

  const walk = (d: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith(".") || item.name === "node_modules") continue;
      if (item.isDirectory()) {
        walk(path.join(d, item.name));
      } else if (item.isFile()) {
        fileCount++;
        const ext = path.extname(item.name);
        if (ext) {
          extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
        }
      }
    }
  };

  walk(dir);
  return { fileCount, extensionCounts };
}

function getTopExtensions(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([ext]) => ext);
}

/**
 * Scan docs/ — list subdirectories with file counts, plus top-level files as "(root)".
 */
function scanDocs(docsDir: string): DocEntry[] {
  if (!fs.existsSync(docsDir)) return [];

  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(docsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const entries: DocEntry[] = [];
  let rootFileCount = 0;

  for (const item of items) {
    if (isDir(docsDir, item)) {
      const subPath = path.join(docsDir, item.name);
      const { fileCount } = countFilesRecursive(subPath);
      entries.push({ category: item.name, fileCount });
    } else if (item.isFile() || item.isSymbolicLink()) {
      rootFileCount++;
    }
  }

  if (rootFileCount > 0) {
    entries.push({ category: "(root)", fileCount: rootFileCount });
  }

  // Sort by file count descending, (root) last if tied
  entries.sort((a, b) => b.fileCount - a.fileCount || (a.category === "(root)" ? 1 : -1));
  return entries;
}

