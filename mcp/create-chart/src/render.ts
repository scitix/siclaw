import { Resvg } from "@resvg/resvg-js";
import type { BarSeries, LineSeries, PieSlice, RenderChartArgs } from "./types.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const PALETTE = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#b6992d", "#d37295",
];
const OTHERS_COLOR = "#9aa0a6";

const TITLE_SIZE = 18;
const LEGEND_SIZE = 13;
const LEGEND_LINE_H = LEGEND_SIZE + 9;
const AXIS_LABEL_SIZE = 13;
const TICK_SIZE = 12;
const PIE_LABEL_SIZE = 12;
const LEGEND_SWATCH = 12;
const LEGEND_GAP = 6;
const LEGEND_BETWEEN = 18;
const LEGEND_MARGIN = 16;
const PIE_MAX_SLICES = 12;
const BAR_TICK_ROTATE_DEG = 30;
const BAR_TICK_GAP = 16;
const BAR_TICK_BASE_H = 50;
const LINE_DASHES = ["", "7 4", "2 4", "10 4 2 4", "1 5"];
const MARKER_SHAPES = ["circle", "square", "triangle", "diamond"] as const;

type MarkerShapeKind = typeof MARKER_SHAPES[number];

interface Axis {
  min: number;
  max: number;
  ticks: number[];
  log?: boolean;
}

interface Plot {
  left: number;
  right: number;
  top: number;
  bottom: number;
  w: number;
  h: number;
}

export function renderChartPng(args: RenderChartArgs): Buffer {
  const svg = renderChartSvg(args);
  return Buffer.from(new Resvg(svg, {
    font: {
      loadSystemFonts: true,
      fontDirs: ["/usr/share/fonts", "/usr/local/share/fonts"],
      defaultFontFamily: "Noto Sans CJK SC",
      sansSerifFamily: "Noto Sans CJK SC",
    },
    fitTo: { mode: "zoom", value: 2 },
  }).render().asPng());
}

export function renderChartSvg(args: RenderChartArgs): string {
  const spec = args;
  const { width, height, legendRows } = chartCanvasSize(spec, null);
  let body = "";
  if (spec.type === "pie") body = renderPie(spec, width, height);
  else if (spec.type === "line") body = renderLine(spec, width, height, effectiveLog(spec), legendRows);
  else body = renderBar(spec, width, height, effectiveLog(spec), legendRows);
  return svgShell(width, height, spec.title, describeChart(spec), body);
}

