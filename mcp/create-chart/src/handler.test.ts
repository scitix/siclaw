import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { exportMarkdownVisualsWithVisualExportWeb } from "./visual-export.js";
import {
  RENDER_CHART_INPUT_SCHEMA,
  RENDER_CHART_DESCRIPTION,
  RENDER_MERMAID_DESCRIPTION,
  RENDER_MERMAID_INPUT_SCHEMA,
  validate,
  validateMermaid,
  handleRenderChart,
  handleRenderMermaid,
} from "./handler.js";

vi.mock("./visual-export.js", () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  return {
    exportMarkdownVisualsWithVisualExportWeb: vi.fn(async (markdown: string) => {
      const kind = markdown.startsWith("```mermaid") ? "mermaid" : "chart";
      return [{ kind, image: Buffer.from(png, "base64") }];
    }),
  };
});

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

  it("describes the web embed and supporting channel image without renderer metadata", () => {
    expect(RENDER_CHART_DESCRIPTION).toMatch(/PNG image artifact/);
    expect(RENDER_CHART_DESCRIPTION).toMatch(/natural-language/);
    expect(RENDER_CHART_DESCRIPTION).toMatch(/In web replies, include the returned chart block/);
    expect(RENDER_CHART_DESCRIPTION).toMatch(/IM channel sessions/);
    expect(RENDER_CHART_DESCRIPTION).not.toMatch(/READY_TO_PASTE/);
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

describe("visual image tool schemas", () => {
  it("registers Mermaid export as a ControlPlane Web image artifact tool", () => {
    expect(RENDER_MERMAID_INPUT_SCHEMA.required).toEqual(["source"]);
    expect(RENDER_MERMAID_INPUT_SCHEMA.additionalProperties).toBe(false);
    expect(RENDER_MERMAID_DESCRIPTION).toMatch(/ControlPlane Web's own Mermaid renderer\/export path/);
    expect(RENDER_MERMAID_DESCRIPTION).toMatch(/image\/png/);
    expect(RENDER_MERMAID_DESCRIPTION).toMatch(/natural-language/);
    expect(RENDER_MERMAID_DESCRIPTION).toMatch(/In web replies, include the returned Mermaid block/);
    expect(RENDER_MERMAID_DESCRIPTION).not.toMatch(/READY_TO_PASTE/);
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

describe("validateMermaid", () => {
  it("requires source and strips an accidental mermaid fence", () => {
    expect(() => validateMermaid({})).toThrow(/source is required/);
    expect(validateMermaid({
      source: "```mermaid\nflowchart TD\nA --> B\n```",
      title: "demo",
    })).toEqual({ source: "flowchart TD\nA --> B", title: "demo" });
  });
});

describe("handleRenderChart", () => {
  beforeEach(() => {
    vi.mocked(exportMarkdownVisualsWithVisualExportWeb).mockClear();
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns a web-renderable block and PNG image artifact", async () => {
    const res = await handleRenderChart({
      type: "pie",
      data: { slices: [{ label: "ok", value: 1 }] },
    });
    expect(res.content).toHaveLength(2);
    expect(res.content[0].type).toBe("text");
    expect(res.content[1].type).toBe("image");
    expect(res.content[1].mimeType).toBe("image/png");
    expect([...Buffer.from(res.content[1].data, "base64").subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(res.content[0].text).toBe(
      '```chart\n{"type":"pie","data":{"slices":[{"label":"ok","value":1}]}}\n```',
    );
    expect(res.content[0].text).not.toContain("READY_TO_PASTE");
    expect(exportMarkdownVisualsWithVisualExportWeb).toHaveBeenCalledWith(
      '```chart\n{"type":"pie","data":{"slices":[{"label":"ok","value":1}]}}\n```',
    );
  });

  it("returns only the validated spec in the web embed", async () => {
    const res = await handleRenderChart({
      type: "bar",
      data: {
        categories: ["a", "b"],
        series: [{ name: "s", values: ["10", 20] }],
      },
      title: "Demo",
      extra_garbage: "stripped",
    } as Record<string, unknown>);
    const rendered = vi.mocked(exportMarkdownVisualsWithVisualExportWeb).mock.calls[0][0];
    const inner = rendered.replace(/^```chart\n/, "").replace(/\n```$/, "");
    const spec = JSON.parse(inner);
    expect(spec.type).toBe("bar");
    expect(spec).not.toHaveProperty("schema_version");
    expect(spec.data.series[0].values).toEqual([10, 20]);
    expect(spec.title).toBe("Demo");
    expect(spec).not.toHaveProperty("extra_garbage");
    expect(res.content[0].text).toBe(rendered);
    expect(res.content[0].text).not.toContain("METADATA_JSON");
  });

  it("returns Mermaid as a web embed and image attachment", async () => {
    const res = await handleRenderMermaid({ source: "flowchart TD\nA --> B" });
    expect(res.content[0].text).toBe("```mermaid\nflowchart TD\nA --> B\n```");
    expect(res.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(exportMarkdownVisualsWithVisualExportWeb).toHaveBeenCalledWith(
      "```mermaid\nflowchart TD\nA --> B\n```",
    );
  });
});
