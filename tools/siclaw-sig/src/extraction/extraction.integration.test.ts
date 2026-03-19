import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExtractionResultSchema } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let semgrepAvailable = false;
try {
  execFileSync("semgrep", ["--version"], { timeout: 10_000 });
  semgrepAvailable = true;
} catch {
  // semgrep not found — tests will be skipped
}

async function loadRegistry() {
  const { extractLogs } = await import("./rule-registry.js");
  return { extractLogs };
}

const fixtureDir = path.resolve(__dirname, "__fixtures__");
const tempDir = mkdtempSync(path.join(tmpdir(), "siclaw-integration-"));

// Copy all fixture .go files to temp dir
const fixtureFiles = [
  "klog-printf.go",
  "klog-structured.go",
  "logr.go",
  "zap-native.go",
  "zap-sugar.go",
];

for (const f of fixtureFiles) {
  copyFileSync(path.join(fixtureDir, f), path.join(tempDir, f));
}

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch {
    // ignore
  }
});

describe.skipIf(!semgrepAvailable)("full pipeline integration", () => {
  it("extracts logs from all Go framework fixtures", async () => {
    const { extractLogs } = await loadRegistry();
    const output = await extractLogs({ language: "go", srcPath: tempDir });

    // Sum of all expected matches across all fixtures
    expect(output.results.length).toBeGreaterThanOrEqual(20);

    // klog printf
    expect(
      output.results.some(
        (r) => r.framework === "klog" && r.style === "printf",
      ),
    ).toBe(true);

    // klog structured
    expect(
      output.results.some(
        (r) => r.framework === "klog" && r.style === "structured",
      ),
    ).toBe(true);

    // logr
    expect(
      output.results.some((r) => r.framework === "logr"),
    ).toBe(true);

    // zap printf (sugar)
    expect(
      output.results.some(
        (r) => r.framework === "zap" && r.style === "printf",
      ),
    ).toBe(true);

    // zap structured (native + sugar)
    expect(
      output.results.some(
        (r) => r.framework === "zap" && r.style === "structured",
      ),
    ).toBe(true);

    // Scanned all fixture files
    expect(output.scannedFiles.length).toBeGreaterThanOrEqual(5);

    // No errors from valid Go fixtures
    expect(output.errors).toEqual([]);
  });

  it("all results pass Zod schema validation", async () => {
    const { extractLogs } = await loadRegistry();
    const output = await extractLogs({ language: "go", srcPath: tempDir });

    for (const result of output.results) {
      // Should not throw
      const parsed = ExtractionResultSchema.parse(result);
      expect(parsed.template).toBeTruthy();
      expect(parsed.matchedCode).toBeTruthy();
      expect(parsed.line).toBeGreaterThan(0);
    }
  });

  it("merges user-supplied custom rule with built-in rules", async () => {
    const { extractLogs } = await loadRegistry();

    // Create a custom rule YAML
    const customRulePath = path.join(tempDir, "custom-rule.yaml");
    writeFileSync(
      customRulePath,
      `rules:
  - id: siclaw.go.custom-printf
    languages: [go]
    severity: INFO
    message: "custom printf log call"
    metadata:
      framework: custom
      style: printf
    pattern-either:
      - pattern: mylog.Printf($FMT, ...)
      - pattern: mylog.Printf($FMT)
`,
    );

    // Create a Go fixture containing mylog.Printf
    const customFixturePath = path.join(tempDir, "custom.go");
    writeFileSync(
      customFixturePath,
      `package custom

import "myapp/mylog"

func Run() {
\tmylog.Printf("custom log %s", val)
}
`,
    );

    const output = await extractLogs({
      language: "go",
      srcPath: tempDir,
      userRulePatterns: [customRulePath],
    });

    // Should contain at least one custom framework match
    expect(
      output.results.some((r) => r.framework === "custom"),
    ).toBe(true);
  });
});