function renderPie(
  spec: Extract<RenderChartArgs, { type: "pie" }>,
  width: number,
  height: number,
): string {
  const { slices, othersIndex } = collapsePieSlices(spec.data.slices);
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  if (total <= 0) return renderNoData(width, height);

  const titleH = spec.title ? 30 : 6;
  const padY = 16;
  const top = titleH + padY;
  const bottom = height - padY;
  const innerH = bottom - top;
  const labels = slices.map((slice) => {
    const suffix = ` (${fmtNumber(slice.value)}, ${((slice.value / total) * 100).toFixed(1)}%)`;
    return { name: slice.label, suffix, full: `${slice.label}${suffix}` };
  });
  const legendW = Math.min(
    Math.max(...labels.map((label) => approxTextWidth(label.full, LEGEND_SIZE))) + 28,
    width * 0.42,
  );
  const pieAreaW = width - legendW - 32;
  const cx = 16 + pieAreaW / 2;
  const cy = top + innerH / 2;
  const r = Math.max(60, Math.min(pieAreaW / 2 - 12, innerH / 2 - 8));

  const parts: string[] = [];
  let angle = -Math.PI / 2;
  for (const [index, slice] of slices.entries()) {
    const value = Math.max(0, slice.value);
    if (value === 0) continue;
    const sweep = (value / total) * Math.PI * 2;
    const endAngle = angle + sweep;
    const color = pieSliceColor(index, othersIndex);
    if (slices.length === 1 || sweep >= Math.PI * 2 - 1e-6) {
      parts.push(`<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r)}" fill="${color}"/>`);
    } else {
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(endAngle);
      const y2 = cy + r * Math.sin(endAngle);
      const large = sweep > Math.PI ? 1 : 0;
      parts.push(`<path d="M ${round(cx)} ${round(cy)} L ${round(x1)} ${round(y1)} A ${round(r)} ${round(r)} 0 ${large} 1 ${round(x2)} ${round(y2)} Z" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>`);
    }
    if (sweep > 0.18) {
      const mid = angle + sweep / 2;
      const lx = cx + r * 0.62 * Math.cos(mid);
      const ly = cy + r * 0.62 * Math.sin(mid);
      parts.push(`<text x="${round(lx)}" y="${round(ly)}" text-anchor="middle" dominant-baseline="middle" font-size="${PIE_LABEL_SIZE}" font-weight="600" fill="#ffffff">${escapeXml(((value / total) * 100).toFixed(1))}%</text>`);
    }
    angle = endAngle;
  }

  const legendX = width - legendW - 8;
  const lineH = LEGEND_SIZE + 10;
  const legendBlockH = labels.length * lineH;
  let legendY = Math.max(top + 8, top + (innerH - legendBlockH) / 2 + LEGEND_SIZE);
  const legendTextW = Math.max(24, legendW - 30);
  for (const [index, label] of labels.entries()) {
    const color = pieSliceColor(index, othersIndex);
    const suffixW = approxTextWidth(label.suffix, LEGEND_SIZE);
    const nameW = Math.max(24, legendTextW - suffixW);
    const shown = approxTextWidth(label.full, LEGEND_SIZE) > legendTextW
      ? `${ellipsizeText(label.name, nameW, LEGEND_SIZE)}${label.suffix}`
      : label.full;
    parts.push(`<rect x="${round(legendX)}" y="${round(legendY - LEGEND_SIZE + 2)}" width="14" height="14" fill="${color}" rx="2"/>`);
    parts.push(`<text x="${round(legendX + 22)}" y="${round(legendY + 2)}" font-size="${LEGEND_SIZE}" fill="#374151">${escapeXml(shown)}</text>`);
    legendY += lineH;
  }
  return parts.join("\n");
}

function renderBar(
  spec: Extract<RenderChartArgs, { type: "bar" }>,
  width: number,
  height: number,
  useLog: boolean,
  legendRows: number,
): string {
  const { categories, series } = spec.data;
  if (!categories.length || !series.length) return renderNoData(width, height);

  const hasLegend = series.length > 1;
  const legendNames = series.map((item) => item.name);
  const { rotate, tickBandH, sidePaddingLeft, sidePaddingRight } = barTickLayout(categories, width, {
    hasYAxisLabel: Boolean(spec.y_label),
  });
  const plot = computePlot(
    width,
    height,
    Boolean(spec.title),
    legendRows,
    true,
    rotate,
    Boolean(spec.y_label),
    Boolean(spec.x_label),
    tickBandH,
    { left: sidePaddingLeft, right: sidePaddingRight },
  );

  const values = series.flatMap((item) => item.values).filter(Number.isFinite);
  const axis = yAxis(values, useLog);
  const groupW = plot.w / categories.length;
  const groupPad = Math.min(20, groupW * 0.22);
  const barW = (groupW - groupPad) / series.length;
  const zeroFrac = axis.log ? 0 : axisFrac(axis, 0);
  const zeroY = plot.bottom - zeroFrac * plot.h;

  const parts: string[] = [];
  if (hasLegend) parts.push(renderLegendRow(width, spec.title ? 48 : 24, legendNames));
  parts.push(renderYAxis(plot, axis, spec.y_label));

  for (let gi = 0; gi < categories.length; gi++) {
    const groupX = plot.left + gi * groupW + groupPad / 2;
    for (let si = 0; si < series.length; si++) {
      const value = series[si].values[gi] ?? 0;
      if (!Number.isFinite(value)) continue;
      const y = plot.bottom - axisFrac(axis, value) * plot.h;
      const top = Math.min(y, zeroY);
      const h = Math.abs(y - zeroY);
      const x = groupX + si * barW;
      const color = PALETTE[si % PALETTE.length];
      parts.push(`<rect x="${round(x)}" y="${round(top)}" width="${round(Math.max(1, barW - 2))}" height="${round(h)}" fill="${color}" rx="2"/>`);
    }
    const labelX = groupX + (groupW - groupPad) / 2;
    if (rotate) {
      parts.push(`<text x="${round(labelX)}" y="${round(plot.bottom + 16)}" text-anchor="end" font-size="${TICK_SIZE}" fill="#4b5563" transform="rotate(-30 ${round(labelX)} ${round(plot.bottom + 16)})">${escapeXml(categories[gi])}</text>`);
    } else {
      parts.push(`<text x="${round(labelX)}" y="${round(plot.bottom + 18)}" text-anchor="middle" font-size="${TICK_SIZE}" fill="#4b5563">${escapeXml(categories[gi])}</text>`);
    }
  }

  parts.push(renderPlotFrame(plot));
  if (spec.x_label) parts.push(renderXAxisTitle(plot, height, spec.x_label));
  return parts.join("\n");
}

