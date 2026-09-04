import { exportMarkdownVisualsWithVisualExportWeb } from "./visual-export.js";
import type { RenderChartArgs, RenderChartToolResponse } from "./types.js";

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
    "For qualitative diagrams, workflows, topology, or decision trees, use render_mermaid instead; xychart-beta is suitable for simple bar charts.",
    "Arguments must be one JSON object. data must be an object, never a JSON string. Use only literal finite numbers; never use placeholders, expressions, previous-message references, or bare tokens.",
    "After a successful render, the tool returns a web-renderable ```chart block plus a PNG image artifact. In web replies, include the returned chart block so the UI can render it. In IM channel sessions, preserve the image artifact and follow the channel instructions not to paste source. On every surface, make the natural-language answer complete on its own and never expose renderer metadata.",
  ].join(" ");

export const RENDER_MERMAID_INPUT_SCHEMA = {
  type: "object",
  required: ["source"],
  properties: {
    source: {
      type: "string",
      description:
        "The Mermaid source only, without ```mermaid fences. ControlPlane Web supports flowchart/graph, sequenceDiagram, timeline, and xychart-beta.",
    },
    title: {
      type: "string",
      description: "Optional title for metadata. It is not injected into the Mermaid source.",
    },
  },
  additionalProperties: false,
} as const;

export const RENDER_MERMAID_DESCRIPTION = [
  "Render a Mermaid diagram through ControlPlane Web's own Mermaid renderer/export path and return an image/png artifact.",
  "Use this in Feishu/Lark channel replies whenever the user asks for a flowchart, sequence diagram, timeline, topology, remediation flow, or Mermaid diagram image.",
  "Arguments must contain Mermaid source only, not fenced markdown. After a successful render, the tool returns a web-renderable ```mermaid block plus an image/png artifact. In web replies, include the returned Mermaid block so the UI can render it. In IM channel sessions, preserve the image artifact and follow the channel instructions not to paste source. On every surface, make the natural-language answer complete on its own and never expose renderer metadata.",
].join(" ");

export async function handleRenderChart(rawArgs: unknown): Promise<RenderChartToolResponse> {
  const args = validate(rawArgs);

  const spec = JSON.stringify(args);
  const markdownEmbed = "```chart\n" + spec + "\n```";
  const exported = await exportMarkdownVisualsWithVisualExportWeb(markdownEmbed);
  const visual = exported.find((item) => item.kind === "chart") ?? exported[0];
  if (!visual?.image) throw new Error("render_chart: ControlPlane Web export returned no chart image");
  const png = visual.image;

  return {
    content: [
      {
        type: "text",
        text: markdownEmbed,
      },
      {
        type: "image",
        mimeType: "image/png",
        data: png.toString("base64"),
      },
    ],
  };
}

export async function handleRenderMermaid(rawArgs: unknown): Promise<RenderChartToolResponse> {
  const args = validateMermaid(rawArgs);
  const markdownEmbed = "```mermaid\n" + args.source + "\n```";
  const exported = await exportMarkdownVisualsWithVisualExportWeb(markdownEmbed);
  const visual = exported.find((item) => item.kind === "mermaid") ?? exported[0];
  if (!visual?.image) throw new Error("render_mermaid: ControlPlane Web export returned no Mermaid image");

  return {
    content: [
      {
        type: "text",
        text: markdownEmbed,
      },
      {
        type: "image",
        mimeType: "image/png",
        data: visual.image.toString("base64"),
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

export function validateMermaid(raw: unknown): { source: string; title?: string } {
  if (!raw || typeof raw !== "object") {
    throw new Error("render_mermaid: arguments must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.source !== "string" || !obj.source.trim()) {
    throw new Error("render_mermaid: source is required");
  }
  const source = stripFence(obj.source.trim(), "mermaid");
  const out: { source: string; title?: string } = { source };
  if (typeof obj.title === "string" && obj.title.trim()) out.title = obj.title.trim();
  return out;
}

function stripFence(source: string, language: string): string {
  const re = new RegExp(`^\\s*\`\`\`${language}\\s*\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`\\s*$`, "i");
  return source.replace(re, "$1").trim();
}
