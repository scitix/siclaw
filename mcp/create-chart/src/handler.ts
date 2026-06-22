import { exportMarkdownVisualsWithSicoreWeb } from "./sicore-export.js";
import type { RenderChartArgs, RenderChartResult, RenderChartToolResponse } from "./types.js";

const CHART_SPEC_VERSION = 1;
const VISUAL_SPEC_VERSION = 1;

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
    "The tool renders through Sicore Web's own chart renderer/export path and returns a READY_TO_PASTE chart block as plain markdown, metadata, and a PNG image artifact. In your final reply, paste the READY_TO_PASTE block exactly as returned and preserve the image artifact. Do not rewrite, escape, quote, or wrap the chart JSON; the frontend renders ```chart fenced JSON blocks as SVG, while IM channels forward the PNG artifact.",
  ].join(" ");

export const RENDER_MERMAID_INPUT_SCHEMA = {
  type: "object",
  required: ["source"],
  properties: {
    source: {
      type: "string",
      description:
        "The Mermaid source only, without ```mermaid fences. Sicore Web supports flowchart/graph, sequenceDiagram, timeline, and xychart-beta.",
    },
    title: {
      type: "string",
      description: "Optional title for metadata. It is not injected into the Mermaid source.",
    },
  },
  additionalProperties: false,
} as const;

export const RENDER_MERMAID_DESCRIPTION = [
  "Render a Mermaid diagram through Sicore Web's own Mermaid renderer/export path and return a PNG image artifact.",
  "Use this in Feishu/Lark channel replies whenever the user asks for a flowchart, sequence diagram, timeline, topology, remediation flow, or Mermaid diagram image.",
  "Arguments must contain Mermaid source only, not fenced markdown. The tool returns READY_TO_PASTE ```mermaid markdown plus an image/png content block. Paste READY_TO_PASTE exactly and preserve the image artifact.",
].join(" ");

export const RENDER_VISUAL_CARD_INPUT_SCHEMA = {
  type: "object",
  required: ["type", "title"],
  properties: {
    type: {
      type: "string",
      enum: [
        "report",
        "final_report",
        "health_check",
        "incident_timeline",
        "root_cause_chain",
        "metric_snapshot",
        "status_distribution",
        "action_plan",
      ],
      description: "Sicore Web visual-card type.",
    },
    title: { type: "string" },
    label: { type: "string" },
    subtitle: { type: "string" },
    conclusion: { type: "string" },
    summary: { type: "string", description: "Alias accepted by Sicore Web as conclusion." },
    tone: { type: "string" },
    status: { type: "string" },
    footer: { type: "string" },
    items: { type: "array" },
    events: { type: "array" },
    nodes: { type: "array" },
    root_cause: { type: "string" },
    rootCause: { type: "string" },
    metrics: { type: "array" },
    segments: { type: "array" },
    total: { type: "number" },
    actions: { type: "array" },
    sections: { type: "array" },
  },
  additionalProperties: false,
} as const;

export const RENDER_VISUAL_CARD_DESCRIPTION = [
  "Render a Sicore Web visual-card conclusion card through Sicore Web's own visual-card renderer/export path and return a PNG image artifact.",
  "Use this for Feishu/Lark final diagnosis cards, health checks, root-cause summaries, incident timelines, metric snapshots, status distributions, and action plans when the group needs a conclusion-card image.",
  "Arguments must be one visual-card JSON object, not Markdown and not a JSON string. The tool returns READY_TO_PASTE ```visual-card markdown plus an image/png content block. Paste READY_TO_PASTE exactly and preserve the image artifact.",
].join(" ");