function renderLine(
  spec: Extract<RenderChartArgs, { type: "line" }>,
  width: number,
  height: number,
  useLog: boolean,
  legendRows: number,
): string {
  const { series } = spec.data;
  const allPoints = series.flatMap((item) => item.points);
  if (!allPoints.length) return renderNoData(width, height);

  const hasLegend = series.length > 1;
  const xsNumeric = allPoints.every((point) => typeof point.x === "number");
  let xMin = 0;
  let xMax = 1;
  let categories: string[] | undefined;
  if (xsNumeric) {
    xMin = Math.min(...allPoints.map((point) => point.x as number));
    xMax = Math.max(...allPoints.map((point) => point.x as number));
    if (xMin === xMax) xMax = xMin + 1;
  } else {
    const seen = new Map<string, number>();
    for (const point of allPoints) {
      const key = String(point.x);
      if (!seen.has(key)) seen.set(key, seen.size);
    }
    categories = [...seen.keys()];
    xMax = Math.max(1, categories.length - 1);
  }

  const plot = computePlot(width, height, Boolean(spec.title), legendRows, true, false, Boolean(spec.y_label), Boolean(spec.x_label));
  const yValues = allPoints.map((point) => point.y).filter(Number.isFinite);
  const axis = yAxis(yValues, useLog);
  const xToPx = (x: number | string) => {
    const xv = xsNumeric ? (x as number) : categories!.indexOf(String(x));
    return plot.left + ((xv - xMin) / (xMax - xMin)) * plot.w;
  };
  const yToPx = (y: number) => plot.bottom - axisFrac(axis, y) * plot.h;
  const formatX = (x: number | string): string => {
    if (!xsNumeric) return String(x);
    const t = x as number;
    if (t > 1e9) {
      const d = new Date(t * 1000);
      return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    }
    return fmtNumber(t);
  };

  const parts: string[] = [];
  if (hasLegend) parts.push(renderLegendRow(width, spec.title ? 48 : 24, series.map((item) => item.name), renderLineLegendSwatch));
  parts.push(renderYAxis(plot, axis, spec.y_label));

  const xTickCount = Math.min(8, xsNumeric ? 6 : Math.max(2, categories!.length));
  for (let i = 0; i < xTickCount; i++) {
    const tick = xMin + ((xMax - xMin) * i) / (xTickCount - 1);
    const x = plot.left + ((tick - xMin) / (xMax - xMin)) * plot.w;
    const label = xsNumeric ? formatX(tick) : (categories![Math.round(tick)] ?? "");
    parts.push(`<line x1="${round(x)}" y1="${round(plot.top)}" x2="${round(x)}" y2="${round(plot.bottom)}" stroke-width="1" stroke="#e5e7eb"/>`);
    parts.push(`<line x1="${round(x)}" y1="${round(plot.bottom)}" x2="${round(x)}" y2="${round(plot.bottom + 4)}" stroke="#9ca3af" stroke-width="1"/>`);
    parts.push(`<text x="${round(x)}" y="${round(plot.bottom + 18)}" text-anchor="middle" font-size="${TICK_SIZE}" fill="#4b5563">${escapeXml(label)}</text>`);
  }

  for (const [seriesIndex, item] of series.entries()) {
    const color = PALETTE[seriesIndex % PALETTE.length];
    const points = item.points
      .filter((point) => Number.isFinite(point.y))
      .slice()
      .sort((a, b) => xToPx(a.x) - xToPx(b.x));
    if (!points.length) continue;
    const path = points
      .map((point, i) => `${i === 0 ? "M" : "L"} ${round(xToPx(point.x))} ${round(yToPx(point.y))}`)
      .join(" ");
    const dash = seriesDash(seriesIndex);
    parts.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ""} stroke-linejoin="round" stroke-linecap="round"/>`);
    if (points.length <= 80) {
      for (const point of points) {
        parts.push(renderMarker(seriesShape(seriesIndex), xToPx(point.x), yToPx(point.y), 2.8, color));
      }
    }
  }

  parts.push(renderPlotFrame(plot));
  if (spec.x_label) parts.push(renderXAxisTitle(plot, height, spec.x_label));
  return parts.join("\n");
}

function renderYAxis(plot: Plot, axis: Axis, label: string | undefined): string {
  const parts: string[] = [];
  for (const tick of axis.ticks) {
    const y = plot.bottom - axisFrac(axis, tick) * plot.h;
    parts.push(`<line x1="${round(plot.left)}" y1="${round(y)}" x2="${round(plot.right)}" y2="${round(y)}" stroke-width="1" stroke="#e5e7eb"/>`);
    parts.push(`<text x="${round(plot.left - 8)}" y="${round(y + 4)}" text-anchor="end" font-size="${TICK_SIZE}" fill="#4b5563">${escapeXml(fmtNumber(tick))}</text>`);
  }
  if (label) {
    const cy = plot.top + plot.h / 2;
    const text = axis.log ? `${label} (log)` : label;
    parts.push(`<text x="18" y="${round(cy)}" text-anchor="middle" font-size="${AXIS_LABEL_SIZE}" fill="#374151" transform="rotate(-90 18 ${round(cy)})">${escapeXml(text)}</text>`);
  }
  return parts.join("\n");
}

function renderPlotFrame(plot: Plot): string {
  return `<rect x="${round(plot.left)}" y="${round(plot.top)}" width="${round(plot.w)}" height="${round(plot.h)}" fill="none" stroke-width="1" stroke="#9ca3af"/>`;
}

function renderXAxisTitle(plot: Plot, height: number, label: string): string {
  return `<text x="${round((plot.left + plot.right) / 2)}" y="${height - 10}" text-anchor="middle" font-size="${AXIS_LABEL_SIZE}" fill="#374151">${escapeXml(label)}</text>`;
}

function renderLegendRow(
  width: number,
  y: number,
  names: string[],
  swatch?: (index: number, cx: number, cy: number) => string,
): string {
  const rows = layoutLegendRows(names, width);
  const parts: string[] = [];
  let index = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const widths = row.map((name) => LEGEND_SWATCH + LEGEND_GAP + approxTextWidth(name, LEGEND_SIZE));
    const totalW = widths.reduce((sum, value) => sum + value, 0) + (row.length - 1) * LEGEND_BETWEEN;
    let x = Math.max(LEGEND_MARGIN, (width - totalW) / 2);
    const rowY = y + rowIndex * LEGEND_LINE_H;
    for (let i = 0; i < row.length; i++) {
      const color = PALETTE[index % PALETTE.length];
      const cx = x + LEGEND_SWATCH / 2;
      const cy = rowY - LEGEND_SWATCH / 2 + 2;
      parts.push(swatch
        ? swatch(index, cx, cy)
        : `<rect x="${round(x)}" y="${round(rowY - LEGEND_SWATCH + 2)}" width="${LEGEND_SWATCH}" height="${LEGEND_SWATCH}" fill="${color}" rx="2"/>`);
      parts.push(`<text x="${round(x + LEGEND_SWATCH + LEGEND_GAP)}" y="${round(rowY + 2)}" font-size="${LEGEND_SIZE}" fill="#374151">${escapeXml(row[i])}</text>`);
      x += widths[i] + LEGEND_BETWEEN;
      index++;
    }
  }
  return parts.join("\n");
}

function renderLineLegendSwatch(index: number, cx: number, cy: number): string {
  const color = PALETTE[index % PALETTE.length];
  const dash = seriesDash(index);
  return [
    `<line x1="${round(cx - 7)}" y1="${round(cy)}" x2="${round(cx + 7)}" y2="${round(cy)}" stroke="${color}" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ""} stroke-linecap="round"/>`,
    renderMarker(seriesShape(index), cx, cy, 2.6, color),
  ].join("\n");
}

function renderMarker(shape: MarkerShapeKind, cx: number, cy: number, size: number, color: string): string {
  if (shape === "square") {
    return `<rect x="${round(cx - size)}" y="${round(cy - size)}" width="${round(size * 2)}" height="${round(size * 2)}" fill="${color}"/>`;
  }
  if (shape === "triangle") {
    return `<path d="M ${round(cx)} ${round(cy - size * 1.2)} L ${round(cx + size * 1.05)} ${round(cy + size * 0.85)} L ${round(cx - size * 1.05)} ${round(cy + size * 0.85)} Z" fill="${color}"/>`;
  }
  if (shape === "diamond") {
    return `<path d="M ${round(cx)} ${round(cy - size * 1.3)} L ${round(cx + size * 1.15)} ${round(cy)} L ${round(cx)} ${round(cy + size * 1.3)} L ${round(cx - size * 1.15)} ${round(cy)} Z" fill="${color}"/>`;
  }
  return `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(size)}" fill="${color}"/>`;
}

