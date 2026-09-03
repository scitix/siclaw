/**
 * Repository hygiene: no NUL bytes in tracked TypeScript sources.
 *
 * A stray NUL makes standard tooling treat the file as BINARY: `grep` silently
 * prints nothing for it and `rg` stops early, so a reviewer greps a file and
 * concludes the pattern is absent when it is merely unreadable. That failure is
 * invisible, which is exactly why it is worth a test rather than a convention.
 * If a control character genuinely belongs in a string (e.g. as a composite map
 * key separator), write it as an escape (`\u0000`) — same runtime value, no
 * unreadable file.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Tracked AND not-yet-tracked sources. `--others --exclude-standard` matters:
 * with `git ls-files` alone a NEW file is invisible to this check until it is
 * committed, so the first version of a file — the one most likely to carry a
 * pasted control character — would be exactly what slips through. (Observed:
 * this very file was authored with a literal NUL in its own doc comment and the
 * tracked-only scan passed.)
 */
function trackedTsFiles(): string[] {
  const out = execSync("git ls-files --cached --others --exclude-standard 'src/**/*.ts'", {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return [...new Set(
    out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  )];
}

describe("repo hygiene", () => {
  it("tracks at least a plausible number of TypeScript sources (guards the test itself)", () => {
    // Without this, a `git ls-files` that returns nothing would make every
    // assertion below vacuously pass.
    expect(trackedTsFiles().length).toBeGreaterThan(50);
  });

  it("has no NUL byte in any tracked src/**/*.ts", () => {
    const offenders: string[] = [];
    for (const file of trackedTsFiles()) {
      let buf: Buffer;
      try {
        buf = readFileSync(file);
      } catch {
        continue; // tracked but absent in this working tree (e.g. sparse checkout)
      }
      const at = buf.indexOf(0);
      if (at >= 0) {
        const line = buf.subarray(0, at).toString("utf8").split("\n").length;
        offenders.push(`${file}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