function newChartId(type: string): string {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function handleRenderChart(rawArgs: unknown): Promise<RenderChartToolResponse> {
  const args = validate(rawArgs);
  const id = newChartId(args.type);

  const spec = JSON.stringify(args);
  const markdownEmbed = "```chart\n" + spec + "\n```";
  const exported = await exportMarkdownVisualsWithSicoreWeb(markdownEmbed);
  const visual = exported.find((item) => item.kind === "chart") ?? exported[0];
  if (!visual?.image) throw new Error("render_chart: Sicore Web export returned no chart image");
  const png = visual.image;

  const result: RenderChartResult = {
    schema_version: CHART_SPEC_VERSION,
    chart_id: id,
    type: args.type,
    artifact_kind: "chart_spec",
    spec_path: "",
    svg_path: "",
    png_path: "",
    bytes: Buffer.byteLength(spec, "utf8"),
    image_bytes: png.byteLength,
    image_mime: "image/png",
    renderer: "sicore-web",
    embed_instructions:
      "Paste the READY_TO_PASTE block above verbatim into your reply where the chart should appear, and preserve the returned image artifact. Do not modify the JSON, add backslashes, escape non-ASCII characters, convert to ```svg, or inline an <img>.",
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
  const id = newChartId("mermaid");
  const markdownEmbed = "```mermaid\n" + args.source + "\n```";
  const exported = await exportMarkdownVisualsWithSicoreWeb(markdownEmbed);
  const visual = exported.find((item) => item.kind === "mermaid") ?? exported[0];
  if (!visual?.image) throw new Error("render_mermaid: Sicore Web export returned no Mermaid image");

  const meta = visualMetadata(id, "mermaid", markdownEmbed, visual.image);

  return {
    content: [
      {
        type: "text",
        text: [
          "READY_TO_PASTE:",
          markdownEmbed,
          "",
          "METADATA_JSON:",
          JSON.stringify(meta, null, 2),
        ].join("\n"),
      },
      {
        type: "image",
        mimeType: "image/png",
        data: visual.image.toString("base64"),
      },
    ],
  };
}

export async function handleRenderVisualCard(rawArgs: unknown): Promise<RenderChartToolResponse> {
  const spec = validateVisualCard(rawArgs);
  const id = newChartId("visual-card");
  const specJson = JSON.stringify(spec);
  const markdownEmbed = "```visual-card\n" + specJson + "\n```";
  const exported = await exportMarkdownVisualsWithSicoreWeb(markdownEmbed);
  const visual = exported.find((item) => item.kind === "visual-card") ?? exported[0];
  if (!visual?.image) throw new Error("render_visual_card: Sicore Web export returned no visual-card image");

  const meta = visualMetadata(id, "visual-card", markdownEmbed, visual.image);

  return {
    content: [
      {
        type: "text",
        text: [
          "READY_TO_PASTE:",
          markdownEmbed,
          "",
          "METADATA_JSON:",
          JSON.stringify(meta, null, 2),
        ].join("\n"),
      },
      {
        type: "image",
        mimeType: "image/png",
        data: visual.image.toString("base64"),
      },
    ],
  };
}

function visualMetadata(
  id: string,
  kind: "mermaid" | "visual-card",
  markdownEmbed: string,
  image: Buffer,
): Record<string, unknown> {
  return {
    schema_version: VISUAL_SPEC_VERSION,
    visual_id: id,
    type: kind,
    artifact_kind: `${kind}_spec`,
    spec_path: "",
    png_path: "",
    bytes: Buffer.byteLength(markdownEmbed, "utf8"),
    image_bytes: image.byteLength,
    image_mime: "image/png",
    renderer: "sicore-web",
    embed_instructions:
      "Paste the READY_TO_PASTE block above verbatim into your reply and preserve the returned image artifact. Do not expose escaped JSON or describe Feishu upload mechanics.",
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

export function validateVisualCard(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("render_visual_card: arguments must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";
  if (!RENDER_VISUAL_CARD_INPUT_SCHEMA.properties.type.enum.includes(type as any)) {
    throw new Error("render_visual_card: type is required and must be a supported Sicore visual-card type");
  }
  if (typeof obj.title !== "string" || !obj.title.trim()) {
    throw new Error("render_visual_card: title is required");
  }
  if (!hasVisualCardBody(obj)) {
    throw new Error("render_visual_card: provide conclusion, items, metrics, segments, events, nodes, actions, or sections");
  }
  const allowed = new Set(Object.keys(RENDER_VISUAL_CARD_INPUT_SCHEMA.properties));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}

function hasVisualCardBody(obj: Record<string, unknown>): boolean {
  if (typeof obj.conclusion === "string" && obj.conclusion.trim()) return true;
  if (typeof obj.summary === "string" && obj.summary.trim()) return true;
  return ["items", "metrics", "segments", "events", "nodes", "actions", "sections"].some((key) => {
    const value = obj[key];
    return Array.isArray(value) && value.length > 0;
  });
}

function stripFence(source: string, language: string): string {
  const re = new RegExp(`^\\s*\`\`\`${language}\\s*\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`\\s*$`, "i");
  return source.replace(re, "$1").trim();
}