function renderNoData(width: number, height: number): string {
  return `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="14" fill="#4b5563">no data</text>`;
}

function svgShell(width: number, height: number, title: string | undefined, description: string, body: string): string {
  return `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeXml(title || "chart")}" font-family="ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <title>${escapeXml(title || "chart")}</title>
  <desc>${escapeXml(description)}</desc>
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  ${title ? `<text x="${width / 2}" y="22" text-anchor="middle" font-size="${TITLE_SIZE}" font-weight="600" fill="#1f2937">${escapeXml(ellipsizeText(title, width - 32, TITLE_SIZE))}</text>` : ""}
  ${body}
</svg>`;
}

function chartCanvasSize(spec: RenderChartArgs, measuredW: number | null): { width: number; height: number; legendRows: number } {
  const def = defaultSize(spec.type);
  const specWidth = spec.width ?? def.width;
  const specHeight = spec.height ?? def.height;
  const width = measuredW ? Math.round(Math.min(Math.max(measuredW, 300), specWidth)) : specWidth;
  const legendRows = legendRowsFor(spec, width);
  let height = specHeight + Math.max(0, legendRows - 1) * LEGEND_LINE_H;
  if (spec.type === "bar") {
    const { tickBandH } = barTickLayout(spec.data.categories, width, { hasYAxisLabel: Boolean(spec.y_label) });
    height += Math.max(0, tickBandH - BAR_TICK_BASE_H);
  }
  return { width, height, legendRows };
}

