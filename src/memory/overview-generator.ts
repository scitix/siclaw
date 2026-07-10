import fs from "node:fs";
import path from "node:path";
import { sanitizeKnowledgeRepoDir } from "../shared/knowledge-package.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OverviewOpts {
  reposDir?: string;
  docsDir?: string;
  memoryEnabled?: boolean;
}

/**
 * Build a concise knowledge overview from content directories.
 * Scans repos/ and docs/ only. Past investigations live under
 * memory/investigations/ but are intentionally NOT auto-injected into the
 * prompt; when memory is enabled the agent can pull them on demand via
 * `memory_search`.
 * Pure sync filesystem scan — no DB dependency.
 * Returns empty string if no knowledge files exist.
 */
export function buildKnowledgeOverview(opts: OverviewOpts): string {
  const { reposDir, docsDir, memoryEnabled = true } = opts;
  const TOTAL_BUDGET = 1200;

  const repoEntries = reposDir ? scanRepos(reposDir) : [];
  const docEntries = docsDir ? scanDocs(docsDir) : [];

  if (repoEntries.length === 0 && docEntries.length === 0) {
    return "";
  }

  const parts: string[] = ["# Knowledge Overview"];
  let currentLen = parts[0].length;

  // --- Code Repositories (~400 chars budget) ---
  if (repoEntries.length > 0) {
    const header = "\n\n## Code Repositories\n| Repo | Files | Top languages |\n|------|-------|--------------|";

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
    const header = "\n\n## Documentation\n| Category | Files |\n|----------|-------|";

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
  parts.push(memoryEnabled
    ? '\n\nUse `read` to view files in repos/ or docs/, or `memory_search` to find specific facts.'
    : '\n\nUse `read` to view files in repos/ or docs/.');

  return parts.join("");
}

/** Max chars of the knowledge wiki catalog (per-KB consumer meta + index) injected into the prompt. */
const KNOWLEDGE_WIKI_BUDGET = 4000;

/**
 * Hard cap per KB meta entry, regardless of how much of the total budget is
 * free — a routing note must stay a road sign even when only one KB is bound
 * (2026-07-10 live review: an even 4000-split let a lone KB balloon into a
 * page inventory). The box-side generation caps (selfcheck CONSUMER_META_*:
 * summary ≤80 cp, ≤3 not-for ×20) keep a well-formed entry comfortably under
 * this; the cap only bites on hand-made/legacy metas.
 */
const CONSUMER_META_ENTRY_BUDGET = 200;

/**
 * Consumer-facing meta a publish injects into a knowledge bundle's root as
 * `_consumer_meta.json` (DESIGN-kb-consumer-meta-2026-07-10): a model-written,
 * owner-approved routing summary generated at compile settle. First layer of
 * the KB's progressive disclosure — it stays resident in the consumer agent's
 * context and decides WHEN to open the wiki at all; the pages stay on-demand.
 */
interface BundleConsumerMeta {
  /** KB display name (from the sync manifest; falls back to the bundle dir). */
  name?: string;
  /** published_version from the meta file, else the sync-manifest version. */
  version?: string;
  summary: string;
  /**
   * Grounded exclusions only (box-side generation traces each to explicit wiki
   * text or the compile exclusion ledger). `when_to_use` was retired 2026-07-10
   * (every item paraphrased the summary); old artifacts may still carry the
   * key — it parses fine (unknown keys are simply not read) and never renders.
   */
  notFor: string[];
}

const CONSUMER_META_FILENAME = "_consumer_meta.json";

/**
 * Read one bundle root's `_consumer_meta.json`. TOLERANT by contract: missing,
 * unreadable, invalid JSON, or an empty summary all return null so the caller
 * falls back to exactly the pre-meta catalog behavior (old published versions
 * and hand-uploaded bundles carry no meta — design D2).
 */
function readBundleConsumerMeta(bundleRoot: string): {
  summary: string; notFor: string[]; publishedVersion?: string;
} | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(bundleRoot, CONSUMER_META_FILENAME), "utf-8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (!summary) return null;
  const strList = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((i): i is string => typeof i === "string" && i.trim().length > 0).map((i) => i.trim())
      : [];
  const pv = obj.published_version;
  return {
    summary,
    notFor: strList(obj.not_for),
    publishedVersion: typeof pv === "string" || typeof pv === "number" ? String(pv) : undefined,
  };
}

