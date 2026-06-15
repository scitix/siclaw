import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RENDER_CHART_INPUT_SCHEMA,
  RENDER_CHART_DESCRIPTION,
  validate,
  handleRenderChart,
} from "./handler.js";

describe("RENDER_CHART_INPUT_SCHEMA", () => {
  it("requires type and data, allows the common opts", () => {
    expect(RENDER_CHART_INPUT_SCHEMA.required).toEqual(["type", "data"]);
    expect(RENDER_CHART_INPUT_SCHEMA.additionalProperties).toBe(false);
    expect(RENDER_CHART_INPUT_SCHEMA.properties.type.enum).toEqual([
      "pie",
      "bar",
      "line",
    ]);
    for (const k of ["title", "width", "height", "x_label", "y_label"]) {
      expect(RENDER_CHART_INPUT_SCHEMA.properties).toHaveProperty(k);
    }
  });

  it("description tells the model to paste the READY_TO_PASTE block exactly", () => {
    expect(RENDER_CHART_DESCRIPTION).toMatch(/```chart/);
    expect(RENDER_CHART_DESCRIPTION).toMatch(/READY_TO_PASTE/);
    expect(RENDER_CHART_DESCRIPTION).toMatch(/exactly/i);
    expect(RENDER_CHART_DESCRIPTION).toMatch(/Do not rewrite, escape, quote/);
    expect(RENDER_CHART_DESCRIPTION).toMatch(/mermaid/i);
    expect(RENDER_CHART_DESCRIPTION).toMatch(/xychart-beta/);
    expect(RENDER_CHART_DESCRIPTION).toMatch(/画图/);
    expect(RENDER_CHART_DESCRIPTION).toMatch(/画饼图/);
    expect(RENDER_CHART_DESCRIPTION).toMatch(/柱状图/);
    expect(RENDER_CHART_DESCRIPTION).toMatch(/趋势图/);
    expect(RENDER_CHART_DESCRIPTION).not.toMatch(/visual-card/);
    expect(RENDER_CHART_DESCRIPTION).not.toMatch(/final_report/);
    expect(RENDER_CHART_DESCRIPTION).toMatch(/data must be an object/i);
    expect(RENDER_CHART_DESCRIPTION).toMatch(/never a JSON string/i);
    expect(RENDER_CHART_INPUT_SCHEMA.properties.data.description).toMatch(/Every numeric value must be finite/);
    expect(RENDER_CHART_INPUT_SCHEMA.properties.data.description).toContain("x/category labels may be strings");
  });
});

describe("validate", () => {
  it("rejects non-object arguments", () => {
    expect(() => validate(null)).toThrow(/must be an object/);
    expect(() => validate("nope")).toThrow(/must be an object/);
    expect(() => validate(42)).toThrow(/must be an object/);
  });

  it("rejects unknown chart types", () => {
    expect(() => validate({ type: "scatter", data: {} })).toThrow(
      /type must be pie, bar, or line/,
    );
  });

  it("requires data to be an object", () => {
    expect(() => validate({ type: "pie" })).toThrow(/data is required/);
    expect(() => validate({ type: "pie", data: null })).toThrow(/data is required/);
  });

  describe("pie", () => {
    it("requires non-empty slices array", () => {
      expect(() => validate({ type: "pie", data: { slices: [] } })).toThrow(
        /slices must be a non-empty array/,
      );
      expect(() => validate({ type: "pie", data: {} })).toThrow(
        /slices must be a non-empty array/,
      );
    });

    it("rejects non-numeric slice values", () => {
      expect(() =>
        validate({ type: "pie", data: { slices: [{ label: "a", value: "x" }] } }),
      ).toThrow(/slice\[0\]\.value must be a number/);
    });

    it("normalises labels and forwards common opts", () => {
      const out = validate({
        type: "pie",
        data: { slices: [{ value: 3 }, { label: 12, value: 1 }] },
        title: "T",
        x_label: "X",
        y_label: "Y",
        width: 800,
        height: 500,
        extra: "ignored-by-handler-but-validate-keeps-it-out",
      } as Record<string, unknown>);
      expect(out.type).toBe("pie");
      expect(out.data).toEqual({
        slices: [
          { label: "slice 0", value: 3 },
          { label: "12", value: 1 },
        ],
      });
      expect(out.title).toBe("T");
      expect(out.x_label).toBe("X");
      expect(out.y_label).toBe("Y");
      expect(out.width).toBe(800);
      expect(out.height).toBe(500);
      expect((out as Record<string, unknown>).extra).toBeUndefined();
    });
  });

  describe("bar", () => {
    it("requires non-empty categories and series", () => {
      expect(() =>
        validate({ type: "bar", data: { categories: [], series: [{ name: "s", values: [] }] } }),
      ).toThrow(/categories must be a non-empty array/);
      expect(() =>
        validate({ type: "bar", data: { categories: ["a"], series: [] } }),
      ).toThrow(/series must be a non-empty array/);
    });

    it("coerces string values to numbers", () => {
      const out = validate({
        type: "bar",
        data: {
          categories: [1, "b"],
          series: [{ name: "s1", values: ["3", 4] }],
        },
      });
      expect(out.type).toBe("bar");
      if (out.type !== "bar") throw new Error("type guard");
      expect(out.data.categories).toEqual(["1", "b"]);
      expect(out.data.series[0].values).toEqual([3, 4]);
    });

    it("rejects non-array series values", () => {
      expect(() =>
        validate({
          type: "bar",
          data: { categories: ["a"], series: [{ name: "s", values: "oops" }] },
        }),
      ).toThrow(/series\[0\]\.values must be an array/);
    });
  });

  describe("line", () => {
    it("requires non-empty series and points", () => {
      expect(() => validate({ type: "line", data: { series: [] } })).toThrow(
        /series must be a non-empty array/,
      );
      expect(() =>
        validate({ type: "line", data: { series: [{ name: "s", points: [] }] } }),
      ).toThrow(/points must be a non-empty array/);
    });

    it("rejects non-numeric y values", () => {
      expect(() =>
        validate({
          type: "line",
          data: { series: [{ name: "s", points: [{ x: 1, y: "nope" }] }] },
        }),
      ).toThrow(/points\[0\]\.y must be a number/);
    });

    it("keeps numeric and string x, normalises others to string", () => {
      const out = validate({
        type: "line",
        data: {
          series: [
            {
              name: "s",
              points: [
                { x: 1700000000, y: 1.5 },
                { x: "label", y: 2 },
                { x: true, y: 3 },
              ],
            },
          ],
        },
      });
      if (out.type !== "line") throw new Error("type guard");
      const pts = out.data.series[0].points;
      expect(pts[0]).toEqual({ x: 1700000000, y: 1.5 });
      expect(pts[1]).toEqual({ x: "label", y: 2 });
      expect(pts[2]).toEqual({ x: "true", y: 3 });
    });
  });
});

describe("handleRenderChart", () => {
  let tmp: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "create-chart-test-"));
    originalEnv = process.env.CREATE_CHART_ARTIFACT_DIR;
    process.env.CREATE_CHART_ARTIFACT_DIR = tmp;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CREATE_CHART_ARTIFACT_DIR;
    else process.env.CREATE_CHART_ARTIFACT_DIR = originalEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  function splitEnvelope(text: string): { ready: string; meta: Record<string, unknown> } {
    const m = text.match(/^READY_TO_PASTE:\n([\s\S]*?)\n\nMETADATA_JSON:\n([\s\S]*)$/);
    if (!m) throw new Error(`unexpected envelope: ${text.slice(0, 80)}…`);
    return { ready: m[1], meta: JSON.parse(m[2]) };
  }

  it("returns a content array with a parseable result envelope", async () => {
    const res = await handleRenderChart({
      type: "pie",
      data: { slices: [{ label: "ok", value: 1 }] },
    });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe("text");
    const { ready, meta } = splitEnvelope(res.content[0].text);
    expect(ready.startsWith("```chart\n")).toBe(true);
    expect(ready.endsWith("\n```")).toBe(true);
    // The READY_TO_PASTE block must be the unescaped fenced markdown — no
    // backslash-escaped quotes, no surrounding JSON quotes. This is the whole
    // point of the envelope: agents copy this verbatim. METADATA_JSON carries
    // no embed string field, so there is no escaped form for the model to pick
    // up and mangle.
    expect(ready).not.toMatch(/\\"/);
    expect(meta.type).toBe("pie");
    expect(meta.schema_version).toBe(1);
    expect(meta.artifact_kind).toBe("chart_spec");
    expect(typeof meta.chart_id).toBe("string");
    expect((meta.chart_id as string).startsWith("pie-")).toBe(true);
    expect(typeof meta.bytes).toBe("number");
    expect(meta.bytes as number).toBeGreaterThan(0);
    expect(meta).not.toHaveProperty("markdown_embed");
    expect(meta).not.toHaveProperty("markdown_embed_raw");
    expect(meta.embed_instructions).toMatch(/READY_TO_PASTE/);
  });

  it("embeds the validated spec (not the raw input) inside the chart fence", async () => {
    const res = await handleRenderChart({
      type: "bar",
      data: {
        categories: ["a", "b"],
        series: [{ name: "s", values: ["10", 20] }],
      },
      title: "Demo",
      extra_garbage: "stripped",
    } as Record<string, unknown>);
    const { ready, meta } = splitEnvelope(res.content[0].text);
    const inner = ready.replace(/^```chart\n/, "").replace(/\n```$/, "");
    const spec = JSON.parse(inner);
    expect(spec.type).toBe("bar");
    expect(spec.schema_version).toBe(1);
    expect(spec.data.series[0].values).toEqual([10, 20]);
    expect(spec.title).toBe("Demo");
    expect(spec).not.toHaveProperty("extra_garbage");
    expect(meta).not.toHaveProperty("markdown_embed");
  });

  it("persists the spec to CREATE_CHART_ARTIFACT_DIR/chart-render/", async () => {
    const res = await handleRenderChart({
      type: "line",
      data: { series: [{ name: "s", points: [{ x: 1, y: 2 }] }] },
    });
    const { meta } = splitEnvelope(res.content[0].text);
    const expectedDir = path.resolve(tmp, "chart-render");
    expect(existsSync(expectedDir)).toBe(true);
    const expectedFile = path.join(expectedDir, `${meta.chart_id as string}.json`);
    expect(meta.svg_path).toBe("");
    expect(meta.spec_path).toBe(expectedFile);
    expect(existsSync(expectedFile)).toBe(true);
    const onDisk = JSON.parse(readFileSync(expectedFile, "utf8"));
    expect(onDisk.schema_version).toBe(1);
    expect(onDisk.type).toBe("line");
    expect(onDisk.data.series[0].points).toEqual([{ x: 1, y: 2 }]);
    expect(readdirSync(expectedDir)).toContain(`${meta.chart_id as string}.json`);
  });

  it("still returns a usable result when disk persistence fails", async () => {
    // Point the artifact dir at a path whose parent is a regular file —
    // mkdir({recursive:true}) will reject with ENOTDIR, exercising the
    // best-effort catch in handleRenderChart.
    const blocker = path.join(tmp, "blocker");
    writeFileSync(blocker, "x");
    process.env.CREATE_CHART_ARTIFACT_DIR = path.join(blocker, "nested");

    const res = await handleRenderChart({
      type: "pie",
      data: { slices: [{ label: "a", value: 1 }] },
    });
    const { ready, meta } = splitEnvelope(res.content[0].text);
    expect(meta.svg_path).toBe("");
    expect(meta.spec_path).toBe("");
    expect(meta.bytes as number).toBeGreaterThan(0);
    expect(ready.startsWith("```chart\n")).toBe(true);
  });
});