function defaultSize(type: RenderChartArgs["type"]): { width: number; height: number } {
  if (type === "pie") return { width: 760, height: 480 };
  return { width: 900, height: 520 };
}

function legendRowsFor(spec: RenderChartArgs, width: number): number {
  if (spec.type !== "bar" && spec.type !== "line") return 0;
  const names = spec.data.series.map((item) => item.name);
  return names.length > 1 ? layoutLegendRows(names, width).length : 0;
}

function computePlot(
  width: number,
  height: number,
  hasTitle: boolean,
  legendRows: number,
  hasXLabels: boolean,
  rotateXTicks: boolean,
  hasYAxisLabel: boolean,
  hasXAxisLabel: boolean,
  rotatedTickH = 50,
  xTickSidePadding: { left?: number; right?: number } = {},
): Plot {
  const titleH = hasTitle ? 30 : 6;
  const legendH = legendRows > 0 ? legendRows * LEGEND_LINE_H + 6 : 0;
  const xTickH = hasXLabels ? (rotateXTicks ? rotatedTickH : 26) : 8;
  const xLabelH = hasXAxisLabel ? 22 : 0;
  const yLabelW = hasYAxisLabel ? 22 : 0;
  const top = titleH + legendH + 8;
  const bottom = height - xTickH - xLabelH - 8;
  const left = 60 + yLabelW + Math.max(0, xTickSidePadding.left ?? 0);
  const right = width - 24 - Math.max(0, xTickSidePadding.right ?? 0);
  return { left, right, top, bottom, w: right - left, h: bottom - top };
}

