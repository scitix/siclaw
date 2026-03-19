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
// These resolve at runtime only when tests actually run (semgrep available).
async function loadRunner() {
  const { runSemgrep } = await import("./semgrep-runner.js");
  return { runSemgrep };
}

const fixtureDir = path.resolve(__dirname, "__fixtures__");
const rulesDir = path.resolve(__dirname, "../../rules/go");

describe.skipIf(!semgrepAvailable)("klog integration tests", () => {
  describe("klog printf rules", () => {
    it("extracts all printf-style klog calls from fixture", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "klog-printf.yaml")],
        srcPath: path.join(fixtureDir, "klog-printf.go"),
      });

      // Infof x3 (regular + V().Infof + zero-arg), Warningf x1, Errorf x1, Fatalf x1
      expect(output.results.length).toBeGreaterThanOrEqual(6);

      // All results should have klog framework and printf style
      for (const result of output.results) {
        expect(result.framework).toBe("klog");
        expect(result.style).toBe("printf");
      }

      // Errorf result should contain the format string
      const errorfResult = output.results.find((r) =>
        r.matchedCode.includes("Errorf"),
      );
      expect(errorfResult).toBeDefined();
      expect(errorfResult!.template).toContain(
        "Failed to create pod sandbox for pod %q: %v",
      );

      // Zero-arg Infof should capture the message
      const zeroArgResult = output.results.find((r) =>
        r.template.includes("Starting full cluster reconciliation"),
      );
      expect(zeroArgResult).toBeDefined();

      // All results should have $FMT metavar
      for (const result of output.results) {
        expect(result.metavars).toHaveProperty("$FMT");
      }
    });
  });

  describe("klog structured rules", () => {
    it("extracts all structured-style klog calls from fixture", async () => {
      const { runSemgrep } = await loadRunner();
      const output = await runSemgrep({
        rulePaths: [path.join(rulesDir, "klog-structured.yaml")],
        srcPath: path.join(fixtureDir, "klog-structured.go"),
      });

      // InfoS x2 (with kv + zero-kv), ErrorS x1, V().InfoS x1
      expect(output.results.length).toBeGreaterThanOrEqual(4);

      // All results should have klog framework and structured style
      for (const result of output.results) {
        expect(result.framework).toBe("klog");
        expect(result.style).toBe("structured");
      }

      // ErrorS result should contain the message
      const errorSResult = output.results.find((r) =>
        r.matchedCode.includes("ErrorS"),
      );
      expect(errorSResult).toBeDefined();
      expect(errorSResult!.template).toContain("Failed to schedule pod");

      // InfoS with kv should have kvRaw containing key name
      const infoSWithKv = output.results.find(
        (r) =>
          r.template.includes("Pod scheduled successfully") &&
          r.kvRaw !== null,
      );
      expect(infoSWithKv).toBeDefined();
      expect(infoSWithKv!.kvRaw).toContain("pod");

      // Zero-kv InfoS should have kvRaw === null
      const zeroKvResult = output.results.find(
        (r) =>
          r.template.includes("Scheduler cycle complete") &&
          r.kvRaw === null,
      );
      expect(zeroKvResult).toBeDefined();
    });
  });
});
