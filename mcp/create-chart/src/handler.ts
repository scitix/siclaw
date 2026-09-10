import { randomUUID } from "node:crypto";
import { normalizeWaterfallSpec, traceSummary, formatTraceMs } from "./waterfall-spec.js";
import { exportMarkdownVisualsWithVisualExportWeb } from "./visual-export.js";
import type { RenderChartArgs, RenderChartToolResponse } from "./types.js";

export const RENDER_CHART_INPUT_SCHEMA = {
  type: "object",
  required: ["type", "data"],
  properties: {
    type: {
      type: "string",
      enum: ["pie", "bar", "line", "waterfall"],
      description:
        "Chart type. pie for proportions/distributions, bar for category comparisons, line for time series; waterfall for an evidence-based request trace with precise span intervals.",
    },
    data: {
      type: "object",
      description:
        "Chart data as a real JSON object, never as a JSON string. Pie: {slices:[{label,value}]}. Bar: {categories:[string], series:[{name,values:[number]}]}. Line: {series:[{name, points:[{x:number|string, y:number}]}]}. Every numeric value must be finite; x/category labels may be strings. Waterfall: {origin_time: UTC RFC3339, request_id?, trace_id?, root_span_id?, scope?:{plane?,project?,cluster?}, coverage:{observed:string[],missing:string[],complete:boolean}, spans:[{span_id,parent_span_id?,label,service?,start_ms,end_ms:number|null,status:ok|error|unset|cancelled|unknown,layer:server|internal|route|http|derived,attempt_id?,http_status?,evidence_refs:string[]}]}. Instead of relative milliseconds a span can supply start_time/end_time UTC timestamps; the tool subtracts origin without losing sub-millisecond precision. Use at most 200 unique spans. Keep true parent IDs; attempt_id only groups confirmed attempts. Omit bodies, headers, full URLs/ARNs, prompts and credentials. Missing end is null; never add nested durations or infer token timing from an HTTP span. Do not use placeholders, variables, or references to earlier messages.",
    },
    title: { type: "string" },
    width: { type: "integer", minimum: 200, maximum: 2400 },
    height: { type: "integer", minimum: 160, maximum: 2000 },
    x_label: { type: "string" },
    y_label: { type: "string" },
    output: { type: "string", enum: ["web", "image", "both"], description: "web returns data without a screenshot service; image requires PNG; both preserves Web data if PNG fails. Default: both for waterfall, image for existing charts." },
  },
  additionalProperties: false,
} as const;

export const RENDER_CHART_DESCRIPTION =
  [
    "Render a pie/bar/line chart or interactive waterfall request timeline only when finalized structured numeric data is already in context and can be passed as valid tool arguments. This includes requests such as 画图, 画饼图, 柱状图, 趋势图 when the required numeric data is available.",
    "For qualitative diagrams, workflows, topology, or decision trees, use render_mermaid instead; xychart-beta is suitable for simple bar charts.",
    "Arguments must be one JSON object. data must be an object, never a JSON string. Use only literal finite numbers; never use placeholders, expressions, previous-message references, or bare tokens.",
    "For pie/bar/line, after a successful render the tool returns a web-renderable ```chart block plus a PNG image artifact. In web replies, include the returned chart block so the UI can render it. In IM channel sessions, preserve the image artifact and follow the channel instructions not to paste source. On every surface, make the natural-language answer complete on its own and never expose renderer metadata.",
    "For waterfall, the tool returns a structured attachment and readable summary. Web clients render the attachment automatically: summarize findings without repeating its JSON or chart fence. In Feishu/Lark use output=both for PNG; use output=web for Web-only requests. Keep incomplete evidence explicit and the natural-language answer complete on its own.",
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
  const output = (rawArgs as Record<string, unknown>).output ?? (args.type === "waterfall" ? "both" : "image");
  if (output !== "web" && output !== "both" && output !== "image") {
    throw new Error("render_chart: output must be web, image, or both");
  }
  const id = `${args.type}-${randomUUID()}`;
  const chart = args.type === "waterfall" ? { ...args, visual_id: id } : args;
  const markdownEmbed = "```chart\n" + JSON.stringify(chart) + "\n```";
  let png: Buffer | undefined;
  let exportFailed = false;
  if (output !== "web") {
    try {
      const exported = await exportMarkdownVisualsWithVisualExportWeb(markdownEmbed);
      const visual = exported.find((item) => item.kind === "chart");
      if (!visual?.image?.byteLength) throw new Error("render_chart: ControlPlane Web export returned no chart image");
      png = visual.image;
    } catch (error) {
      if (output === "image") throw error;
      exportFailed = true;
    }
  }
  const summary = args.type === "waterfall" ? traceSummary(args) : null;
  const readable = args.type === "waterfall" && summary
    ? [args.title ?? "Request timeline",
      `Observed spans: ${args.data.spans.length}; HTTP calls: ${summary.http_calls}; selected-root duration: ${formatTraceMs(summary.total_ms)}.`,
      `Observed: ${args.data.coverage.observed.join(", ") || "unspecified"}. Missing: ${args.data.coverage.missing.join(", ") || "none declared"}. Trace completeness: ${args.data.coverage.complete ? "complete" : "partial"}.`,
      ...args.data.spans.filter(s => s.layer === "http" || s.layer === "route").slice(0, 12).map(s => `${s.label}: ${formatTraceMs(s.end_ms === null ? null : s.end_ms - s.start_ms)}; ${s.status}${s.http_status ? `; HTTP ${s.http_status}` : ""}.`),
      "The Web conversation renders this attachment automatically. Summarize findings without repeating its JSON or chart fence.",
      ...(exportFailed ? ["PNG export unavailable; the interactive data and this summary are preserved."] : [])].join("\n")
    : markdownEmbed;
  return {
    content: [{ type: "text", text: readable }, ...(png ? [{ type: "image" as const, mimeType: "image/png" as const, data: png.toString("base64") }] : [])],
    ...(args.type === "waterfall" ? { structuredContent: {
      schema_version: 2,
      visuals: [{ visual_id: id, kind: "chart", spec: chart, exports: { png: { status: png ? "ready" : exportFailed ? "failed" : "not_requested" } } }],
    } } : {}),
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
  if (type === "waterfall") return normalizeWaterfallSpec(obj);
  if (type !== "pie" && type !== "bar" && type !== "line") {
    throw new Error("render_chart: type must be pie, bar, line, or waterfall");
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