function barTickLayout(
  categories: string[],
  width: number,
  opts: { hasYAxisLabel?: boolean } = {},
): { rotate: boolean; tickBandH: number; sidePaddingLeft: number; sidePaddingRight: number } {
  const longest = categories.reduce((max, category) => Math.max(max, approxTextWidth(category, TICK_SIZE)), 0);
  const approxGroupW = categories.length ? (width - 80) / categories.length : width;
  const rotate = longest + 4 > approxGroupW;
  if (!rotate) return { rotate: false, tickBandH: 26, sidePaddingLeft: 0, sidePaddingRight: 0 };

  const angle = (BAR_TICK_ROTATE_DEG * Math.PI) / 180;
  const verticalOverhang = longest * Math.sin(angle);
  const first = categories[0] ?? "";
  const firstW = approxTextWidth(first, TICK_SIZE);
  const baseLeft = 60 + (opts.hasYAxisLabel ? 22 : 0);
  const baseRight = width - 24;
  const count = Math.max(1, categories.length);
  const basePlotW = Math.max(1, baseRight - baseLeft);
  const firstAnchor = baseLeft + basePlotW / count / 2;
  const deficit = firstW * Math.cos(angle) + 8 - firstAnchor;
  const denom = 1 - 1 / (2 * count);
  const maxSidePadding = Math.max(0, width * 0.28);
  const sidePaddingLeft = Math.min(maxSidePadding, Math.max(0, Math.ceil(deficit / denom)));

  return {
    rotate: true,
    tickBandH: Math.ceil(BAR_TICK_GAP + verticalOverhang + 8),
    sidePaddingLeft,
    sidePaddingRight: 0,
  };
}

function layoutLegendRows(names: string[], width: number): string[][] {
  const maxW = width - LEGEND_MARGIN * 2;
  const itemW = (name: string) => LEGEND_SWATCH + LEGEND_GAP + approxTextWidth(name, LEGEND_SIZE);
  const rows: string[][] = [];
  let current: string[] = [];
  let currentW = 0;
  for (const name of names) {
    const w = itemW(name);
    const add = current.length ? LEGEND_BETWEEN + w : w;
    if (current.length && currentW + add > maxW) {
      rows.push(current);
      current = [];
      currentW = 0;
    }
    current.push(name);
    currentW += current.length === 1 ? w : LEGEND_BETWEEN + w;
  }
  if (current.length) rows.push(current);
  return rows;
}

function yAxis(values: number[], useLog: boolean): Axis {
  if (useLog) {
    const positives = values.filter((value) => value > 0);
    return positives.length ? logAxis(Math.min(...positives), Math.max(...positives)) : niceAxis(0, 1);
  }

  let dataMin = 0;
  let dataMax = 0;
  for (const value of values) {
    if (value < dataMin) dataMin = value;
    if (value > dataMax) dataMax = value;
  }
  if (dataMax === 0 && dataMin === 0) dataMax = 1;
  return niceAxis(dataMin, dataMax);
}

