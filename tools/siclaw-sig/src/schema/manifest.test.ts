import { describe, it, expect } from "vitest";
import { ManifestSchema } from "./manifest.js";
import { ZodError } from "zod";
import yaml from "js-yaml";

function makeValidManifest(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0",
    component: "my-cni",
    source_version: "v1.8.0",
    language: "go",
    extraction_timestamp: "2026-03-18T10:30:00Z",
    rules: ["go/klog-printf", "go/klog-structured"],
    stats: {
      total_templates: 42,
      by_level: { error: 10, warning: 12, info: 20 },
      by_style: { printf: 30, structured: 12 },
      extraction_duration_ms: 1500,
    },
    ...overrides,
  };
}

describe("ManifestSchema — valid manifest", () => {
  it("parses a complete valid manifest", () => {
    const result = ManifestSchema.parse(makeValidManifest());
    expect(result.schema_version).toBe("1.0");
    expect(result.component).toBe("my-cni");
    expect(result.source_version).toBe("v1.8.0");
    expect(result.language).toBe("go");
    expect(result.extraction_timestamp).toBe("2026-03-18T10:30:00Z");
    expect(result.rules).toEqual(["go/klog-printf", "go/klog-structured"]);
    expect(result.stats.total_templates).toBe(42);
    expect(result.stats.by_level.error).toBe(10);
    expect(result.stats.by_style.printf).toBe(30);
    expect(result.stats.extraction_duration_ms).toBe(1500);
  });
});

describe("ManifestSchema — required field validation", () => {
  const requiredFields = [
    "schema_version",
    "component",
    "source_version",
    "language",
    "extraction_timestamp",
    "rules",
    "stats",
  ] as const;

  for (const field of requiredFields) {
    it(`throws ZodError when '${field}' is missing`, () => {
      const manifest = makeValidManifest();
      delete (manifest as Record<string, unknown>)[field];
      expect(() => ManifestSchema.parse(manifest)).toThrow(ZodError);
    });
  }
});

describe("ManifestSchema — stats validation", () => {
  it("throws ZodError when stats.by_level is missing", () => {
    const manifest = makeValidManifest({
      stats: {
        total_templates: 42,
        by_style: { printf: 30, structured: 12 },
        extraction_duration_ms: 1500,
      },
    });
    expect(() => ManifestSchema.parse(manifest)).toThrow(ZodError);
  });

  it("throws ZodError when stats.by_style is missing", () => {
    const manifest = makeValidManifest({
      stats: {
        total_templates: 42,
        by_level: { error: 10, warning: 12, info: 20 },
        extraction_duration_ms: 1500,
      },
    });
    expect(() => ManifestSchema.parse(manifest)).toThrow(ZodError);
  });
});

describe("ManifestSchema — forward compatibility", () => {
  it("strips unknown fields from parsed output", () => {
    const manifest = { ...makeValidManifest(), extra_field: "future" };
    const result = ManifestSchema.parse(manifest);
    expect(result).not.toHaveProperty("extra_field");
  });
});

describe("ManifestSchema — YAML round-trip", () => {
  it("parses a YAML-serialized manifest", () => {
    const yamlStr = `
schema_version: "1.0"
component: my-cni
source_version: v1.8.0
language: go
extraction_timestamp: "2026-03-18T10:30:00Z"
rules:
  - go/klog-printf
  - go/klog-structured
stats:
  total_templates: 42
  by_level:
    error: 10
    warning: 12
    info: 20
  by_style:
    printf: 30
    structured: 12
  extraction_duration_ms: 1500
`;
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const result = ManifestSchema.parse(parsed);
    expect(result.component).toBe("my-cni");
    expect(result.stats.total_templates).toBe(42);
  });
});
