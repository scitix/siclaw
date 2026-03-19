import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stripGoQuotes,
  detectLevel,
  mapSemgrepMatch,
  mapSemgrepOutput,
} from "./result-mapper.js";
import { SemgrepOutputSchema } from "./semgrep-schema.js";
import type { SemgrepMatch } from "./semgrep-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture() {
  const raw = readFileSync(
    join(__dirname, "__fixtures__", "semgrep-output.json"),
    "utf-8",
  );
  return SemgrepOutputSchema.parse(JSON.parse(raw));
}

function makeMatch(overrides: Record<string, unknown> = {}): SemgrepMatch {
  return {
    check_id: "siclaw.go.klog-printf",
    path: "pkg/test.go",
    start: { line: 10, col: 1, offset: 100 },
    end: { line: 10, col: 50, offset: 149 },
    extra: {
      message: "test",
      severity: "INFO",
      lines: '\tklog.Errorf("error: %s", msg)',
      metadata: { framework: "klog", style: "printf" },
      metavars: {
        $FMT: {
          start: { line: 10, col: 15, offset: 114 },
          end: { line: 10, col: 27, offset: 126 },
          abstract_content: '"error: %s"',
        },
      },
    },
    ...overrides,
  } as SemgrepMatch;
}

describe("stripGoQuotes", () => {
  it("strips surrounding double quotes and unescapes inner quotes", () => {
    expect(stripGoQuotes('"hello %s"')).toBe("hello %s");
  });

  it("passes through already unquoted strings", () => {
    expect(stripGoQuotes("hello %s")).toBe("hello %s");
  });

  it("unescapes inner escaped quotes", () => {
    expect(stripGoQuotes('"say \\"hello\\""')).toBe('say "hello"');
  });

  it("handles empty quoted string", () => {
    expect(stripGoQuotes('""')).toBe("");
  });
});

describe("detectLevel", () => {
  it("returns 'error' for klog.Errorf", () => {
    expect(detectLevel('\tklog.Errorf("fail: %s", err)', {})).toBe("error");
  });

  it("returns 'info' for logger.Info", () => {
    expect(detectLevel('\tlogger.Info("started", "name", n)', {})).toBe("info");
  });

  it("returns metadata level when present (takes precedence)", () => {
    expect(
      detectLevel('\tklog.Infof("something")', { level: "warning" }),
    ).toBe("warning");
  });

  it("defaults to 'info' when no function recognized", () => {
    expect(detectLevel("someOtherCall()", {})).toBe("info");
  });

  it("returns 'warning' for klog.Warningf", () => {
    expect(detectLevel('\tklog.Warningf("warn: %s", x)', {})).toBe("warning");
  });

  it("returns 'fatal' for klog.Fatalf", () => {
    expect(detectLevel('\tklog.Fatalf("fatal: %s", x)', {})).toBe("fatal");
  });
});

describe("mapSemgrepMatch", () => {
  it("maps klog printf match to correct ExtractionResult", () => {
    const match = makeMatch();
    const result = mapSemgrepMatch(match);

    expect(result.ruleId).toBe("siclaw.go.klog-printf");
    expect(result.framework).toBe("klog");
    expect(result.style).toBe("printf");
    expect(result.level).toBe("error");
    expect(result.file).toBe("pkg/test.go");
    expect(result.line).toBe(10);
    expect(result.template).toBe("error: %s");
    expect(result.kvRaw).toBeNull();
    expect(result.metavars["$FMT"]).toBe('"error: %s"');
  });

  it("populates kvRaw for structured match", () => {
    const match = makeMatch({
      check_id: "siclaw.go.klog-structured",
      extra: {
        message: "test",
        severity: "INFO",
        lines: '\tklog.InfoS("msg", "key", val)',
        metadata: { framework: "klog", style: "structured" },
        metavars: {
          $MSG: {
            start: { line: 10, col: 13, offset: 112 },
            end: { line: 10, col: 18, offset: 117 },
            abstract_content: '"msg"',
          },
          "$...KVPAIRS": {
            start: { line: 10, col: 20, offset: 119 },
            end: { line: 10, col: 30, offset: 129 },
            abstract_content: '"key", val',
          },
        },
      },
    });

    const result = mapSemgrepMatch(match);
    expect(result.template).toBe("msg");
    expect(result.kvRaw).toBe('"key", val');
    expect(result.style).toBe("structured");
  });

  it("throws when metadata.framework is missing", () => {
    const match = makeMatch();
    match.extra.metadata = {};
    expect(() => mapSemgrepMatch(match)).toThrow("Missing metadata.framework");
  });

  it("throws when metadata.style is missing", () => {
    const match = makeMatch();
    match.extra.metadata = { framework: "klog" };
    expect(() => mapSemgrepMatch(match)).toThrow("Missing or invalid metadata.style");
  });

  it("throws when no $FMT or $MSG metavar", () => {
    const match = makeMatch();
    match.extra.metavars = {};
    expect(() => mapSemgrepMatch(match)).toThrow("No $FMT or $MSG metavar");
  });
});

describe("mapSemgrepOutput", () => {
  it("produces 4 ExtractionResults from fixture", () => {
    const output = loadFixture();
    const result = mapSemgrepOutput(output);

    expect(result.results).toHaveLength(4);
    expect(result.errors).toHaveLength(0);
    expect(result.scannedFiles).toContain("pkg/controller/pod.go");
  });

  it("collects mapping errors without aborting", () => {
    const output = loadFixture();
    // Corrupt one match to cause mapping failure
    output.results[0]!.extra.metadata = {};

    const result = mapSemgrepOutput(output);
    expect(result.results).toHaveLength(3);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Missing metadata.framework");
  });

  it("collects Semgrep-reported errors", () => {
    const output = loadFixture();
    output.errors = [{ message: "rule parse error" }];

    const result = mapSemgrepOutput(output);
    expect(result.errors).toContain("rule parse error");
  });
});
