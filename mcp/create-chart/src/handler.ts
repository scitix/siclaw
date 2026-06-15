import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RenderChartArgs, RenderChartResult } from "./types.js";

const CHART_SPEC_VERSION = 1;

export const RENDER_CHART_INPUT_SCHEMA = {
  type: "object",
  required: ["type", "data"],
  properties: {
    type: {
      type: "string",
      enum: ["pie", "bar", "line"],
      description:
        "Chart type. pie for proportions/distributions, bar for category comparisons, line for time series (e.g. VM samples).",
    },
    data: {
      type: "object",
      description:
        "Chart data as a real JSON object, never as a JSON string. Pie: {slices:[{label,value}]}. Bar: {categories:[string], series:[{name,values:[number]}]}. Line: {series:[{name, points:[{x:number|string, y:number}]}]}. Every numeric value must be finite; x/category labels may be strings. Do not use placeholders, variables, or references to earlier messages.",
    },
    title: { type: "string" },
    width: { type: "integer", minimum: 200, maximum: 2400 },
    height: { type: "integer", minimum: 160, maximum: 2000 },
    x_label: { type: "string" },
    y_label: { type: "string" },
  },
  additionalProperties: false,
} as const;

export const RENDER_CHART_DESCRIPTION =
  [
    "Render a pie/bar/line chart only when finalized structured numeric data is already in context and can be passed as valid tool arguments. This includes requests such as 画图, 画饼图, 柱状图, 趋势图 when the required numeric data is available.",
    "For qualitative diagrams, workflows, topology, or decision trees, use a ```mermaid fenced block instead; xychart-beta is suitable for simple bar charts.",
    "Arguments must be one JSON object. data must be an object, never a JSON string. Use only literal finite numbers; never use placeholders, expressions, previous-message references, or bare tokens.",
    "The tool returns a READY_TO_PASTE chart block as plain markdown plus metadata. In your final reply, paste the READY_TO_PASTE block exactly as returned. Do not rewrite, escape, quote, or wrap the chart JSON; the frontend renders ```chart fenced JSON blocks as SVG.",
  ].join(" ");

function chartBaseDir(): string {
  const root =
    process.env.CREATE_CHART_ARTIFACT_DIR ??
    ".siclaw/user-data/tool-results/create-chart";
  return path.resolve(root, "chart-render");
}

function newChartId(type: string): string {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function handleRenderChart(rawArgs: unknown): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  const args = validate(rawArgs);
  const id = newChartId(args.type);

  const spec = JSON.stringify({ ...args, schema_version: CHART_SPEC_VERSION });
  const markdownEmbed = "```chart\n" + spec + "\n```";

  let specPath: string | undefined;
  try {
    const dir = chartBaseDir();
    await mkdir(dir, { recursive: true });
    specPath = path.join(dir, `${id}.json`);
    await writeFile(specPath, spec, "utf8");
  } catch {
    /* swallow — disk persistence is best-effort */
  }

  const result: RenderChartResult = {
    schema_version: CHART_SPEC_VERSION,
    chart_id: id,
    type: args.type,
    artifact_kind: "chart_spec",
    spec_path: specPath ?? "",
    svg_path: "",
    bytes: Buffer.byteLength(spec, "utf8"),
    embed_instructions:
      "Paste the READY_TO_PASTE block above verbatim into your reply where the chart should appear. Do not modify the JSON, add backslashes, escape non-ASCII characters, convert to ```svg, or inline an <img>.",
  };

  return {
    content: [
      {
        type: "text",
        text: [
          "READY_TO_PASTE:",
          markdownEmbed,
          "",
          "METADATA_JSON:",
          JSON.stringify(result, null, 2),
        ].join("\n"),
      },
    ],
  };
}

export function validate(raw: unknown): RenderChartArgs {
  if (!raw || typeof raw !== "object") {
    throw new Error("render_chart: arguments must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (type !== "pie" && type !== "bar" && type !== "line") {
    throw new Error("render_chart: type must be pie, bar, or line");
  }
  const data = obj.data;
  if (!data || typeof data !== "object") {
    throw new Error("render_chart: data is required");
  }
  const common: Record<string, unknown> = {};
  for (const k of ["title", "x_label", "y_label"]) {
    if (typeof obj[k] === "string") common[k] = obj[k];
  }
  for (const k of ["width", "height"]) {
    if (typeof obj[k] === "number" && Number.isFinite(obj[k])) common[k] = obj[k];
  }

  if (type === "pie") {
    const slices = (data as { slices?: unknown }).slices;
    if (!Array.isArray(slices) || slices.length === 0) {
      throw new Error("render_chart: pie.data.slices must be a non-empty array");
    }
    const cleaned = slices.map((s, i) => {
      const item = s as { label?: unknown; value?: unknown };
      if (typeof item.value !== "number" || !Number.isFinite(item.value)) {
        throw new Error(`render_chart: pie slice[${i}].value must be a number`);
      }
      return { label: String(item.label ?? `slice ${i}`), value: item.value };
    });
    return { type, data: { slices: cleaned }, ...common };
  }

  if (type === "bar") {
    const d = data as { categories?: unknown; series?: unknown };
    if (!Array.isArray(d.categories) || !d.categories.length) {
      throw new Error("render_chart: bar.data.categories must be a non-empty array");
    }
    if (!Array.isArray(d.series) || !d.series.length) {
      throw new Error("render_chart: bar.data.series must be a non-empty array");
    }
    const categories = d.categories.map(String);
    const series = d.series.map((s, i) => {
      const item = s as { name?: unknown; values?: unknown };
      if (!Array.isArray(item.values)) {
        throw new Error(`render_chart: bar series[${i}].values must be an array`);
      }
      if (item.values.length !== categories.length) {
        throw new Error(
          `render_chart: bar series[${i}].values length (${item.values.length}) must equal categories length (${categories.length})`,
        );
      }
      return {
        name: String(item.name ?? `series ${i}`),
        values: item.values.map((v, j) => {
          const n = typeof v === "number" ? v : Number(v);
          if (!Number.isFinite(n)) {
            throw new Error(
              `render_chart: bar series[${i}].values[${j}] must be a finite number`,
            );
          }
          return n;
        }),
      };
    });
    return { type, data: { categories, series }, ...common };
  }

  const d = data as { series?: unknown };
  if (!Array.isArray(d.series) || !d.series.length) {
    throw new Error("render_chart: line.data.series must be a non-empty array");
  }
  const series = d.series.map((s, i) => {
    const item = s as { name?: unknown; points?: unknown };
    if (!Array.isArray(item.points) || !item.points.length) {
      throw new Error(`render_chart: line series[${i}].points must be a non-empty array`);
    }
    const points = item.points.map((p, j) => {
      const pt = p as { x?: unknown; y?: unknown };
      if (typeof pt.y !== "number" || !Number.isFinite(pt.y)) {
        throw new Error(`render_chart: line series[${i}].points[${j}].y must be a number`);
      }
      const x =
        typeof pt.x === "number" || typeof pt.x === "string"
          ? pt.x
          : String(pt.x);
      return { x, y: pt.y };
    });
    return { name: String(item.name ?? `series ${i}`), points };
  });
  return { type: "line", data: { series }, ...common };
}
