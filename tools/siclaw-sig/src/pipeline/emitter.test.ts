import { describe, test, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emitRecords, recordsToJsonl } from "./emitter.js";
import { SigRecordSchema } from "../schema/record.js";
import type { ExtractionResult } from "../extraction/types.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURES_DIR = path.resolve(path.dirname(__filename), "../extraction/__fixtures__");

function makeResult(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    ruleId: "siclaw.go.klog-printf",
    framework: "klog",
    style: "printf",
    level: "info",
    file: "klog-printf.go",
    line: 6,
    template: "Starting reconciliation for pod %s/%s",
    kvRaw: null,
    matchedCode: 'klog.Infof("Starting reconciliation for pod %s/%s", namespace, podName)',
    metavars: {},
    ...overrides,
  };
}

describe("emitRecords", () => {
  test("emits valid SigRecord from ExtractionResult", async () => {
    const result = await emitRecords([makeResult()], {
      component: "test-cni",
      version: "v1.0.0",
      srcPath: FIXTURES_DIR,
    });
    expect(result.records.length).toBe(1);
    expect(result.errors.length).toBe(0);
    expect(result.records[0].component).toBe("test-cni");
    expect(result.records[0].version).toBe("v1.0.0");
    expect(result.records[0].level).toBe("info");
    expect(result.records[0].id).toMatch(/^[0-9a-f]{12}$/);
  });

  test("schema validates emitted record", async () => {
    const result = await emitRecords([makeResult()], {
      component: "test-cni",
      version: "v1.0.0",
      srcPath: FIXTURES_DIR,
    });
    expect(() => SigRecordSchema.parse(result.records[0])).not.toThrow();
  });

  test("populates context with package and function", async () => {
    const result = await emitRecords([makeResult()], {
      component: "test-cni",
      version: "v1.0.0",
      srcPath: FIXTURES_DIR,
    });
    expect(result.records[0].context.package).toBe("controller");
    expect(result.records[0].context.function).toBe("reconcilePod");
    expect(result.records[0].function).toBe("reconcilePod");
  });

  test("generates regex and keywords from printf template", async () => {
    const result = await emitRecords(
      [makeResult({ template: "Failed to create pod %s: %v" })],
      { component: "test-cni", version: "v1.0.0", srcPath: FIXTURES_DIR },
    );
    expect(result.records[0].regex).not.toBeNull();
    expect(result.records[0].keywords.length).toBeGreaterThan(0);
    expect(
      result.records[0].keywords.some((k) => ["failed", "create", "pod"].includes(k)),
    ).toBe(true);
  });

  test("handles structured style with plain message template", async () => {
    const result = await emitRecords(
      [makeResult({ style: "structured", template: "Pod lifecycle event" })],
      { component: "test-cni", version: "v1.0.0", srcPath: FIXTURES_DIR },
    );
    expect(result.records[0].style).toBe("structured");
    expect(result.records[0].keywords.length).toBeGreaterThan(0);
  });

  test("collects error and skips record when source file missing", async () => {
    const result = await emitRecords(
      [makeResult({ file: "nonexistent.go" })],
      { component: "test-cni", version: "v1.0.0", srcPath: FIXTURES_DIR },
    );
    expect(result.records.length).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("Source file not found");
  });
});

describe("recordsToJsonl", () => {
  test("produces one JSON line per record", async () => {
    const result = await emitRecords(
      [makeResult(), makeResult({ line: 7 })],
      { component: "test-cni", version: "v1.0.0", srcPath: FIXTURES_DIR },
    );
    const jsonl = recordsToJsonl(result.records);
    const lines = jsonl.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("returns empty string for empty array", () => {
    expect(recordsToJsonl([])).toBe("");
  });
});
