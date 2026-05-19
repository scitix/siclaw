/**
 * Client-side chart renderer (React + SVG).
 *
 * Receives a JSON spec (emitted by mcp `render_chart` tool) and draws
 * pie/bar/line charts as inline SVG via JSX. Colors use CSS classes so the
 * outer wrapper's Tailwind `dark:` variants drive light/dark theme — no
 * re-render needed when the user toggles themes.
 *
 * The hover toolbar rasterises the live SVG to PNG client-side so users can
 * copy a real image to the clipboard or download a PNG file (shareable on
 * WeChat / QQ / etc.) — copying the bubble text would only yield the JSON spec.
 *
 * Interactivity (hover tooltip + crosshair, responsive resize, log-scale
 * toggle) is layered on top of the static SVG: the tooltip and crosshair are
 * rendered as a SEPARATE overlay (HTML div + a second pointer-events-none SVG)
 * so they never end up in the rasterised PNG, which clones only `svgRef`.
 *
 * All DOM-free logic (the ChartSpec contract, number/axis math, legend layout,
 * plot geometry, canvas sizing, the spec parser) lives in `chart-utils.ts` and
 * is unit-tested there. This file is JSX + browser APIs only.
 */

import {
  type CSSProperties,
  type ReactNode,
  memo,
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
} from "react"
import { Maximize2, X } from "lucide-react"
import {
  type ChartSpec,
  type Axis,
  type Plot,
  type MarkerShapeKind,
  PALETTE,
  TITLE_SIZE,
  LEGEND_SIZE,
  LEGEND_LINE_H,
  AXIS_LABEL_SIZE,
  TICK_SIZE,
  PIE_LABEL_SIZE,
  LEGEND_SWATCH,
  LEGEND_GAP,
  LEGEND_BETWEEN,
  LEGEND_MARGIN,
  seriesDash,
  seriesShape,
  barTickLayout,
  collapsePieSlices,
  pieSliceColor,
  approxTextWidth,
  fmtNumber,
  niceAxis,
  logAxis,
  axisFrac,
  logPossible,
  logBeneficial,
  collectChartValues,
  layoutLegendRows,
  computePlot,
  describeChart,
  chartCanvasSize,
} from "./chart-utils"

// Re-exported so existing import sites (Markdown.tsx, PilotArea.tsx, the test
// file) can keep importing from "./ChartRenderer" — keeps the refactor's blast
// radius to this file pair.
export { collapsePieSlices, tryParseChartSpec, chartSpecLooksIncomplete } from "./chart-utils"
export type { ChartSpec } from "./chart-utils"

function MarkerShape({
  shape, cx, cy, size, color,
}: { shape: MarkerShapeKind; cx: number; cy: number; size: number; color: string }) {
  if (shape === "square") {
    return <rect x={cx - size} y={cy - size} width={size * 2} height={size * 2} fill={color} />
  }
  if (shape === "triangle") {
    return (
      <path d={`M ${cx} ${cy - size * 1.2} L ${cx + size * 1.05} ${cy + size * 0.85} L ${cx - size * 1.05} ${cy + size * 0.85} Z`}
            fill={color} />
    )
  }
  if (shape === "diamond") {
    return (
      <path d={`M ${cx} ${cy - size * 1.3} L ${cx + size * 1.15} ${cy} L ${cx} ${cy + size * 1.3} L ${cx - size * 1.15} ${cy} Z`}
            fill={color} />
    )
  }
  return <circle cx={cx} cy={cy} r={size} fill={color} />
}

// Tailwind class strings centralised so palette tweaks live in one place.
// dark: variants flip every theme-bound color when an ancestor has `.dark`.
const THEME_CLASSES = [
  // SVG background (the surrounding `<rect>` filling viewBox)
  "[&_.chart-bg]:fill-white",
  "dark:[&_.chart-bg]:fill-slate-900",
  // Title text
  "[&_.chart-title]:fill-gray-800",
  "dark:[&_.chart-title]:fill-gray-100",
  // Axis tick / category labels
  "[&_.chart-tick]:fill-gray-600",
  "dark:[&_.chart-tick]:fill-gray-300",
  // Axis title (x_label / y_label)
  "[&_.chart-axis-label]:fill-gray-700",
  "dark:[&_.chart-axis-label]:fill-gray-200",
  // Legend text
  "[&_.chart-legend]:fill-gray-700",
  "dark:[&_.chart-legend]:fill-gray-200",
  // Axis lines
  "[&_.chart-axis-line]:stroke-gray-400",
  "dark:[&_.chart-axis-line]:stroke-gray-500",
  // Gridlines
  "[&_.chart-grid]:stroke-gray-200",
  "dark:[&_.chart-grid]:stroke-gray-700/60",
  // Pie slice separators (white in light, slate in dark to match bg)
  "[&_.chart-slice-sep]:stroke-white",
  "dark:[&_.chart-slice-sep]:stroke-slate-900",
].join(" ")

