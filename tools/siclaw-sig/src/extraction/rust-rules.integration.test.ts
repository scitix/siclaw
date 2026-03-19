import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let semgrepAvailable = false;
try {
  execFileSync("semgrep", ["--version"], { timeout: 10_000 });
  semgrepAvailable = true;
} catch {
  // semgrep not found — tests will be skipped
}

async function loadRunner() {
  const { runSemgrep } = await import("./semgrep-runner.js");
  return { runSemgrep };
}

const fixtureDir = path.resolve(__dirname, "../../test-fixtures/rust");
const rulesDir = path.resolve(__dirname, "../../rules/rust");

describe.skipIf(!semgrepAvailable)("Rust logging rules integration", () => {
  describe("tracing crate rules", () => {
    it("extracts tracing macro calls from fixture", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "tracing.yaml")],
        srcPath: path.join(fixtureDir, "sample.rs"),
      });

      // sample.rs has 9 tracing macro calls (both bare and tracing:: prefixed)
      expect(output.results.length).toBeGreaterThanOrEqual(7);

      for (const result of output.results) {
        expect(result.framework).toBe("tracing");
        expect(result.style).toBe("printf");
      }
    });

    it("extracts format string templates with {} placeholders", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "tracing.yaml")],
        srcPath: path.join(fixtureDir, "sample.rs"),
      });

      const templates = output.results.map((r) => r.template);
      const podTemplate = templates.find((t) =>
        t.includes("Starting reconciliation"),
      );
      expect(podTemplate).toBeDefined();
    });

    it("handles {:?} debug format specifier", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "tracing.yaml")],
        srcPath: path.join(fixtureDir, "sample.rs"),
      });

      const templates = output.results.map((r) => r.template);
      const debugTemplate = templates.find((t) => t.includes("{:?}"));
      expect(debugTemplate).toBeDefined();
    });
  });

  describe("log crate rules", () => {
    it("extracts log crate macro calls from fixture", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "log-crate.yaml")],
        srcPath: path.join(fixtureDir, "sample.rs"),
      });

      // sample.rs has 2 log:: prefixed calls
      expect(output.results.length).toBeGreaterThanOrEqual(1);

      for (const result of output.results) {
        expect(result.framework).toBe("log");
        expect(result.style).toBe("printf");
      }
    });
  });
});
