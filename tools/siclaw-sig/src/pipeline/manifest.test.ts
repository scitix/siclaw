import { describe, test, expect } from "vitest";
import { buildManifest, manifestToYaml } from "./manifest.js";
import { ManifestSchema } from "../schema/manifest.js";
import type { SigRecord } from "../schema/record.js";
import yaml from "js-yaml";

function makeSigRecord(overrides: Partial<SigRecord> = {}): SigRecord {
  return {
    id: "abcdef012345",
    component: "test-cni",
    version: "v1.0.0",
    file: "pkg/controller/pod.go",
    line: 42,
    function: "reconcilePod",
    level: "error",
    template: "Failed to create pod %s: %v",
    style: "printf",
    confidence: "high",
    regex: "^Failed to create pod (.*): (.*)$",
    keywords: ["failed", "create", "pod"],
    context: {
      package: "controller",
      function: "reconcilePod",
      source_lines: [
        "func reconcilePod() {",
        '  klog.Errorf("Failed to create pod %s: %v", name, err)',
        "}",
      ],
      line_range: [41, 43],
    },
    error_conditions: null,
    related_logs: null,
    ...overrides,
  };
}

const DEFAULT_OPTIONS = {
  component: "test-cni",
  sourceVersion: "v1.0.0",
  language: "go",
  ruleIds: ["siclaw.go.klog-printf"],
  extractionDurationMs: 1234,
};

describe("buildManifest", () => {
  test("produces valid Manifest from records", () => {
    const result = buildManifest([makeSigRecord()], DEFAULT_OPTIONS);
    expect(() => ManifestSchema.parse(result)).not.toThrow();
    expect(result.component).toBe("test-cni");
    expect(result.source_version).toBe("v1.0.0");
    expect(result.language).toBe("go");
    expect(result.schema_version).toBe("1.0");
  });

  test("stats.total_templates matches record count", () => {
    const records = [makeSigRecord(), makeSigRecord(), makeSigRecord()];
    const result = buildManifest(records, DEFAULT_OPTIONS);
    expect(result.stats.total_templates).toBe(3);
  });

  test("stats.by_level counts correctly", () => {
    const records = [
      makeSigRecord({ level: "error" }),
      makeSigRecord({ level: "error" }),
      makeSigRecord({ level: "info" }),
    ];
    const result = buildManifest(records, DEFAULT_OPTIONS);
    expect(result.stats.by_level.error).toBe(2);
    expect(result.stats.by_level.info).toBe(1);
    expect(result.stats.by_level.warning).toBe(0);
  });

  test("stats.by_style counts correctly", () => {
    const records = [
      makeSigRecord({ style: "printf" }),
      makeSigRecord({ style: "structured" }),
      makeSigRecord({ style: "structured" }),
    ];
    const result = buildManifest(records, DEFAULT_OPTIONS);
    expect(result.stats.by_style.printf).toBe(1);
    expect(result.stats.by_style.structured).toBe(2);
  });

  test("extraction_timestamp is ISO 8601", () => {
    const result = buildManifest([makeSigRecord()], DEFAULT_OPTIONS);
    expect(result.extraction_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("rules list from options", () => {
    const result = buildManifest([makeSigRecord()], {
      ...DEFAULT_OPTIONS,
      ruleIds: ["siclaw.go.klog-printf", "siclaw.go.logr"],
    });
    expect(result.rules.length).toBe(2);
    expect(result.rules).toContain("siclaw.go.klog-printf");
  });

  test("empty records produces valid manifest with zero stats", () => {
    const result = buildManifest([], DEFAULT_OPTIONS);
    expect(result.stats.total_templates).toBe(0);
    expect(result.stats.by_level.error).toBe(0);
  });
});

describe("manifestToYaml", () => {
  test("produces valid YAML that round-trips", () => {
    const manifest = buildManifest([makeSigRecord()], DEFAULT_OPTIONS);
    const yamlStr = manifestToYaml(manifest);
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    expect(parsed.component).toBe("test-cni");
    expect(parsed.source_version).toBe("v1.0.0");
    expect((parsed.stats as Record<string, unknown>).total_templates).toBe(
      manifest.stats.total_templates,
    );
  });
});