function Title({ text, width }: { text?: string; width: number }) {
  if (!text) return null
  // Truncate with an ellipsis when the title is wider than the canvas — a long
  // title used to spill past both edges at narrow widths.
  const maxW = width - 32
  let shown = text
  if (approxTextWidth(shown, TITLE_SIZE) > maxW) {
    while (shown.length > 1 && approxTextWidth(shown + "…", TITLE_SIZE) > maxW) {
      shown = shown.slice(0, -1)
    }
    shown = shown.replace(/\s+$/, "") + "…"
  }
  return (
    <text x={width / 2} y={22} textAnchor="middle" fontSize={TITLE_SIZE} fontWeight={600}
          className="chart-title">{shown}</text>
  )
}

function ellipsizeText(text: string, maxW: number, fontSize: number): string {
  if (approxTextWidth(text, fontSize) <= maxW) return text
  let shown = text
  while (shown.length > 1 && approxTextWidth(`${shown}…`, fontSize) > maxW) {
    shown = shown.slice(0, -1)
  }
  return `${shown.replace(/\s+$/, "")}…`
}

// Renders the legend, wrapping to multiple centred rows when the series don't
// fit on one line. `y` is the baseline of the first row; callers must reserve
// `layoutLegendRows(...).length` rows of vertical space via computePlot. When
// `swatch` is supplied it draws the per-series marker (used by line charts to
// echo the dash + point shape); otherwise a plain colour rect is drawn.
function LegendRow({
  width, y, names, swatch,
}: {
  width: number
  y: number
  names: string[]
  swatch?: (index: number, cx: number, cy: number) => ReactNode
}) {
  const rows = layoutLegendRows(names, width)
  const out: ReactNode[] = []
  let idx = 0
  rows.forEach((row, ri) => {
    const widths = row.map((n) => LEGEND_SWATCH + LEGEND_GAP + approxTextWidth(n, LEGEND_SIZE))
    const totalW = widths.reduce((a, b) => a + b, 0) + (row.length - 1) * LEGEND_BETWEEN
    let x = Math.max(LEGEND_MARGIN, (width - totalW) / 2)
    const rowY = y + ri * LEGEND_LINE_H
    row.forEach((n, i) => {
      const color = PALETTE[idx % PALETTE.length]
      const swCx = x + LEGEND_SWATCH / 2
      const swCy = rowY - LEGEND_SWATCH / 2 + 2
      out.push(
        swatch
          ? <g key={`s${idx}`}>{swatch(idx, swCx, swCy)}</g>
          : <rect key={`s${idx}`} x={x} y={rowY - LEGEND_SWATCH + 2} width={LEGEND_SWATCH}
                  height={LEGEND_SWATCH} fill={color} rx={2} />,
        <text key={`t${idx}`} x={x + LEGEND_SWATCH + LEGEND_GAP} y={rowY + 2}
              fontSize={LEGEND_SIZE} className="chart-legend">{n}</text>,
      )
      x += widths[i] + LEGEND_BETWEEN
      idx++
    })
  })
  return <>{out}</>
}

function lineLegendSwatch(index: number, cx: number, cy: number): ReactNode {
  const color = PALETTE[index % PALETTE.length]
  return (
    <>
      <line x1={cx - 7} y1={cy} x2={cx + 7} y2={cy} stroke={color} strokeWidth={2}
            strokeDasharray={seriesDash(index) || undefined} strokeLinecap="round" />
      <MarkerShape shape={seriesShape(index)} cx={cx} cy={cy} size={2.6} color={color} />
    </>
  )
}

function YAxis({ plot, axis, label }: { plot: Plot; axis: Axis; label?: string }) {
  const out: ReactNode[] = []
  axis.ticks.forEach((t, i) => {
    const y = plot.bottom - axisFrac(axis, t) * plot.h
    out.push(
      <line key={`g${i}`} x1={plot.left} y1={y} x2={plot.right} y2={y}
            strokeWidth={1} className="chart-grid" />,
      <text key={`y${i}`} x={plot.left - 8} y={y + 4} textAnchor="end" fontSize={TICK_SIZE}
            className="chart-tick">{fmtNumber(t)}</text>,
    )
  })
  if (label) {
    const cy = plot.top + plot.h / 2
    const text = axis.log ? `${label} (log)` : label
    out.push(
      <text key="yl" x={18} y={cy} textAnchor="middle" fontSize={AXIS_LABEL_SIZE}
            transform={`rotate(-90 18 ${cy})`} className="chart-axis-label">{text}</text>,
    )
  }
  return <>{out}</>
}

// A fully-closed rectangular border around the plot area — the scientific
// plotting convention (Origin / MATLAB) — instead of just left + bottom axes.
function PlotFrame({ plot }: { plot: Plot }) {
  return (
    <rect x={plot.left} y={plot.top} width={plot.w} height={plot.h}
          fill="none" strokeWidth={1} className="chart-axis-line" />
  )
}

function XAxisTitle({ plot, height, label }: { plot: Plot; height: number; label?: string }) {
  if (!label) return null
  return (
    <text x={(plot.left + plot.right) / 2} y={height - 10} textAnchor="middle"
          fontSize={AXIS_LABEL_SIZE} className="chart-axis-label">{label}</text>
  )
}

function NoData({ width, height }: { width: number; height: number }) {
  return (
    <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={14}
          className="chart-tick">no data</text>
  )
}

