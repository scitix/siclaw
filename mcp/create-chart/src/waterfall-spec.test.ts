import { describe, it, expect, vi } from "vitest";
import fixture from "./fixtures/waterfall.json";
import {
  normalizeWaterfallSpec,
  traceSummary,
  utcNanoseconds,
  traceFollowUp,
} from "./waterfall-spec.js";
import { handleRenderChart } from "./handler.js";
import { exportMarkdownVisualsWithVisualExportWeb } from "./visual-export.js";
vi.mock("./visual-export.js", () => ({
  exportMarkdownVisualsWithVisualExportWeb: vi.fn(),
}));
const sample = () => structuredClone(fixture) as any;
describe("request timeline evidence contract", () => {
  it("keeps real sibling parents and counts HTTP rather than route layers", () => {
    const spec = normalizeWaterfallSpec(sample());
    expect(traceSummary(spec)).toEqual({
      total_ms: 67574.573,
      http_calls: 2,
      open_spans: 0,
      outside_root: false,
    });
    expect(
      spec.data.spans.find((s) => s.span_id === "http1")?.parent_span_id,
    ).toBe("root");
    expect(
      spec.data.spans.find((s) => s.span_id === "http1")!.end_ms! - 1123.68,
    ).toBeCloseTo(64563.785, 6);
  });
  it("subtracts UTC endpoints before numeric conversion, preserving nanoseconds", () => {
    const raw = sample();
    raw.data.spans = [
      {
        span_id: "root",
        label: "root",
        start_time: "2026-09-10T06:25:02.913915001Z",
        end_time: "2026-09-10T06:25:02.913916003Z",
      },
    ];
    const s = normalizeWaterfallSpec(raw).data.spans[0];
    expect(s.start_ms).toBe(0.000001);
    expect(s.end_ms).toBe(0.001003);
    expect(
      utcNanoseconds("2026-09-10T06:25:02.913916003Z") -
        utcNanoseconds(raw.data.origin_time),
    ).toBe(BigInt(1003));
  });
  it("projects allowed fields and keeps an unobserved end unknown", () => {
    const raw = sample();
    raw.data.spans[0].attributes = { headers: { Authorization: "secret" } };
    raw.data.spans[0].end_ms = null;
    raw.data.coverage.complete = false;
    const spec = normalizeWaterfallSpec(raw);
    expect(JSON.stringify(spec)).not.toContain("secret");
    expect(traceSummary(spec).total_ms).toBeNull();
    expect(spec.data.spans[0].end_ms).toBeNull();
  });
  it("permits missing parents/overlap and preserves incomplete coverage", () => {
    const raw = sample();
    raw.data.spans[2].parent_span_id = "not-collected";
    raw.data.coverage.complete = false;
    expect(traceSummary(normalizeWaterfallSpec(raw)).total_ms).toBeNull();
  });
  it.each([
    ["duplicate", (r: any) => r.data.spans.push(r.data.spans[0])],
    ["cycle", (r: any) => (r.data.spans[0].parent_span_id = "http1")],
    ["reverse", (r: any) => (r.data.spans[1].end_ms = -1)],
    ["calendar", (r: any) => (r.data.origin_time = "2026-02-30T00:00:00Z")],
    ["mixed", (r: any) => (r.data.spans[1].start_time = r.data.origin_time)],
    ["unsafe", (r: any) => (r.data.spans[1].label = "arn:aws:secret")],
    [
      "derived",
      (r: any) =>
        Object.assign(r.data.spans[1], { layer: "derived", evidence_refs: [] }),
    ],
    [
      "limit",
      (r: any) =>
        (r.data.spans = Array.from({ length: 201 }, (_, i) => ({
          ...r.data.spans[0],
          span_id: "span" + i,
        }))),
    ],
    ["bytes", (r: any) => (r.extra = "x".repeat(262144))],
  ])("rejects %s without silently rewriting evidence", (_name, mutate) => {
    const raw = sample();
    mutate(raw);
    expect(() => normalizeWaterfallSpec(raw)).toThrow();
  });
  it("follow-up carries the verified scope, precise window and evidence boundaries", () => {
    const prompt = traceFollowUp(
      normalizeWaterfallSpec(sample()),
      { span_id: "http1", range_ms: [1000, 66000] },
      "zh-CN",
    );
    expect(prompt).toContain('"project": "default"');
    expect(prompt).toContain('"parent_span_id": "root"');
    expect(prompt).toContain("不要推断排队或推理耗时");
  });
});
describe("independent Web and PNG outputs", () => {
  it("Web works with no exporter, stable IDs and no copied fence", async () => {
    vi.mocked(exportMarkdownVisualsWithVisualExportWeb).mockClear();
    const result = await handleRenderChart({ ...sample(), output: "web" });
    expect(exportMarkdownVisualsWithVisualExportWeb).not.toHaveBeenCalled();
    const v = (result.structuredContent as any).visuals[0];
    expect(v.spec.visual_id).toBe(v.visual_id);
    expect(v.exports.png.status).toBe("not_requested");
    expect((result.content[0] as any).text).not.toContain("```chart");
  });
  it("both preserves data when PNG fails; image still fails", async () => {
    vi.mocked(exportMarkdownVisualsWithVisualExportWeb).mockRejectedValue(
      new Error("export down"),
    );
    const result = await handleRenderChart({ ...sample(), output: "both" });
    expect(
      (result.structuredContent as any).visuals[0].exports.png.status,
    ).toBe("failed");
    expect(result.content).toHaveLength(1);
    await expect(
      handleRenderChart({ ...sample(), output: "image" }),
    ).rejects.toThrow("export down");
  });
});
