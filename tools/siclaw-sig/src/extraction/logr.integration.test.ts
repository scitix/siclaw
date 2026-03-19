import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Check if semgrep is available on the system.
 * Integration tests are skipped when semgrep is not installed.
 */
let semgrepAvailable = false;
try {
  execFileSync("semgrep", ["--version"], { timeout: 10_000 });
  semgrepAvailable = true;
} catch {
  // semgrep not found — tests will be skipped
}

// Lazy imports — Plan 01 modules may not exist yet during development.
async function loadRunner() {
  const { runSemgrep } = await import("./semgrep-runner.js");
  return { runSemgrep };
}

const fixtureDir = path.resolve(__dirname, "__fixtures__");
const rulesDir = path.resolve(__dirname, "../../rules/go");

describe.skipIf(!semgrepAvailable)("logr integration tests", () => {
  it("extracts all structured-style logr calls from fixture", async () => {
    const { runSemgrep } = await loadRunner();
    const output = await runSemgrep({
      rulePaths: [path.join(rulesDir, "logr.yaml")],
      srcPath: path.join(fixtureDir, "logr.go"),
    });

    // Info x3 (with kv + zero-kv + chained), Error x1
    expect(output.results.length).toBeGreaterThanOrEqual(4);

    // All results should have logr framework and structured style
    for (const result of output.results) {
      expect(result.framework).toBe("logr");
      expect(result.style).toBe("structured");
    }

    // Error result should contain the message
    const errorResult = output.results.find((r) =>
      r.matchedCode.includes(".Error("),
    );
    expect(errorResult).toBeDefined();
    expect(errorResult!.template).toContain("Failed to reconcile resource");

    // Info with kv should have kvRaw containing key name
    const infoWithKv = output.results.find(
      (r) =>
        r.template.includes("Starting reconciliation") && r.kvRaw !== null,
    );
    expect(infoWithKv).toBeDefined();
    expect(infoWithKv!.kvRaw).toContain("name");

    // Zero-kv Info should have kvRaw === null
    const zeroKvResult = output.results.find(
      (r) =>
        r.template.includes("Reconciliation complete") && r.kvRaw === null,
    );
    expect(zeroKvResult).toBeDefined();

    // Chained logger (log.Info) should also be matched
    const chainedResult = output.results.find((r) =>
      r.template.includes("Sub-reconciler started"),
    );
    expect(chainedResult).toBeDefined();
  });
});