// ---- Hover model -----------------------------------------------------------
// Each chart renderer returns the drawn SVG plus a hover model the overlay
// uses to snap a crosshair / tooltip to the data without re-deriving geometry.

interface HoverRow { name: string; color: string; valueLabel: string; yPx?: number }
interface HoverColumn { xPx: number; xLabel: string; rows: HoverRow[] }
interface PieHoverSlice {
  start: number // radians, 0 = top, clockwise
  end: number
  label: string
  valueLabel: string
  pct: string
  color: string
}
type HoverModel =
  | { kind: "columns"; plotTop: number; plotBottom: number; columns: HoverColumn[] }
  | { kind: "pie"; cx: number; cy: number; r: number; slices: PieHoverSlice[] }
  | null

interface ChartRender { els: ReactNode; hover: HoverModel }

function renderPie(
  spec: Extract<ChartSpec, { type: "pie" }>, width: number, height: number,
): ChartRender {
  const { slices, othersIndex } = collapsePieSlices(spec.data.slices)
  const total = slices.reduce((a, s) => a + Math.max(0, s.value), 0)
  if (total <= 0) return { els: <NoData width={width} height={height} />, hover: null }

  const titleH = spec.title ? 30 : 6
  const padY = 16
  const top = titleH + padY
  const bottom = height - padY
  const innerH = bottom - top
  const labels = slices.map((s) => {
    const suffix = ` (${fmtNumber(s.value)}, ${((s.value / total) * 100).toFixed(1)}%)`
    return { name: s.label, suffix, full: `${s.label}${suffix}` }
  })
  const legendW = Math.min(
    Math.max(...labels.map((l) => approxTextWidth(l.full, LEGEND_SIZE))) + 28,
    width * 0.42,
  )
  const pieAreaW = width - legendW - 32
  const cx = 16 + pieAreaW / 2
  const cy = top + innerH / 2
  const r = Math.max(60, Math.min(pieAreaW / 2 - 12, innerH / 2 - 8))

  const slicesEls: ReactNode[] = []
  const hoverSlices: PieHoverSlice[] = []
  let angle = -Math.PI / 2
  let acc = 0
  slices.forEach((s, i) => {
    const v = Math.max(0, s.value)
    if (v === 0) return
    const sweep = (v / total) * Math.PI * 2
    const a2 = angle + sweep
    const x1 = cx + r * Math.cos(angle)
    const y1 = cy + r * Math.sin(angle)
    const x2 = cx + r * Math.cos(a2)
    const y2 = cy + r * Math.sin(a2)
    const large = sweep > Math.PI ? 1 : 0
    const color = pieSliceColor(i, othersIndex)
    if (slices.length === 1 || sweep >= Math.PI * 2 - 1e-6) {
      slicesEls.push(<circle key={`p${i}`} cx={cx} cy={cy} r={r} fill={color} />)
    } else {
      slicesEls.push(
        <path key={`p${i}`}
              d={`M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`}
              fill={color} strokeWidth={1.5} className="chart-slice-sep" />,
      )
    }
    if (sweep > 0.18) {
      const mid = angle + sweep / 2
      const lx = cx + r * 0.62 * Math.cos(mid)
      const ly = cy + r * 0.62 * Math.sin(mid)
      slicesEls.push(
        <text key={`l${i}`} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
              fontSize={PIE_LABEL_SIZE} fontWeight={600} fill="#fff">
          {((v / total) * 100).toFixed(1)}%
        </text>,
      )
    }
    hoverSlices.push({
      start: acc,
      end: acc + sweep,
      label: s.label,
      valueLabel: fmtNumber(s.value),
      pct: `${((v / total) * 100).toFixed(1)}%`,
      color,
    })
    acc += sweep
    angle = a2
  })

  // Legend column on the right.
  const legX = width - legendW - 8
  const lineH = LEGEND_SIZE + 10
  const legBlockH = labels.length * lineH
  let legY = Math.max(top + 8, top + (innerH - legBlockH) / 2 + LEGEND_SIZE)
  const legendEls: ReactNode[] = []
  const legendTextW = Math.max(24, legendW - 30)
  labels.forEach((label, i) => {
    const color = pieSliceColor(i, othersIndex)
    const suffixW = approxTextWidth(label.suffix, LEGEND_SIZE)
    const nameW = Math.max(24, legendTextW - suffixW)
    const shown = approxTextWidth(label.full, LEGEND_SIZE) > legendTextW
      ? `${ellipsizeText(label.name, nameW, LEGEND_SIZE)}${label.suffix}`
      : label.full
    legendEls.push(
      <rect key={`ls${i}`} x={legX} y={legY - LEGEND_SIZE + 2} width={14} height={14}
            fill={color} rx={2} />,
      <text key={`lt${i}`} x={legX + 22} y={legY + 2} fontSize={LEGEND_SIZE}
            className="chart-legend">
        <title>{label.full}</title>
        {shown}
      </text>,
    )
    legY += lineH
  })

  return {
    els: <>{slicesEls}{legendEls}</>,
    hover: { kind: "pie", cx, cy, r, slices: hoverSlices },
  }
}

