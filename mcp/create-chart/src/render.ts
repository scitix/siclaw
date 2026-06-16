import { Resvg } from "@resvg/resvg-js";
import type { BarSeries, LineSeries, PieSlice, RenderChartArgs } from "./types.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 560;
const MAX_CATEGORIES = 24;
const MAX_SERIES = 6;
const MAX_SLICES = 12;
const PALETTE = ["#2563eb", "#16a34a", "#f97316", "#9333ea", "#0891b2", "#dc2626"];

export function renderChartPng(args: RenderChartArgs): Buffer {
  const svg = renderChartSvg(args);
  return Buffer.from(new Resvg(svg, {
    font: {
      loadSystemFonts: true,
      fontDirs: ["/usr/share/fonts", "/usr/local/share/fonts"],
      defaultFontFamily: "Noto Sans CJK SC",
      sansSerifFamily: "Noto Sans CJK SC",
    },
    fitTo: { mode: "original" },
  }).render().asPng());
}

export function renderChartSvg(args: RenderChartArgs): string {
  const width = clampDimension(args.width, 200, 2400, DEFAULT_WIDTH);
  const height = clampDimension(args.height, 160, 2000, DEFAULT_HEIGHT);
  if (args.type === "pie") return renderPieSvg(args.title, args.data.slices, width, height);
  if (args.type === "line") return renderLineSvg(args.title, args.x_label, args.y_label, args.data.series, width, height);
  return renderBarSvg(args.title, args.x_label, args.y_label, args.data.categories, args.data.series, width, height);
}

function renderBarSvg(
  title: string | undefined,
  xLabel: string | undefined,
  yLabel: string | undefined,
  categoriesInput: string[],
  seriesInput: BarSeries[],
  width: number,
  height: number,
): string {
  const categories = categoriesInput.slice(0, MAX_CATEGORIES);
  const series = seriesInput.slice(0, MAX_SERIES).map((s) => ({
    name: s.name,
    values: s.values.slice(0, categories.length),
  }));
  const values = series.flatMap((s) => s.values);
  const scale = valueScale(values, 5);
  const area = chartArea(width, height);
  const zeroY = yForValue(0, scale, area);
  const groupWidth = area.width / categories.length;
  const barWidth = Math.max(5, Math.min(36, (groupWidth - 14) / Math.max(1, series.length)));

  const body: string[] = [];
  body.push(renderAxes(area, scale, yLabel));

  for (let i = 0; i < categories.length; i++) {
    const groupLeft = area.x + i * groupWidth;
    for (let s = 0; s < series.length; s++) {
      const value = series[s].values[i] ?? 0;
      const y = yForValue(value, scale, area);
      const x = groupLeft + (groupWidth - barWidth * series.length) / 2 + s * barWidth;
      const rectY = Math.min(y, zeroY);
      const rectHeight = Math.max(1, Math.abs(zeroY - y));
      body.push(`<rect x="${round(x)}" y="${round(rectY)}" width="${round(barWidth - 2)}" height="${round(rectHeight)}" rx="4" fill="${PALETTE[s % PALETTE.length]}"/>`);
      if (categories.length <= 12 && series.length <= 3) {
        body.push(`<text x="${round(x + barWidth / 2)}" y="${round(rectY - 7)}" text-anchor="middle" class="value">${escapeXml(formatValue(value))}</text>`);
      }
    }
    if (shouldShowTick(i, categories.length)) {
      body.push(`<text x="${round(groupLeft + groupWidth / 2)}" y="${area.y + area.height + 30}" text-anchor="middle" class="tick">${escapeXml(truncate(categories[i], 18))}</text>`);
    }
  }

  if (xLabel) body.push(`<text x="${width / 2}" y="${height - 24}" text-anchor="middle" class="axisLabel">${escapeXml(xLabel)}</text>`);
  body.push(renderLegend(series.map((s) => s.name), area.x + area.width - 180, 28));
  return svgShell(width, height, title, body.join("\n"));
}