function niceAxis(min: number, max: number, count = 5): Axis {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 0.5, 1] };
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  const range = niceNum(max - min, false);
  const step = niceNum(range / (count - 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = niceMin; value <= niceMax + step / 2; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return { min: niceMin, max: niceMax, ticks };
}

function niceNum(range: number, roundValue: boolean): number {
  const exp = Math.floor(Math.log10(range || 1));
  const frac = range / Math.pow(10, exp);
  let niceFrac: number;
  if (roundValue) {
    if (frac < 1.5) niceFrac = 1;
    else if (frac < 3) niceFrac = 2;
    else if (frac < 7) niceFrac = 5;
    else niceFrac = 10;
  } else if (frac <= 1) niceFrac = 1;
  else if (frac <= 2) niceFrac = 2;
  else if (frac <= 5) niceFrac = 5;
  else niceFrac = 10;
  return niceFrac * Math.pow(10, exp);
}

function logAxis(dataMin: number, dataMax: number): Axis {
  const loExp = Math.floor(Math.log10(dataMin));
  const hiExp = Math.max(Math.ceil(Math.log10(dataMax)), loExp + 1);
  const ticks: number[] = [];
  for (let exp = loExp; exp <= hiExp + 1e-9; exp++) ticks.push(Math.pow(10, exp));
  return { min: Math.pow(10, loExp), max: Math.pow(10, hiExp), ticks, log: true };
}

function axisFrac(axis: Axis, value: number): number {
  if (axis.log) {
    const min = Math.log10(axis.min);
    const max = Math.log10(axis.max);
    const current = Math.log10(Math.max(value, axis.min));
    return max > min ? (current - min) / (max - min) : 0;
  }
  return axis.max > axis.min ? (value - axis.min) / (axis.max - axis.min) : 0;
}

function effectiveLog(spec: RenderChartArgs): boolean {
  if (spec.type !== "bar" && spec.type !== "line") return false;
  const values = spec.type === "bar"
    ? spec.data.series.flatMap((item) => item.values)
    : spec.data.series.flatMap((item) => item.points.map((point) => point.y));
  const finite = values.filter(Number.isFinite);
  const positives = finite.filter((value) => value > 0);
  return positives.length >= 2 && positives.length === finite.length && Math.max(...positives) / Math.min(...positives) >= 50;
}

function collapsePieSlices(slices: PieSlice[], max = PIE_MAX_SLICES): { slices: PieSlice[]; othersIndex: number } {
  if (slices.length <= max) return { slices, othersIndex: -1 };
  const sorted = [...slices].sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, max - 1);
  const tail = sorted.slice(max - 1);
  const tailTotal = tail.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  return {
    slices: [...head, { label: `Others (${tail.length})`, value: tailTotal }],
    othersIndex: head.length,
  };
}

function pieSliceColor(index: number, othersIndex: number): string {
  return index === othersIndex ? OTHERS_COLOR : PALETTE[index % PALETTE.length];
}

function approxTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) {
    if (/[\u4e00-\u9fff\uff00-\uffef]/.test(char)) width += fontSize;
    else if (/[A-Z0-9]/.test(char)) width += fontSize * 0.62;
    else width += fontSize * 0.52;
  }
  return width;
}

function ellipsizeText(text: string, maxW: number, fontSize: number): string {
  if (approxTextWidth(text, fontSize) <= maxW) return text;
  let shown = text;
  while (shown.length > 1 && approxTextWidth(`${shown}…`, fontSize) > maxW) {
    shown = shown.slice(0, -1);
  }
  return `${shown.replace(/\s+$/, "")}…`;
}

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-4) return n.toExponential(1).replace("e+", "e");
  if (abs >= 1e6) {
    for (const [unit, divisor] of [["T", 1e12], ["G", 1e9], ["M", 1e6]] as const) {
      if (abs >= divisor) {
        const value = n / divisor;
        return (Number.isInteger(value) ? String(value) : value.toFixed(1)) + unit;
      }
    }
  }
  if (abs >= 1000) return Math.round(n).toLocaleString("en-US");
  if (Number.isInteger(n)) return String(n);
  if (abs >= 1) return String(Number(n.toFixed(2)));
  return String(Number(n.toPrecision(2)));
}

function describeChart(spec: RenderChartArgs): string {
  if (spec.type === "pie") return `Pie chart with ${spec.data.slices.length} segment(s).`;
  if (spec.type === "bar") return `Bar chart with ${spec.data.categories.length} categories and ${spec.data.series.length} series.`;
  return `Line chart with ${spec.data.series.length} series.`;
}

function seriesDash(index: number): string {
  return LINE_DASHES[index % LINE_DASHES.length];
}

function seriesShape(index: number): MarkerShapeKind {
  return MARKER_SHAPES[index % MARKER_SHAPES.length];
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