function renderBar(
  spec: Extract<ChartSpec, { type: "bar" }>,
  width: number, height: number, useLog: boolean, legendRows: number,
): ChartRender {
  const { categories, series } = spec.data
  if (!categories.length || !series.length) {
    return { els: <NoData width={width} height={height} />, hover: null }
  }
  const hasLegend = series.length > 1
  const legendNames = series.map((s) => s.name)
  const { rotate, tickBandH, sidePaddingLeft, sidePaddingRight } = barTickLayout(
    categories,
    width,
    { hasYAxisLabel: !!spec.y_label },
  )
  const plot = computePlot(
    width, height, !!spec.title, legendRows, true, rotate,
    !!spec.y_label, !!spec.x_label, tickBandH,
    { left: sidePaddingLeft, right: sidePaddingRight },
  )

  const finiteVals: number[] = []
  series.forEach((s) => s.values.forEach((v) => { if (Number.isFinite(v)) finiteVals.push(v) }))

  let axis: Axis
  if (useLog) {
    const pos = finiteVals.filter((v) => v > 0)
    axis = pos.length ? logAxis(Math.min(...pos), Math.max(...pos)) : niceAxis(0, 1)
  } else {
    let dataMin = 0, dataMax = 0
    finiteVals.forEach((v) => { if (v < dataMin) dataMin = v; if (v > dataMax) dataMax = v })
    if (dataMax === 0 && dataMin === 0) dataMax = 1
    axis = niceAxis(dataMin, dataMax)
  }
  const groupW = plot.w / categories.length
  const groupPad = Math.min(20, groupW * 0.22)
  const barW = (groupW - groupPad) / series.length
  const zeroFrac = axis.log ? 0 : axisFrac(axis, 0)
  const zeroY = plot.bottom - zeroFrac * plot.h

  const els: ReactNode[] = []
  const columns: HoverColumn[] = []
  categories.forEach((cat, gi) => {
    const gx = plot.left + gi * groupW + groupPad / 2
    const rows: HoverRow[] = []
    series.forEach((s, si) => {
      const v = s.values[gi] ?? 0
      if (!Number.isFinite(v)) return
      const y = plot.bottom - axisFrac(axis, v) * plot.h
      const top = Math.min(y, zeroY)
      const h = Math.abs(y - zeroY)
      const x = gx + si * barW
      const color = PALETTE[si % PALETTE.length]
      els.push(
        <rect key={`b${gi}-${si}`} x={x} y={top} width={Math.max(1, barW - 2)} height={h}
              fill={color} rx={2} />,
      )
      rows.push({ name: s.name, color, valueLabel: fmtNumber(v) })
    })
    const cxLabel = gx + (groupW - groupPad) / 2
    if (rotate) {
      els.push(
        <text key={`x${gi}`} x={cxLabel} y={plot.bottom + 16} textAnchor="end"
              fontSize={TICK_SIZE} className="chart-tick"
              transform={`rotate(-30 ${cxLabel} ${plot.bottom + 16})`}>{cat}</text>,
      )
    } else {
      els.push(
        <text key={`x${gi}`} x={cxLabel} y={plot.bottom + 18} textAnchor="middle"
              fontSize={TICK_SIZE} className="chart-tick">{cat}</text>,
      )
    }
    columns.push({ xPx: plot.left + gi * groupW + groupW / 2, xLabel: cat, rows })
  })

  return {
    els: (
      <>
        {hasLegend && <LegendRow width={width} y={(spec.title ? 30 : 6) + 18} names={legendNames} />}
        <YAxis plot={plot} axis={axis} label={spec.y_label} />
        {els}
        <PlotFrame plot={plot} />
        <XAxisTitle plot={plot} height={height} label={spec.x_label} />
      </>
    ),
    hover: { kind: "columns", plotTop: plot.top, plotBottom: plot.bottom, columns },
  }
}

