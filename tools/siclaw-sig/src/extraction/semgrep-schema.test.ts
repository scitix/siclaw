import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SemgrepOutputSchema, SemgrepMatchSchema } from "./semgrep-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(): unknown {
  const raw = readFileSync(
    join(__dirname, "__fixtures__", "semgrep-output.json"),
    "utf-8",
  );
  return JSON.parse(raw);
}

describe("SemgrepOutputSchema", () => {
  it("parses valid Semgrep output from fixture", () => {
    const data = loadFixture();
    const result = SemgrepOutputSchema.parse(data);
    expect(result.results).toHaveLength(4);
    expect(result.version).toBe("1.156.0");
    expect(result.paths?.scanned).toContain("pkg/controller/pod.go");
  });

  it("allows extra unknown fields via .strip()", () => {
    const data = loadFixture() as Record<string, unknown>;
    // Add extra field that future Semgrep versions might add
    data["interfile_languages_used"] = ["go"];
    const result = SemgrepOutputSchema.parse(data);
    expect(result.results).toHaveLength(4);
    // Extra field should be stripped
    expect((result as Record<string, unknown>)["interfile_languages_used"]).toBeUndefined();
  });

  it("fails when results array is missing", () => {
    expect(() => SemgrepOutputSchema.parse({ version: "1.0.0" })).toThrow();
  });

  it("parses empty results array", () => {
    const result = SemgrepOutputSchema.parse({ results: [] });
    expect(result.results).toHaveLength(0);
  });

  it("parses metavar abstract_content correctly", () => {
    const data = loadFixture();
    const result = SemgrepOutputSchema.parse(data);
    const klogMatch = result.results[0]!;
    expect(klogMatch.extra.metavars?.["$FMT"]?.abstract_content).toBe(
      '"Failed to create pod %s: %v"',
    );
  });
});

describe("SemgrepMatchSchema", () => {
  it("strips extra fields on individual match", () => {
    const match = {
      check_id: "test.rule",
      path: "test.go",
      start: { line: 1, col: 1, offset: 0 },
      end: { line: 1, col: 10, offset: 9 },
      extra: {
        message: "test",
        severity: "INFO",
        lines: "test line",
        fingerprint: "abc123",
      },
    };
    const result = SemgrepMatchSchema.parse(match);
    expect(result.check_id).toBe("test.rule");
    expect((result.extra as Record<string, unknown>)["fingerprint"]).toBeUndefined();
  });
});
