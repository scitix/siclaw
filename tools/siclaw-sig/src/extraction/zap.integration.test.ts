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

describe.skipIf(!semgrepAvailable)("zap integration tests", () => {
  describe("zap native rules", () => {
    it("extracts all native structured zap calls from fixture", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "zap-native.yaml")],
        srcPath: path.join(fixtureDir, "zap-native.go"),
      });

      // Info x2, Warn x1, Error x1
      expect(output.results.length).toBeGreaterThanOrEqual(4);

      // All results should have zap framework and structured style
      for (const result of output.results) {
        expect(result.framework).toBe("zap");
        expect(result.style).toBe("structured");
      }

      // $MSG metavar should exist in results (message captured)
      for (const result of output.results) {
        expect(result.metavars).toHaveProperty("$MSG");
      }
    });
  });

  describe("zap sugar printf rules", () => {
    it("extracts all printf-style sugar calls from fixture", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "zap-sugar.yaml")],
        srcPath: path.join(fixtureDir, "zap-sugar.go"),
      });

      // Filter by printf rule
      const printfResults = output.results.filter(
        (r) => r.ruleId === "siclaw.go.zap-sugar-printf",
      );

      // Infof x1, Warnf x1, Errorf x1
      expect(printfResults.length).toBeGreaterThanOrEqual(3);

      // All should have printf style and zap framework
      for (const result of printfResults) {
        expect(result.style).toBe("printf");
        expect(result.framework).toBe("zap");
      }

      // $FMT metavar should contain the format string (quote-stripped)
      const infofResult = printfResults.find((r) =>
        r.matchedCode.includes("Infof"),
      );
      expect(infofResult).toBeDefined();
      expect(infofResult!.template).toContain("Connecting to %s:%d");
    });
  });

  describe("zap sugar structured rules", () => {
    it("extracts all structured-style sugar calls from fixture", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "zap-sugar.yaml")],
        srcPath: path.join(fixtureDir, "zap-sugar.go"),
      });

      // Filter by structured rule
      const structuredResults = output.results.filter(
        (r) => r.ruleId === "siclaw.go.zap-sugar-structured",
      );

      // Infow x1, Warnw x1, Errorw x1
      expect(structuredResults.length).toBeGreaterThanOrEqual(3);

      // All should have structured style and zap framework
      for (const result of structuredResults) {
        expect(result.style).toBe("structured");
        expect(result.framework).toBe("zap");
      }

      // Infow result should have kvRaw containing "host"
      const infowResult = structuredResults.find((r) =>
        r.matchedCode.includes("Infow"),
      );
      expect(infowResult).toBeDefined();
      expect(infowResult!.kvRaw).toContain("host");
    });
  });
});