function renderLine(
  spec: Extract<ChartSpec, { type: "line" }>,
  width: number, height: number, useLog: boolean, legendRows: number,
): ChartRender {
  const { series } = spec.data
  const allPoints = series.flatMap((s) => s.points)
  if (!allPoints.length) return { els: <NoData width={width} height={height} />, hover: null }

  const hasLegend = series.length > 1
  const legendNames = series.map((s) => s.name)

  const xsNumeric = allPoints.every((p) => typeof p.x === "number")
  let xMin = 0, xMax = 1
  let categories: string[] | undefined
  if (xsNumeric) {
    xMin = Math.min(...allPoints.map((p) => p.x as number))
    xMax = Math.max(...allPoints.map((p) => p.x as number))
    if (xMin === xMax) xMax = xMin + 1
  } else {
    const seen = new Map<string, number>()
    allPoints.forEach((p) => { const k = String(p.x); if (!seen.has(k)) seen.set(k, seen.size) })
    categories = Array.from(seen.keys())
    xMin = 0
    xMax = Math.max(1, categories.length - 1)
  }

  const plot = computePlot(width, height, !!spec.title, legendRows, true, false, !!spec.y_label, !!spec.x_label)

  const finiteYs = allPoints.map((p) => p.y).filter((y) => Number.isFinite(y))
  let yAxis: Axis
  if (useLog) {
    const pos = finiteYs.filter((y) => y > 0)
    yAxis = pos.length ? logAxis(Math.min(...pos), Math.max(...pos)) : niceAxis(0, 1)
  } else {
    let yMin = Infinity, yMax = -Infinity
    finiteYs.forEach((y) => { if (y < yMin) yMin = y; if (y > yMax) yMax = y })
    if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1 }
    yAxis = niceAxis(yMin, yMax)
  }

  const xToPx = (x: number | string) => {
    const xv = xsNumeric ? (x as number) : categories!.indexOf(String(x))
    return plot.left + ((xv - xMin) / (xMax - xMin)) * plot.w
  }
  const yToPx = (y: number) => plot.bottom - axisFrac(yAxis, y) * plot.h

  // epoch-seconds heuristic: render large numeric x as UTC HH:MM (UTC is the
  // product-wide default — sample timestamps are stored and shown in UTC).
  const formatX = (x: number | string): string => {
    if (!xsNumeric) return String(x)
    const t = x as number
    if (t > 1e9) {
      const d = new Date(t * 1000)
      return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`
    }
    return fmtNumber(t)
  }

  // X tick labels + a faint vertical gridline at every tick (scientific
  // plotting convention — Origin / MATLAB draw both axes' gridlines).
  const xTickCount = Math.min(8, xsNumeric ? 6 : Math.max(2, categories!.length))
  const xTicks: ReactNode[] = []
  for (let i = 0; i < xTickCount; i++) {
    const t = xMin + ((xMax - xMin) * i) / (xTickCount - 1)
    const px = plot.left + ((t - xMin) / (xMax - xMin)) * plot.w
    const label = xsNumeric ? formatX(t) : (categories![Math.round(t)] ?? "")
    xTicks.push(
      <line key={`xg${i}`} x1={px} y1={plot.top} x2={px} y2={plot.bottom}
            strokeWidth={1} className="chart-grid" />,
      <line key={`xt${i}`} x1={px} y1={plot.bottom} x2={px} y2={plot.bottom + 4}
            className="chart-axis-line" />,
      <text key={`xl${i}`} x={px} y={plot.bottom + 18} textAnchor="middle"
            fontSize={TICK_SIZE} className="chart-tick">{label}</text>,
    )
  }

  // Lines + markers. Points are sorted along the x axis so an unordered spec
  // doesn't draw a zig-zag.
  const lines: ReactNode[] = []
  series.forEach((s, si) => {
    const color = PALETTE[si % PALETTE.length]
    const pts = s.points
      .filter((p) => Number.isFinite(p.y))
      .slice()
      .sort((a, b) => xToPx(a.x) - xToPx(b.x))
    if (!pts.length) return
    const d = pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xToPx(p.x).toFixed(2)} ${yToPx(p.y).toFixed(2)}`)
      .join(" ")
    lines.push(
      <path key={`p${si}`} d={d} fill="none" stroke={color} strokeWidth={2}
            strokeDasharray={seriesDash(si) || undefined}
            strokeLinejoin="round" strokeLinecap="round" />,
    )
    if (pts.length <= 80) {
      const shape = seriesShape(si)
      pts.forEach((p, i) => lines.push(
        <MarkerShape key={`d${si}-${i}`} shape={shape} cx={xToPx(p.x)} cy={yToPx(p.y)}
                     size={2.8} color={color} />,
      ))
    }
  })

  // Hover columns: one per distinct x value, in axis order.
  const columnXs: Array<number | string> = xsNumeric
    ? Array.from(new Set(allPoints.map((p) => p.x as number))).sort((a, b) => a - b)
    : categories!
  const seriesMaps = series.map((s) => {
    const m = new Map<number | string, number>()
    s.points.forEach((p) => { if (Number.isFinite(p.y)) m.set(p.x, p.y) })
    return m
  })
  const columns: HoverColumn[] = columnXs.map((x) => {
    const rows: HoverRow[] = []
    series.forEach((s, si) => {
      const y = seriesMaps[si].get(x)
      if (y == null) return
      rows.push({ name: s.name, color: PALETTE[si % PALETTE.length], valueLabel: fmtNumber(y), yPx: yToPx(y) })
    })
    return { xPx: xToPx(x), xLabel: formatX(x), rows }
  })

  return {
    els: (
      <>
        {hasLegend && (
          <LegendRow width={width} y={(spec.title ? 30 : 6) + 18} names={legendNames}
                     swatch={lineLegendSwatch} />
        )}
        <YAxis plot={plot} axis={yAxis} label={spec.y_label} />
        {xTicks}
        {lines}
        <PlotFrame plot={plot} />
        <XAxisTitle plot={plot} height={height} label={spec.x_label} />
      </>
    ),
    hover: { kind: "columns", plotTop: plot.top, plotBottom: plot.bottom, columns },
  }
}

// CSS properties whose values vary by theme and must be copied from the live
// DOM onto a clone before serialisation — once the SVG leaves the document
// (loaded into an <img>) it no longer sees the parent CSS / Tailwind classes.
const INLINEABLE_PROPS = ["fill", "stroke", "stroke-width", "font-family", "font-size", "font-weight"] as const