/** repos[] of the sync-handler's `.sync-manifest.json` (name/version per bundle); [] when absent. */
function readSyncManifestRepos(knowledgeDir: string): Array<{ name?: string; version?: number | string }> {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(knowledgeDir, ".sync-manifest.json"), "utf-8"));
    return Array.isArray(data?.repos) ? data.repos : [];
  } catch {
    return [];
  }
}

/**
 * Collect consumer metas for every bound bundle. Bundle roots mirror the sync
 * handler's two layouts: a single repo unpacks at `knowledgeDir` itself; multiple
 * repos unpack under `knowledgeDir/repos/<sanitized-name>/` behind a synthetic
 * root index. (The portal flat-merge path also lands at the root — same-name
 * last-wins there, consistent with every other file in that path.)
 */
function collectBundleConsumerMetas(knowledgeDir: string): BundleConsumerMeta[] {
  const manifest = readSyncManifestRepos(knowledgeDir);
  const out: BundleConsumerMeta[] = [];
  const rootMeta = readBundleConsumerMeta(knowledgeDir);
  if (rootMeta) {
    const m = manifest.length === 1 ? manifest[0] : undefined;
    out.push({
      name: m?.name,
      version: rootMeta.publishedVersion ?? (m?.version != null ? String(m.version) : undefined),
      summary: rootMeta.summary,
      notFor: rootMeta.notFor,
    });
  }
  const reposRoot = path.join(knowledgeDir, "repos");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(reposRoot, { withFileTypes: true });
  } catch {
    return out; // single-bundle layout — no repos/ subtree
  }
  const byDir = new Map<string, { name?: string; version?: number | string }>();
  for (const r of manifest) {
    if (r?.name) byDir.set(sanitizeKnowledgeRepoDir(r.name), r);
  }
  for (const entry of entries.filter((e) => isDir(reposRoot, e)).sort((a, b) => a.name.localeCompare(b.name))) {
    const meta = readBundleConsumerMeta(path.join(reposRoot, entry.name));
    if (!meta) continue; // this bundle has no (valid) meta → its synthetic index line stays its only entry
    const m = byDir.get(entry.name);
    out.push({
      name: m?.name ?? entry.name,
      version: meta.publishedVersion ?? (m?.version != null ? String(m.version) : undefined),
      summary: meta.summary,
      notFor: meta.notFor,
    });
  }
  return out;
}

/** Truncate to ~maxLen UTF-16 units without splitting a code point; appends an ellipsis. */
function truncateRuneSafe(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  let out = "";
  for (const cp of s) { // for..of iterates code points — never splits a surrogate pair
    if (out.length + cp.length + 1 > maxLen) break; // +1 reserves the ellipsis
    out += cp;
  }
  return out + "…";
}

/**
 * Render one KB's meta entry within `budget` chars. Degradation order: drop
 * not_for first, then truncate the summary (rune-safe) — the routing signal
 * survives longest. (`when_to_use` retired 2026-07-10; never rendered.)
 */
