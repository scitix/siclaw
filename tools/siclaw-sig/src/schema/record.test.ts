import { describe, it, expect } from "vitest";
import { SigRecordSchema } from "./record.js";
import { computeSigId } from "./id.js";
import { ZodError } from "zod";

function makeValidRecord(overrides: Record<string, unknown> = {}) {
  const file = "pkg/server/server.go";
  const line = 42;
  const template = "failed to connect to %s:%d";
  return {
    id: computeSigId(file, line, template),
    component: "my-cni",
    version: "v1.8.0",
    file,
    line,
    function: "pkg/server.Start",
    level: "error",
    template,
    style: "printf",
    confidence: "exact",
    regex: "failed to connect to \\S+:\\d+",
    keywords: ["failed", "connect"],
    context: {
      package: "pkg/server",
      function: "Start",
      source_lines: [
        'klog.Errorf("failed to connect to %s:%d", host, port)',
      ],
      line_range: [41, 43],
    },
    error_conditions: null,
    related_logs: null,
    ...overrides,
  };
}

describe("SigRecordSchema — valid records", () => {
  it("parses Go klog printf (Errorf) with confidence=exact", () => {
    const record = makeValidRecord();
    const result = SigRecordSchema.parse(record);
    expect(result.style).toBe("printf");
    expect(result.confidence).toBe("exact");
    expect(result.regex).toBe("failed to connect to \\S+:\\d+");
  });

  it("parses Go klog structured (InfoS) with confidence=medium", () => {
    const file = "pkg/controller/reconcile.go";
    const line = 128;
    const template = "Reconciling resource";
    const record = makeValidRecord({
      id: computeSigId(file, line, template),
      file,
      line,
      function: "pkg/controller.Reconcile",
      level: "info",
      template,
      style: "structured",
      confidence: "medium",
      regex: null,
      keywords: ["Reconciling", "resource"],
      context: {
        package: "pkg/controller",
        function: "Reconcile",
        source_lines: [
          'klog.InfoS("Reconciling resource", "name", obj.Name)',
        ],
        line_range: [127, 129],
      },
    });
    const result = SigRecordSchema.parse(record);
    expect(result.style).toBe("structured");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
  });

  it("parses printf with %v and confidence=high", () => {
    const file = "pkg/network/vxlan.go";
    const line = 95;
    const template = "tunnel endpoint %v unreachable";
    const record = makeValidRecord({
      id: computeSigId(file, line, template),
      file,
      line,
      function: "pkg/network.SetupTunnel",
      level: "warning",
      template,
      style: "printf",
      confidence: "high",
      regex: "tunnel endpoint .* unreachable",
      keywords: ["tunnel", "endpoint", "unreachable"],
      context: {
        package: "pkg/network",
        function: "SetupTunnel",
        source_lines: [
          'klog.Warningf("tunnel endpoint %v unreachable", ep)',
        ],
        line_range: [94, 96],
      },
    });
    const result = SigRecordSchema.parse(record);
    expect(result.style).toBe("printf");
    expect(result.confidence).toBe("high");
    expect(result.regex).toContain(".*");
  });
});

describe("SigRecordSchema — required field validation", () => {
  const requiredFields = [
    "id",
    "component",
    "template",
    "keywords",
    "context",
    "style",
    "confidence",
  ] as const;

  for (const field of requiredFields) {
    it(`throws ZodError when '${field}' is missing`, () => {
      const record = makeValidRecord();
      delete (record as Record<string, unknown>)[field];
      expect(() => SigRecordSchema.parse(record)).toThrow(ZodError);
    });
  }
});

describe("SigRecordSchema — type validation", () => {
  it("rejects id with wrong format (not 12 hex chars)", () => {
    expect(() => SigRecordSchema.parse(makeValidRecord({ id: "abc" }))).toThrow(ZodError);
  });

  it("rejects line as string", () => {
    expect(() => SigRecordSchema.parse(makeValidRecord({ line: "42" }))).toThrow(ZodError);
  });

  it("rejects invalid level enum value", () => {
    expect(() => SigRecordSchema.parse(makeValidRecord({ level: "verbose" }))).toThrow(ZodError);
  });

  it("rejects invalid style enum value", () => {
    expect(() => SigRecordSchema.parse(makeValidRecord({ style: "template" }))).toThrow(ZodError);
  });
});

describe("SigRecordSchema — forward compatibility", () => {
  it("strips unknown fields from parsed output", () => {
    const record = { ...makeValidRecord(), new_field_v2: "future" };
    const result = SigRecordSchema.parse(record);
    expect(result).not.toHaveProperty("new_field_v2");
  });
});