function inlineComputedStyles(src: SVGElement, dst: SVGElement) {
  const srcAll = [src, ...Array.from(src.querySelectorAll<SVGElement>("*"))]
  const dstAll = [dst, ...Array.from(dst.querySelectorAll<SVGElement>("*"))]
  for (let i = 0; i < srcAll.length; i++) {
    const cs = window.getComputedStyle(srcAll[i])
    const tgt = dstAll[i]
    for (const prop of INLINEABLE_PROPS) {
      const v = cs.getPropertyValue(prop)
      if (v) tgt.style.setProperty(prop, v)
    }
    // Strip class attrs — colors are now inlined, classes would just bloat the
    // serialised output and require Tailwind in the consumer's context.
    tgt.removeAttribute("class")
  }
}

async function svgToPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const vb = svg.viewBox.baseVal
  const w = vb && vb.width ? vb.width : svg.clientWidth || 900
  const h = vb && vb.height ? vb.height : svg.clientHeight || 520

  // Sample chart-bg's live fill BEFORE cloning — this is the same color the
  // user sees on-screen (light: white, dark: slate-900). Used as the canvas
  // base so if inlineComputedStyles ever fails to carry the bg fill onto the
  // detached clone (CSS var that doesn't resolve out-of-document, future
  // refactor swapping <rect> for CSS background, etc.) we still rasterise on
  // the right base color — light-grey text on white was the worst-case
  // failure mode the previous hardcoded #ffffff fallback would produce.
  const bgRect = svg.querySelector<SVGRectElement>(".chart-bg")
  const liveBg = bgRect ? window.getComputedStyle(bgRect).fill : ""
  const canvasBg = liveBg && liveBg !== "none" && liveBg !== "transparent" ? liveBg : "#ffffff"

  const clone = svg.cloneNode(true) as SVGSVGElement
  inlineComputedStyles(svg, clone)
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
  clone.setAttribute("width", String(w))
  clone.setAttribute("height", String(h))

  const xml = new XMLSerializer().serializeToString(clone)
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml)

  const img = new Image()
  img.crossOrigin = "anonymous"
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error("SVG rasterisation failed"))
    img.src = url
  })

  const canvas = document.createElement("canvas")
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("canvas 2d context unavailable")
  // Match the on-screen theme so anti-aliased edges and any potential inline
  // miss still produce a readable PNG (no light-grey-on-white failure mode).
  ctx.fillStyle = canvasBg
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/png")
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("blob -> data URL failed"))
    reader.readAsDataURL(blob)
  })
}

// Rasterise a live chart SVG to a PNG data URL. Used by the message-level copy
// button (PilotArea) to embed real images in the text/html clipboard payload —
// copying the bubble's markdown alone would only yield the raw chart JSON.
export async function svgChartToPngDataUrl(svg: SVGSVGElement, scale = 2): Promise<string> {
  const blob = await svgToPngBlob(svg, scale)
  return await blobToDataUrl(blob)
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function copyBlobToClipboard(blob: Blob): Promise<boolean> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
    return true
  } catch {
    return false
  }
}

const TOOLBAR_BTN =
  "inline-flex h-7 items-center justify-center rounded-md bg-white/90 dark:bg-slate-800/90 " +
  "text-gray-700 dark:text-gray-100 border border-gray-200 dark:border-slate-700 shadow-sm " +
  "hover:bg-white dark:hover:bg-slate-800"

interface ChartRendererProps {
  spec: ChartSpec
  className?: string
  style?: CSSProperties
  allowPreview?: boolean
}

// Active hover target: which column / pie slice, plus where to place the
// tooltip (px relative to the chart-area wrapper, already edge-clamped).
interface HoverState { index: number; left: number; top: number }

