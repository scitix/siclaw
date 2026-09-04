import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

/**
 * The AgentBox image only contains SOME of `src/`. Anything it imports from
 * outside that set typechecks locally and then fails `docker build` with
 * `Cannot find module`.
 *
 * ⚠️ **`tsconfig.agentbox.json` CANNOT catch this.** It typechecks against a
 * full working tree, where `../lib/…` resolves perfectly well. The real
 * boundary is `Dockerfile.agentbox`'s COPY list, and until this test existed
 * the image build was the only thing that enforced it — a 10-minute Docker
 * build, on a build host, after everything local was green.
 *
 * That is not hypothetical: the session-resume work put
 * SESSION_CONTEXT_UNAVAILABLE into `lib/error-envelope.ts` and imported
 * `ErrorCodes` from there in `agentbox/http-server.ts`. Local typecheck passed,
 * 300 test files passed, and the agentbox image would not build.
 *
 * The allowed set is READ FROM THE DOCKERFILE rather than restated here, so
 * adding a COPY line is all it takes to widen it — a second list would drift.
 */
describe("AgentBox image boundary", () => {
  const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile.agentbox"), "utf8");
  const allowedDirs = [...dockerfile.matchAll(/^COPY\s+src\/([a-z0-9-]+)\/\s/gim)].map((m) => m[1]);
  const allowedFiles = [...dockerfile.matchAll(/^COPY\s+(src\/[^\s]+\.ts)\s/gim)].map((m) => m[1]);

  it("reads a non-empty allowed set from Dockerfile.agentbox", () => {
    // A regex that silently matched nothing would make every assertion below vacuous.
    expect(allowedDirs).toContain("agentbox");
    expect(allowedDirs).toContain("shared");
    expect(allowedDirs.length).toBeGreaterThan(4);
  });

  it("actually scans the files it claims to", () => {
    // The guard on the guard: a pathspec that matches almost nothing makes the
    // assertion below vacuous, which is how the first version of this test
    // passed while the offending import was still there.
    const files = execSync(`git ls-files ${allowedDirs.map((d) => `'src/${d}/'`).join(" ")}`, {
      cwd: repoRoot,
      encoding: "utf8",
    }).split("\n").filter((f) => f.trim().endsWith(".ts"));
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain("src/agentbox/http-server.ts");
  });

  it("never imports from a directory the image does not contain", () => {
    // ⚠️ Directory pathspecs, NOT `src/<d>/**/*.ts`. In git's pathspec globs `**/`
    // requires at least one directory, so that pattern matched ONE file out of 25
    // in src/agentbox and skipped http-server.ts — the very file that broke the
    // image build. The first version of this test passed with the bad import
    // still in place.
    const files = execSync(`git ls-files ${allowedDirs.map((d) => `'src/${d}/'`).join(" ")}`, {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

    const offenders: string[] = [];
    for (const file of files) {
      const body = readFileSync(resolve(repoRoot, file), "utf8");
      // Only real module specifiers — `from "…"` and `import("…")`.
      for (const m of body.matchAll(/(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g)) {
        const spec = m[1];
        // Resolve the specifier against the importing file to get a repo-relative path.
        const abs = resolve(resolve(repoRoot, file), "..", spec);
        const rel = abs.slice(repoRoot.length + 1);
        if (!rel.startsWith("src/")) continue;
        const segment = rel.split("/")[1];
        if (allowedDirs.includes(segment)) continue;
        // A single whitelisted FILE from an otherwise-excluded directory is fine.
        const asTs = rel.replace(/\.js$/, ".ts");
        if (allowedFiles.includes(asTs)) continue;
        offenders.push(`${file} → ${spec}`);
      }
    }

    expect(offenders, "these imports resolve outside Dockerfile.agentbox's COPY list, so the image will not build").toEqual([]);
  });
});
