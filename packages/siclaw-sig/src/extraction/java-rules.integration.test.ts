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

const fixtureDir = path.resolve(__dirname, "../../test-fixtures/java");
const rulesDir = path.resolve(__dirname, "../../rules/java");

describe.skipIf(!semgrepAvailable)("Java logging rules integration", () => {
  describe("SLF4J rules", () => {
    it("extracts SLF4J logging calls from fixture", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "slf4j.yaml")],
        srcPath: path.join(fixtureDir, "Sample.java"),
      });

      // Sample.java has 10 SLF4J logger calls
      expect(output.results.length).toBeGreaterThanOrEqual(8);

      for (const result of output.results) {
        expect(result.framework).toBe("slf4j");
        expect(result.style).toBe("printf");
      }
    });

    it("extracts format string templates with {} placeholders", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "slf4j.yaml")],
        srcPath: path.join(fixtureDir, "Sample.java"),
      });

      const templates = output.results.map((r) => r.template);
      const podTemplate = templates.find((t) =>
        t.includes("Starting reconciliation"),
      );
      expect(podTemplate).toBeDefined();
    });

    it("all results have $FMT metavar", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "slf4j.yaml")],
        srcPath: path.join(fixtureDir, "Sample.java"),
      });

      for (const result of output.results) {
        expect(result.metavars).toHaveProperty("$FMT");
      }
    });
  });

  describe("Log4j2 rules", () => {
    it("extracts Log4j2 logging calls from fixture", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "log4j2.yaml")],
        srcPath: path.join(fixtureDir, "Sample.java"),
      });

      // Log4j2 patterns overlap with SLF4J ($LOGGER.error etc.)
      // Both should match the same fixture calls
      expect(output.results.length).toBeGreaterThanOrEqual(8);

      for (const result of output.results) {
        expect(result.framework).toBe("log4j2");
        expect(result.style).toBe("printf");
      }
    });
  });
});
