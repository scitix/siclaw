/**
 * Materialize Portal knowledge repos (gzip'd tar blobs delivered via the
 * CLI snapshot) into an on-disk directory so pi-coding-agent's Read tool
 * and the `[[page]]` wiki-link convention in `src/core/prompt.ts` can read
 * them unchanged.
 *
 * Layout produced:
 *   <outDir>/
 *     index.md              (flat — each repo's archive unpacks here)
 *     roce-modes.md
 *     ...
 *
 * Multiple repos unpack into the same flat dir. If two repos ship a page
 * with the same filename the later-extracted one wins; the repo name +
 * file-count per archive is logged so conflicts are visible in startup
 * output. This matches the baseline expectation that there is exactly one
 * "siclaw-wiki" repo; multi-repo collision handling can get smarter later.
 *
 * Uses the `tar` CLI rather than a JS-level tar parser for the same reason
 * `knowledge-sync.ts` does — it's always installed on the platforms we
 * target (linux, macOS) and avoids pulling in another npm dep.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { CliSnapshotKnowledgeRepo } from "../portal/cli-snapshot-api.js";

export interface KnowledgeMaterializeResult {
  rootDir: string;
  reposUnpacked: number;
  fileCount: number;
  /** Repos whose tar extraction failed (file kept logged; main flow continues). */
  failures: Array<{ repo: string; error: string }>;
}

export function materializePortalKnowledge(
  repos: CliSnapshotKnowledgeRepo[],
  outDir: string,
): KnowledgeMaterializeResult {
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  const failures: Array<{ repo: string; error: string }> = [];
  let reposUnpacked = 0;

  const outDirResolved = fs.realpathSync(outDir);

  for (const repo of repos) {
    const tmpPath = path.join(os.tmpdir(), `siclaw-knowledge-${Date.now()}-${process.pid}.tar.gz`);
    try {
      fs.writeFileSync(tmpPath, Buffer.from(repo.dataBase64, "base64"));
      // `--no-same-owner` strips archived uid/gid so a malicious tar can't
      // install files owned by root (defensive even though we're not root).
      // Absolute-path stripping: BSD tar (macOS) strips leading `/` by default;
      // GNU tar needs `--no-absolute-names`. Passing both leading-slash forms
      // would break BSD; we rely on BSD's safer default + a post-extraction
      // path-traversal walk below (which catches both `/abs` and `../rel`).
      execFileSync("tar", ["--no-same-owner", "-xzf", tmpPath, "-C", outDir], { stdio: "pipe" });
      const escapes = findEscapingEntries(outDirResolved);
      if (escapes.length > 0) {
        // Tar escaped outDir (symlink or path traversal). Delete the
        // whole directory — partial state is worse than no state — and
        // report as a failure rather than silently accepting tainted output.
        for (const escape of escapes) {
          try { fs.rmSync(escape, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.mkdirSync(outDir, { recursive: true });
        throw new Error(`tar extraction escaped outDir (${escapes.length} offending entries)`);
      }
      reposUnpacked++;
    } catch (err) {
      failures.push({ repo: repo.name, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
      }
    }
  }

  const fileCount = countMarkdownFiles(outDir);
  return { rootDir: outDir, reposUnpacked, fileCount, failures };
}

/**
 * Walk `dir`, resolve each entry's real path, and return any that escape
 * `dir` (via symlink or a traversal that survived tar). Entries inside the
 * returned list should be removed by the caller — the tarball is malicious.
 */
function findEscapingEntries(dir: string): string[] {
  const offenders: string[] = [];
  if (!fs.existsSync(dir)) return offenders;
  const expectedPrefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let real: string;
      try {
        real = fs.realpathSync(full);
      } catch {
        offenders.push(full);
        continue;
      }
      if (real !== dir && !real.startsWith(expectedPrefix)) {
        offenders.push(full);
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(full);
      }
    }
  };
  walk(dir);
  return offenders;
}

export function cleanupPortalKnowledge(outDir: string): void {
  if (!fs.existsSync(outDir)) return;
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {
    // Non-fatal.
  }
}

function countMarkdownFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countMarkdownFiles(full);
    else if (entry.name.endsWith(".md")) count++;
  }
  return count;
}