function renderLineSvg(
  title: string | undefined,
  xLabel: string | undefined,
  yLabel: string | undefined,
  seriesInput: LineSeries[],
  width: number,
  height: number,
): string {
  const series = seriesInput.slice(0, MAX_SERIES).map((s) => ({
    name: s.name,
    points: s.points.slice(0, MAX_CATEGORIES),
  }));
  const values = series.flatMap((s) => s.points.map((p) => p.y));
  const scale = valueScale(values, 5);
  const area = chartArea(width, height);
  const maxPoints = Math.max(...series.map((s) => s.points.length), 1);
  const xForIndex = (index: number) => area.x + (maxPoints === 1 ? area.width / 2 : (index / (maxPoints - 1)) * area.width);

  const body: string[] = [];
  body.push(renderAxes(area, scale, yLabel));

  for (const [seriesIndex, s] of series.entries()) {
    const color = PALETTE[seriesIndex % PALETTE.length];
    const points = s.points.map((point, i) => `${round(xForIndex(i))},${round(yForValue(point.y, scale, area))}`).join(" ");
    body.push(`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`);
    for (const [i, point] of s.points.entries()) {
      body.push(`<circle cx="${round(xForIndex(i))}" cy="${round(yForValue(point.y, scale, area))}" r="4" fill="#ffffff" stroke="${color}" stroke-width="2"/>`);
    }
  }

  const ticks = series[0]?.points ?? [];
  for (let i = 0; i < ticks.length; i++) {
    if (!shouldShowTick(i, ticks.length)) continue;
    body.push(`<text x="${round(xForIndex(i))}" y="${area.y + area.height + 30}" text-anchor="middle" class="tick">${escapeXml(truncate(String(ticks[i].x), 18))}</text>`);
  }
  if (xLabel) body.push(`<text x="${width / 2}" y="${height - 24}" text-anchor="middle" class="axisLabel">${escapeXml(xLabel)}</text>`);
  body.push(renderLegend(series.map((s) => s.name), area.x + area.width - 180, 28));
  return svgShell(width, height, title, body.join("\n"));
}

function renderPieSvg(
  title: string | undefined,
  slicesInput: PieSlice[],
  width: number,
  height: number,
): string {
  const slices = slicesInput
    .filter((slice) => slice.value > 0)
    .slice(0, MAX_SLICES);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const cx = Math.round(width * 0.36);
  const cy = Math.round(height * 0.55);
  const radius = Math.max(60, Math.min(width * 0.24, height * 0.32));
  let angle = -90;
  const body: string[] = [];

  if (slices.length === 1) {
    body.push(`<circle cx="${cx}" cy="${cy}" r="${round(radius)}" fill="${PALETTE[0]}"/>`);
  } else {
    for (const [index, slice] of slices.entries()) {
      const delta = (slice.value / total) * 360;
      const end = angle + delta;
      body.push(`<path d="${arcPath(cx, cy, radius, angle, end)}" fill="${PALETTE[index % PALETTE.length]}"/>`);
      angle = end;
    }
  }

  const legendX = Math.round(width * 0.62);
  let legendY = Math.round(height * 0.28);
  for (const [index, slice] of slices.entries()) {
    const pct = total > 0 ? `${Math.round((slice.value / total) * 100)}%` : "0%";
    body.push(`<rect x="${legendX}" y="${legendY - 12}" width="14" height="14" rx="3" fill="${PALETTE[index % PALETTE.length]}"/>`);
    body.push(`<text x="${legendX + 24}" y="${legendY}" class="legend">${escapeXml(truncate(slice.label, 28))} · ${escapeXml(formatValue(slice.value))} · ${pct}</text>`);
    legendY += 28;
  }

  return svgShell(width, height, title, body.join("\n"));
}

function chartArea(width: number, height: number): { x: number; y: number; width: number; height: number } {
  return {
    x: 78,
    y: 92,
    width: Math.max(120, width - 132),
    height: Math.max(80, height - 188),
  };
}

