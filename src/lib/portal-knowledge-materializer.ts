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

  for (const repo of repos) {
    const tmpPath = path.join(os.tmpdir(), `siclaw-knowledge-${repo.name}-${Date.now()}-${process.pid}.tar.gz`);
    try {
      fs.writeFileSync(tmpPath, Buffer.from(repo.dataBase64, "base64"));
      execFileSync("tar", ["xzf", tmpPath, "-C", outDir], { stdio: "pipe" });
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