function ChartRendererImpl({ spec, className, style, allowPreview = true }: ChartRendererProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [status, setStatus] = useState<null | { kind: "ok" | "err"; text: string }>(null)
  const [hover, setHover] = useState<HoverState | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)

  // Responsive: render the chart at the container's real width (capped at the
  // spec's ideal width so it never upscales) instead of letting a fixed-size
  // viewBox shrink the whole thing — that shrank the fonts into illegibility
  // inside a narrow chat bubble. Re-rendering at the measured width keeps text
  // at a constant on-screen size.
  const [measuredW, setMeasuredW] = useState<number | null>(null)
  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && w > 0) {
        setMeasuredW(w)
        setHover(null)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Single source of truth for sizing — width, canvas height, and the legend
  // row count that renderBar/renderLine reuse via computePlot. Keeping these
  // three in one pure function is what prevents the plot-collapse regression.
  const { width, height, legendRows } = useMemo(
    () => chartCanvasSize(spec, measuredW),
    [spec, measuredW],
  )

  // Log scale: bar and line charts both expose a linear/log toolbar toggle
  // whenever a log axis is *possible* (all-positive data). In "auto" mode the
  // axis defaults to log only when it's also *beneficial* (wide spread); the
  // toggle then pins linear/log explicitly.
  const chartValues = useMemo(() => collectChartValues(spec), [spec])
  const logAvailable = useMemo(() => logPossible(chartValues), [chartValues])
  const logAutoOn = useMemo(() => logBeneficial(chartValues), [chartValues])
  const [yScalePref, setYScalePref] = useState<"auto" | "linear" | "log">("auto")
  const effectiveLog =
    (spec.type === "bar" || spec.type === "line") &&
    (yScalePref === "log" || (yScalePref === "auto" && logAutoOn))

  const chart = useMemo<ChartRender>(() => {
    if (spec.type === "pie") return renderPie(spec, width, height)
    if (spec.type === "bar") return renderBar(spec, width, height, effectiveLog, legendRows)
    return renderLine(spec, width, height, effectiveLog, legendRows)
  }, [spec, width, height, effectiveLog, legendRows])

  const flash = useCallback((kind: "ok" | "err", text: string) => {
    setStatus({ kind, text })
    setTimeout(() => setStatus(null), 1800)
  }, [])

  const onDownload = useCallback(async () => {
    if (!svgRef.current) return
    try {
      const blob = await svgToPngBlob(svgRef.current, 2)
      const safeTitle = (spec.title ?? `${spec.type}-chart`).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60)
      downloadBlob(blob, `${safeTitle || "chart"}.png`)
      flash("ok", "PNG downloaded")
    } catch {
      flash("err", "Download failed")
    }
  }, [spec.title, spec.type, flash])

  useEffect(() => {
    if (!previewOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [previewOpen])

  const onCopy = useCallback(async () => {
    if (!svgRef.current) return
    try {
      const blob = await svgToPngBlob(svgRef.current, 2)
      const ok = await copyBlobToClipboard(blob)
      if (ok) flash("ok", "Image copied to clipboard")
      else {
        downloadBlob(blob, "chart.png")
        flash("ok", "Clipboard image copy not supported — downloaded PNG instead")
      }
    } catch {
      flash("err", "Copy failed")
    }
  }, [flash])

  // Map a pointer event to the nearest data column / pie slice and place the
  // tooltip. Coordinates are converted from on-screen px into viewBox units so
  // the snapping stays correct at any rendered size.
  const onMove = (e: React.MouseEvent) => {
    const svg = svgRef.current
    const model = chart.hover
    if (!svg || !model) return
    const rect = svg.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const sx = ((e.clientX - rect.left) / rect.width) * width
    const sy = ((e.clientY - rect.top) / rect.height) * height
    let left = e.clientX - rect.left + 14
    let top = e.clientY - rect.top + 12
    if (left > rect.width - 190) left = e.clientX - rect.left - 190
    if (top > rect.height - 96) top = rect.height - 96
    left = Math.max(4, left)
    top = Math.max(4, top)

    if (model.kind === "columns") {
      if (!model.columns.length) return
      let best = 0
      let bd = Infinity
      model.columns.forEach((c, i) => {
        const d = Math.abs(c.xPx - sx)
        if (d < bd) { bd = d; best = i }
      })
      setHover({ index: best, left, top })
    } else {
      const dx = sx - model.cx
      const dy = sy - model.cy
      if (Math.hypot(dx, dy) > model.r) { setHover(null); return }
      // Normalise the pointer angle to 0 = top, clockwise — matching how the
      // slices accumulate their start/end in renderPie.
      let a = Math.atan2(dy, dx) + Math.PI / 2
      while (a < 0) a += Math.PI * 2
      while (a >= Math.PI * 2) a -= Math.PI * 2
      const found = model.slices.findIndex((s) => a >= s.start && a < s.end)
      if (found < 0) { setHover(null); return }
      setHover({ index: found, left, top })
    }
  }

  // Crosshair / highlight overlay drawn in chart coords, but in a SEPARATE
  // pointer-events-none SVG so it is never picked up by the PNG rasteriser
  // (which clones svgRef only).
  let overlay: ReactNode = null
  let tooltip: ReactNode = null
  if (hover && chart.hover) {
    if (chart.hover.kind === "columns") {
      const col = chart.hover.columns[hover.index]
      if (col) {
        overlay = (
          <>
            <line x1={col.xPx} y1={chart.hover.plotTop} x2={col.xPx} y2={chart.hover.plotBottom}
                  stroke="#94a3b8" strokeWidth={1} strokeDasharray="4 3" />
            {col.rows.map((r, i) =>
              r.yPx != null ? (
                <circle key={i} cx={col.xPx} cy={r.yPx} r={4} fill={r.color}
                        stroke="#fff" strokeWidth={1.5} />
              ) : null,
            )}
          </>
        )
        const shown = col.rows.slice(0, 12)
        tooltip = (
          <>
            <div className="mb-1 font-medium text-gray-500 dark:text-gray-400">{col.xLabel}</div>
            {shown.map((r, i) => (
              <div key={i} className="flex items-center gap-1.5 leading-snug">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: r.color }} />
                <span className="text-gray-600 dark:text-gray-300">{r.name}</span>
                <span className="ml-auto pl-3 font-medium tabular-nums text-gray-900 dark:text-gray-100">
                  {r.valueLabel}
                </span>
              </div>
            ))}
            {col.rows.length > shown.length && (
              <div className="mt-0.5 text-gray-400">+{col.rows.length - shown.length} more</div>
            )}
          </>
        )
      }
    } else {
      const s = chart.hover.slices[hover.index]
      if (s) {
        const { cx, cy, r } = chart.hover
        const rr = r + 3
        const a1 = s.start - Math.PI / 2
        const a2 = s.end - Math.PI / 2
        const large = s.end - s.start > Math.PI ? 1 : 0
        const d =
          `M ${(cx + rr * Math.cos(a1)).toFixed(2)} ${(cy + rr * Math.sin(a1)).toFixed(2)} ` +
          `A ${rr} ${rr} 0 ${large} 1 ${(cx + rr * Math.cos(a2)).toFixed(2)} ${(cy + rr * Math.sin(a2)).toFixed(2)}`
        overlay = <path d={d} fill="none" stroke={s.color} strokeWidth={3} strokeLinecap="round" />
        tooltip = (
          <>
            <div className="flex items-center gap-1.5 font-medium text-gray-900 dark:text-gray-100">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </div>
            <div className="mt-0.5 text-gray-600 dark:text-gray-300">
              {s.valueLabel} · {s.pct}
            </div>
          </>
        )
      }
    }
  }

  const a11yLabel = spec.title || `${spec.type} chart`

  return (
    <>
      <div
        ref={hostRef}
        className={`chart-host group relative my-3 w-full ${THEME_CLASSES} ${className ?? ""}`}
        style={{ lineHeight: 0, ...style }}
      >
      {/* Toolbar sits in its own flow row above the chart — never overlaps the
          title or legend the way an absolutely-positioned overlay did. */}
      <div
        className="flex h-7 items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
        style={{ lineHeight: "normal" }}
      >
        {(spec.type === "bar" || spec.type === "line") && logAvailable && (
          <button
            type="button"
            onClick={() => setYScalePref(effectiveLog ? "linear" : "log")}
            aria-label="Toggle linear / log Y axis"
            title="Toggle linear / log Y axis"
            className={`${TOOLBAR_BTN} px-2 text-[11px] font-medium`}
          >
            {effectiveLog ? "Log" : "Linear"}
          </button>
        )}
        {allowPreview && (
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            aria-label="Open larger chart preview"
            title="Open larger chart preview"
            className={`${TOOLBAR_BTN} w-7`}
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy chart as PNG to clipboard"
          title="Copy chart as PNG to clipboard"
          className={`${TOOLBAR_BTN} w-7`}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onDownload}
          aria-label="Download chart as PNG"
          title="Download chart as PNG"
          className={`${TOOLBAR_BTN} w-7`}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>

      <div className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg
          ref={svgRef}
          xmlns="http://www.w3.org/2000/svg"
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height="auto"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={a11yLabel}
          fontFamily="ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"
          style={{ display: "block" }}
        >
          <title>{a11yLabel}</title>
          <desc>{describeChart(spec)}</desc>
          <rect width={width} height={height} className="chart-bg" />
          <Title text={spec.title} width={width} />
          {chart.els}
        </svg>

        {overlay && (
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
          >
            {overlay}
          </svg>
        )}

        {tooltip && hover && (
          <div
            className="pointer-events-none absolute z-10 max-w-[230px] rounded-md border border-gray-200 bg-white/95 px-2.5 py-1.5 text-[11px] shadow-md dark:border-slate-700 dark:bg-slate-800/95"
            style={{ left: hover.left, top: hover.top, lineHeight: "normal" }}
          >
            {tooltip}
          </div>
        )}
      </div>

      {status && (
        <div
          className={`absolute left-1/2 top-9 -translate-x-1/2 rounded-md px-2.5 py-1 text-xs shadow-sm ${
            status.kind === "ok"
              ? "bg-emerald-600 text-white"
              : "bg-red-600 text-white"
          }`}
          style={{ lineHeight: "normal" }}
        >
          {status.text}
        </div>
      )}
      </div>

      {allowPreview && previewOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Chart preview"
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="max-h-[92vh] w-[min(1200px,96vw)] overflow-auto rounded-lg border border-gray-200 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between gap-3" style={{ lineHeight: "normal" }}>
              <div className="min-w-0 truncate text-sm font-medium text-gray-700 dark:text-gray-200">
                {spec.title || "Chart preview"}
              </div>
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                aria-label="Close chart preview"
                title="Close chart preview"
                className={`${TOOLBAR_BTN} h-8 w-8 shrink-0 opacity-100`}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <ChartRendererImpl spec={spec} className="my-0" allowPreview={false} />
          </div>
        </div>
      )}
    </>
  )
}

// Wrap with React.memo so the SVG subtree skips reconciliation when the parent
// re-renders with an equivalent spec. The chart lives inside a streaming chat
// bubble whose <Markdown> parent re-runs on every token the LLM emits *after*
// the chart fence closes — without this guard each trailing prose token would
// rebuild hundreds of SVG nodes, producing visible flicker for the seconds it
// takes the model to finish the reply. We compare by serialised spec (cheap —
// specs are small JSON) so a freshly-parsed-but-equal spec object
// short-circuits identically to a referentially-stable one.
export const ChartRenderer = memo(ChartRendererImpl, (prev, next) => {
  if (prev.className !== next.className) return false
  if (prev.style !== next.style) return false
  if (prev.allowPreview !== next.allowPreview) return false
  return JSON.stringify(prev.spec) === JSON.stringify(next.spec)
})
