import { Resvg } from "@resvg/resvg-js";

export interface ChartSpec {
  title?: string;
  labels: string[];
  values: number[];
}

const MAX_CHART_ROWS = 12;
const MAX_LABEL_LENGTH = 28;
const FEISHU_IMAGE_LIMIT_BYTES = 10 * 1024 * 1024;

export function extractChartSpec(markdown: string): ChartSpec | null {
  const fenced = extractFencedChart(markdown);
  if (fenced) return normalizeChartSpec(fenced);
  return extractTableChart(markdown);
}

export async function renderChartPng(spec: ChartSpec): Promise<Buffer> {
  const normalized = normalizeChartSpec(spec);
  if (!normalized) throw new Error("invalid chart spec");

  const svg = renderChartSvg(normalized);
  return new Resvg(svg, {
    background: "#ffffff",
    fitTo: { mode: "original" },
    font: {
      loadSystemFonts: true,
      sansSerifFamily: "Arial",
    },
  }).render().asPng();
}

export async function maybeRenderChartPng(markdown: string): Promise<Buffer | null> {
  const spec = extractChartSpec(markdown);
  if (!spec) return null;
  const png = await renderChartPng(spec);
  return png.length <= FEISHU_IMAGE_LIMIT_BYTES ? png : null;
}

function extractFencedChart(markdown: string): unknown | null {
  const match = markdown.match(/```chart\s*\n([\s\S]*?)```/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function normalizeChartSpec(value: unknown): ChartSpec | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { title?: unknown; labels?: unknown; values?: unknown };
  if (!Array.isArray(raw.labels) || !Array.isArray(raw.values)) return null;

  const rows: Array<{ label: string; value: number }> = [];
  const count = Math.min(raw.labels.length, raw.values.length, MAX_CHART_ROWS);
  for (let i = 0; i < count; i++) {
    const label = normalizeLabel(raw.labels[i]);
    const parsed = parseNumber(raw.values[i]);
    if (label && parsed !== null) rows.push({ label, value: parsed });
  }
  if (rows.length === 0) return null;

  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 80) : undefined;
  return {
    title: title || undefined,
    labels: rows.map((row) => row.label),
    values: rows.map((row) => row.value),
  };
}

function extractTableChart(markdown: string): ChartSpec | null {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!looksLikeTableRow(lines[i]) || !looksLikeSeparator(lines[i + 1])) continue;

    const headers = splitTableRow(lines[i]);
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length; j++) {
      if (!looksLikeTableRow(lines[j])) break;
      const row = splitTableRow(lines[j]);
      if (row.length >= headers.length) rows.push(row);
    }
    const spec = tableToChartSpec(headers, rows);
    if (spec) return spec;
  }
  return null;
}

function tableToChartSpec(headers: string[], rows: string[][]): ChartSpec | null {
  if (headers.length < 2 || rows.length === 0) return null;

  let valueIndex = -1;
  let bestNumericCount = 0;
  for (let col = 0; col < headers.length; col++) {
    const numericCount = rows.reduce((count, row) => count + (parseNumber(row[col]) === null ? 0 : 1), 0);
    if (numericCount > bestNumericCount) {
      bestNumericCount = numericCount;
      valueIndex = col;
    }
  }
  if (valueIndex < 0 || bestNumericCount < 2) return null;

  const labelIndex = headers.findIndex((_, col) => col !== valueIndex);
  if (labelIndex < 0) return null;

  const chartRows: Array<{ label: string; value: number }> = [];
  for (const row of rows) {
    const label = normalizeLabel(row[labelIndex]);
    const value = parseNumber(row[valueIndex]);
    if (label && value !== null) chartRows.push({ label, value });
    if (chartRows.length >= MAX_CHART_ROWS) break;
  }
  if (chartRows.length < 2) return null;

  const labelHeader = normalizeLabel(headers[labelIndex]);
  const valueHeader = normalizeLabel(headers[valueIndex]);
  return {
    title: valueHeader && labelHeader ? `${valueHeader} by ${labelHeader}` : valueHeader || undefined,
    labels: chartRows.map((row) => row.label),
    values: chartRows.map((row) => row.value),
  };
}

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && splitTableRow(trimmed).length >= 2;
}

function looksLikeSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/,/g, "").replace(/%$/, "");
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeLabel(value: unknown): string {
  if (value === null || value === undefined) return "";
  const label = String(value).replace(/\s+/g, " ").trim();
  return label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH - 3)}...` : label;
}

function renderChartSvg(spec: ChartSpec): string {
  const width = 960;
  const height = 560;
  const margin = { top: 78, right: 44, bottom: 106, left: 82 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const minValue = Math.min(0, ...spec.values);
  const maxValue = Math.max(0, ...spec.values);
  const range = maxValue === minValue ? 1 : maxValue - minValue;
  const niceMax = maxValue + range * 0.08;
  const niceMin = minValue - range * 0.08;
  const niceRange = niceMax - niceMin || 1;
  const zeroY = valueToY(0, niceMin, niceRange, margin.top, plotHeight);
  const band = plotWidth / spec.values.length;
  const barWidth = Math.max(24, Math.min(72, band * 0.58));
  const gridLines = 5;

  const bars = spec.values.map((value, i) => {
    const x = margin.left + i * band + (band - barWidth) / 2;
    const y = valueToY(Math.max(value, 0), niceMin, niceRange, margin.top, plotHeight);
    const y0 = valueToY(Math.min(value, 0), niceMin, niceRange, margin.top, plotHeight);
    const h = Math.max(2, Math.abs(y0 - y));
    const labelX = margin.left + i * band + band / 2;
    const labelY = value >= 0 ? y - 10 : y0 + h + 18;
    return `
      <rect x="${x.toFixed(1)}" y="${Math.min(y, y0).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" rx="8" fill="#2563eb"/>
      <text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" class="value">${escapeXml(formatValue(value))}</text>
      <text x="${labelX.toFixed(1)}" y="${height - 54}" text-anchor="end" transform="rotate(-28 ${labelX.toFixed(1)} ${height - 54})" class="label">${escapeXml(spec.labels[i])}</text>
    `;
  }).join("");

  const grids = Array.from({ length: gridLines + 1 }, (_, i) => {
    const value = niceMin + (niceRange * i) / gridLines;
    const y = valueToY(value, niceMin, niceRange, margin.top, plotHeight);
    return `
      <line x1="${margin.left}" x2="${width - margin.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="grid"/>
      <text x="${margin.left - 14}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="axis">${escapeXml(formatValue(value))}</text>
    `;
  }).join("");

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    .title { font: 700 30px Arial, sans-serif; fill: #0f172a; }
    .subtitle { font: 400 14px Arial, sans-serif; fill: #64748b; }
    .axis { font: 400 13px Arial, sans-serif; fill: #64748b; }
    .label { font: 500 14px Arial, sans-serif; fill: #334155; }
    .value { font: 700 14px Arial, sans-serif; fill: #0f172a; }
    .grid { stroke: #e2e8f0; stroke-width: 1; }
    .baseline { stroke: #94a3b8; stroke-width: 2; }
  </style>
  <rect width="100%" height="100%" rx="0" fill="#ffffff"/>
  <text x="44" y="45" class="title">${escapeXml(spec.title || "Chart")}</text>
  <text x="44" y="68" class="subtitle">Generated from Siclaw response data</text>
  ${grids}
  <line x1="${margin.left}" x2="${width - margin.right}" y1="${zeroY.toFixed(1)}" y2="${zeroY.toFixed(1)}" class="baseline"/>
  ${bars}
</svg>`;
}

function valueToY(value: number, min: number, range: number, top: number, height: number): number {
  return top + height - ((value - min) / range) * height;
}

function formatValue(value: number): string {
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString("en-US");
  if (Math.abs(value) >= 10) return Number(value.toFixed(1)).toString();
  return Number(value.toFixed(2)).toString();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