function renderAxes(area: { x: number; y: number; width: number; height: number }, scale: { min: number; max: number; ticks: number[] }, yLabel: string | undefined): string {
  const lines: string[] = [];
  for (const tick of scale.ticks) {
    const y = yForValue(tick, scale, area);
    lines.push(`<line x1="${area.x}" y1="${round(y)}" x2="${area.x + area.width}" y2="${round(y)}" class="grid"/>`);
    lines.push(`<text x="${area.x - 12}" y="${round(y + 4)}" text-anchor="end" class="tick">${escapeXml(formatValue(tick))}</text>`);
  }
  lines.push(`<line x1="${area.x}" y1="${area.y}" x2="${area.x}" y2="${area.y + area.height}" class="axis"/>`);
  lines.push(`<line x1="${area.x}" y1="${area.y + area.height}" x2="${area.x + area.width}" y2="${area.y + area.height}" class="axis"/>`);
  if (yLabel) {
    lines.push(`<text x="22" y="${area.y + area.height / 2}" transform="rotate(-90 22 ${area.y + area.height / 2})" text-anchor="middle" class="axisLabel">${escapeXml(yLabel)}</text>`);
  }
  return lines.join("\n");
}

function renderLegend(names: Array<string | undefined>, x: number, y: number): string {
  if (names.length <= 1) return "";
  return names.map((name, index) => `
    <rect x="${x}" y="${y + index * 24}" width="12" height="12" rx="3" fill="${PALETTE[index % PALETTE.length]}"/>
    <text x="${x + 20}" y="${y + index * 24 + 11}" class="legend">${escapeXml(truncate(name || `series ${index}`, 24))}</text>
  `).join("\n");
}

function valueScale(values: number[], targetTicks: number): { min: number; max: number; ticks: number[] } {
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) {
    max = min + 1;
  }
  const span = max - min;
  const padding = span * 0.08;
  min -= padding;
  max += padding;
  const tickStep = niceNumber((max - min) / targetTicks);
  const tickMin = Math.floor(min / tickStep) * tickStep;
  const tickMax = Math.ceil(max / tickStep) * tickStep;
  const ticks: number[] = [];
  for (let tick = tickMin; tick <= tickMax + tickStep / 2; tick += tickStep) {
    ticks.push(round(tick));
  }
  return { min: tickMin, max: tickMax, ticks };
}

function yForValue(value: number, scale: { min: number; max: number }, area: { y: number; height: number }): number {
  return area.y + ((scale.max - value) / (scale.max - scale.min)) * area.height;
}

function niceNumber(value: number): number {
  const exponent = Math.floor(Math.log10(value || 1));
  const fraction = value / 10 ** exponent;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * 10 ** exponent;
}

function arcPath(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): string {
  const start = polar(cx, cy, radius, endAngle);
  const end = polar(cx, cy, radius, startAngle);
  const large = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${cx} ${cy} L ${round(start.x)} ${round(start.y)} A ${round(radius)} ${round(radius)} 0 ${large} 0 ${round(end.x)} ${round(end.y)} Z`;
}

function polar(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  const rad = (angle * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

function svgShell(width: number, height: number, title: string | undefined, body: string): string {
  const safeTitle = truncate(title || "Chart", 80);
  return `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    text { font-family: "Noto Sans CJK SC", "Noto Sans CJK", "Noto Sans", Arial, sans-serif; }
    .title { font-size: 26px; font-weight: 700; fill: #0f172a; }
    .tick { font-size: 12px; fill: #64748b; }
    .value { font-size: 12px; font-weight: 600; fill: #334155; }
    .axisLabel { font-size: 13px; font-weight: 600; fill: #475569; }
    .legend { font-size: 13px; fill: #334155; }
    .grid { stroke: #e2e8f0; stroke-width: 1; }
    .axis { stroke: #94a3b8; stroke-width: 1.4; }
  </style>
  <rect width="100%" height="100%" rx="0" fill="#ffffff"/>
  <text x="42" y="46" class="title">${escapeXml(safeTitle)}</text>
  ${body}
</svg>`;
}

function shouldShowTick(index: number, total: number): boolean {
  if (total <= 10) return true;
  const step = Math.ceil(total / 10);
  return index % step === 0 || index === total - 1;
}

function clampDimension(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
}

function formatValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${round(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${round(value / 1_000)}k`;
  return String(round(value));
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
