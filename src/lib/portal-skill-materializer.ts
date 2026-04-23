/**
 * Materialize Portal skills (returned in a `CliSnapshot`) to an on-disk
 * directory so pi-coding-agent's `DefaultResourceLoader` — which resolves
 * skills by walking a filesystem tree — can read them unchanged.
 *
 * Layout produced:
 *   <outDir>/
 *     <skill-name-1>/
 *       SKILL.md              (from `specs`)
 *       scripts/              (if scripts[] is non-empty)
 *         <script-name>.sh    (mode 0755)
 *     <skill-name-2>/
 *       ...
 *
 * The destination is wiped on each call so stale content from a previous
 * session doesn't leak into this one; caller is expected to nest it under
 * `.siclaw/.portal-snapshot/skills/` so it's obviously ephemeral.
 */

import fs from "node:fs";
import path from "node:path";
import type { CliSnapshotSkill } from "../portal/cli-snapshot-api.js";

/** Names that would try to escape the destination dir. Defence-in-depth. */
const UNSAFE_NAME = /(^\.\.$)|(\/)|(\\)|(\0)/;

export interface MaterializeResult {
  /** Absolute path to the root dir holding all materialized skills. */
  rootDir: string;
  /** Count of skills successfully written; skills with unsafe names are skipped. */
  count: number;
  /** Names that were rejected (for visibility). */
  skipped: string[];
}

/**
 * Write a set of snapshot skills under `outDir`. Returns the same `outDir` plus
 * counters. Creates parent dirs as needed. Overwrites anything already there.
 */
export function materializePortalSkills(
  skills: CliSnapshotSkill[],
  outDir: string,
): MaterializeResult {
  // Fresh slate — previous snapshot's skills shouldn't linger.
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  const skipped: string[] = [];
  let count = 0;

  for (const skill of skills) {
    if (!skill.name || UNSAFE_NAME.test(skill.name)) {
      skipped.push(skill.name || "(empty)");
      continue;
    }
    const skillDir = path.join(outDir, skill.name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), skill.specs, "utf-8");

    if (Array.isArray(skill.scripts) && skill.scripts.length > 0) {
      const scriptsDir = path.join(skillDir, "scripts");
      fs.mkdirSync(scriptsDir, { recursive: true });
      for (const script of skill.scripts) {
        if (!script.name || UNSAFE_NAME.test(script.name)) continue;
        const scriptPath = path.join(scriptsDir, script.name);
        fs.writeFileSync(scriptPath, script.content, "utf-8");
        // Mark executable so bash/pod_exec can invoke directly. best-effort on Windows.
        try { fs.chmodSync(scriptPath, 0o755); } catch { /* non-POSIX */ }
      }
    }
    count++;
  }

  return { rootDir: outDir, count, skipped };
}

/**
 * Remove a previously-materialized directory. Called on TUI shutdown so we
 * don't leave stale trees around. Safe to call if the dir doesn't exist.
 */
export function cleanupPortalSkills(outDir: string): void {
  if (!fs.existsSync(outDir)) return;
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {
    // Non-fatal: worst case is a leftover tmpdir.
  }
}
