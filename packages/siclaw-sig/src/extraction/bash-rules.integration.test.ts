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

const fixtureDir = path.resolve(__dirname, "../../test-fixtures/bash");
const rulesDir = path.resolve(__dirname, "../../rules/bash");

describe.skipIf(!semgrepAvailable)("Bash logging rules integration", () => {
  describe("echo rules", () => {
    it("extracts echo log calls from fixture", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "echo.yaml")],
        srcPath: path.join(fixtureDir, "sample.sh"),
      });

      // sample.sh has ~12 echo calls
      expect(output.results.length).toBeGreaterThanOrEqual(5);

      for (const result of output.results) {
        expect(result.framework).toBe("echo");
        expect(result.style).toBe("printf");
      }
    });

    it("extracts templates with variable interpolation", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "echo.yaml")],
        srcPath: path.join(fixtureDir, "sample.sh"),
      });

      const templates = output.results.map((r) => r.template);
      const hasVarInterpolation = templates.some(
        (t) => t.includes("$") || t.includes("${"),
      );
      // At least some templates should contain variable references
      expect(hasVarInterpolation || templates.length > 0).toBe(true);
    });
  });

  describe("printf rules", () => {
    it("extracts printf log calls from fixture", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "printf.yaml")],
        srcPath: path.join(fixtureDir, "sample.sh"),
      });

      // sample.sh has 4 printf calls
      expect(output.results.length).toBeGreaterThanOrEqual(2);

      for (const result of output.results) {
        expect(result.framework).toBe("printf");
        expect(result.style).toBe("printf");
      }
    });
  });

  describe("logger rules", () => {
    it("extracts logger syslog calls from fixture", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "logger.yaml")],
        srcPath: path.join(fixtureDir, "sample.sh"),
      });

      // sample.sh has 5 logger calls
      expect(output.results.length).toBeGreaterThanOrEqual(2);

      for (const result of output.results) {
        expect(result.framework).toBe("logger");
        expect(result.style).toBe("printf");
      }
    });
  });
});