function formatConsumerMetaEntry(meta: BundleConsumerMeta, budget: number): string {
  // sicore injects published_version already prefixed ("v1"); sync-manifest
  // versions are bare numbers. Normalize so neither renders as "vv1".
  const versionLabel = meta.version ? (meta.version.startsWith("v") ? meta.version : `v${meta.version}`) : "";
  const heading = `### ${meta.name ?? "Knowledge base"}${versionLabel ? ` (${versionLabel})` : ""}`;
  const build = (summary: string, withNotFor: boolean): string => {
    const lines = [heading, summary];
    if (withNotFor && meta.notFor.length > 0) lines.push(`Not for: ${meta.notFor.join("; ")}`);
    return lines.join("\n");
  };
  let entry = build(meta.summary, true);
  if (entry.length <= budget) return entry;
  entry = build(meta.summary, false); // drop not_for first
  if (entry.length <= budget) return entry;
  const overhead = build("", false).length;
  return build(truncateRuneSafe(meta.summary, Math.max(0, budget - overhead)), false);
}

/**
 * Inject the knowledge wiki's page catalog into the system prompt.
 *
 * The wiki is a flat markdown directory at `knowledgeDir` whose `index.md` lists
 * every page with a one-line description (and `[[links]]`). We surface that index
 * directly so the agent sees the catalog in context — no eager Read of index.md,
 * no search tool — and then Reads only the specific page(s) it needs on demand.
 *
 * When a bound bundle carries a published `_consumer_meta.json`, a "Knowledge
 * Bases" section (name + version + summary + grounded not-for per KB) precedes
 * the index — the resident routing layer of the KB's progressive disclosure.
 * Bundles without meta keep exactly the pre-meta behavior (fallback, design D2).
 *
 * Returns "" when there is no wiki (no index.md). Budgeted to
 * KNOWLEDGE_WIKI_BUDGET overall: each meta entry gets min(the even split,
 * CONSUMER_META_ENTRY_BUDGET) — the hard per-entry cap keeps a lone bound KB
 * from ballooning — degrading not_for → summary truncation;
 * the index is truncated within whatever remains, with a pointer to read the
 * full file. topics is deliberately NOT rendered (file-only metadata).
 */
export function buildKnowledgeWikiCatalog(knowledgeDir?: string): string {
  if (!knowledgeDir) return "";
  const indexPath = path.join(knowledgeDir, "index.md");
  let index: string;
  try {
    index = fs.readFileSync(indexPath, "utf-8").trim();
  } catch {
    return "";
  }
  if (!index) return "";

  let metaSection = "";
  let indexBudget = KNOWLEDGE_WIKI_BUDGET;
  const metas = collectBundleConsumerMetas(knowledgeDir);
  if (metas.length > 0) {
    const perKb = Math.min(CONSUMER_META_ENTRY_BUDGET, Math.floor(KNOWLEDGE_WIKI_BUDGET / metas.length));
    metaSection = metas.map((m) => formatConsumerMetaEntry(m, perKb)).join("\n\n");
    indexBudget = Math.max(0, KNOWLEDGE_WIKI_BUDGET - metaSection.length);
  }

  let catalog = index;
  let truncated = false;
  if (catalog.length > indexBudget) {
    catalog = catalog.slice(0, indexBudget);
    // Drop a trailing partial line so the catalog ends cleanly.
    const lastNl = catalog.lastIndexOf("\n");
    if (lastNl > 0) catalog = catalog.slice(0, lastNl);
    truncated = true;
  }

  return [
    "# Knowledge Wiki",
    "",
    "Internal infrastructure knowledge lives as markdown pages under `.siclaw/knowledge/`. " +
    "The page catalog is below — there is no search tool. Read only the page(s) relevant to the task " +
    "with the Read tool (`.siclaw/knowledge/<name>.md`), read whole pages (each is self-contained), and " +
    "follow any `[[other-page]]` link the same way. Don't read unrelated pages. Pages are semantic — they " +
    "describe what components are and how they fail, not the commands to run; translate what you learn into " +
    "concrete checks using skills (preferred) and bash.",
    ...(metaSection ? ["", "## Knowledge Bases", "", metaSection] : []),
    "",
    catalog,
    ...(truncated
      ? ["", "_(Catalog truncated — read `.siclaw/knowledge/index.md` for the complete list.)_"]
      : []),
  ].join("\n");
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
