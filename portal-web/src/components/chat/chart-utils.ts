/**
 * Pure (DOM-free) logic for the chart renderer: the ChartSpec contract, number
 * / axis math, legend layout, plot geometry, canvas sizing, and the trust-
 * boundary spec parser.
 *
 * This file deliberately holds NO JSX and NO browser APIs so every function
 * here is unit-testable headlessly (see chart-utils.test.ts). ChartRenderer.tsx
 * imports from here and keeps only the React components + DOM helpers.
 */

export type PieSlice = { label: string; value: number }
export type BarSeries = { name: string; values: number[] }
export type LinePoint = { x: number | string; y: number }
export type LineSeries = { name: string; points: LinePoint[] }

export const CHART_SPEC_VERSION = 1

export interface CommonOpts {
  schema_version?: typeof CHART_SPEC_VERSION
  title?: string
  x_label?: string
  y_label?: string
  width?: number
  height?: number
}

export type ChartSpec =
  | ({ type: "pie"; data: { slices: PieSlice[] } } & CommonOpts)
  | ({ type: "bar"; data: { categories: string[]; series: BarSeries[] } } & CommonOpts)
  | ({ type: "line"; data: { series: LineSeries[] } } & CommonOpts)

// No grey in the categorical palette — grey is reserved for the "Others"
// bucket so it reads as a residual rather than a real category. 11 distinct
// hues cover the max 11 real slices a collapsed pie can have.
export const PALETTE = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#b6992d", "#d37295",
]
// Neutral grey for the collapsed "Others" slice — legible on both themes.
export const OTHERS_COLOR = "#9aa0a6"

export const TITLE_SIZE = 18
export const LEGEND_SIZE = 13
// Vertical advance between wrapped legend rows.
export const LEGEND_LINE_H = LEGEND_SIZE + 9
export const AXIS_LABEL_SIZE = 13
export const TICK_SIZE = 12
export const PIE_LABEL_SIZE = 12

// Per-series line dash patterns + marker shapes. Colour alone is not enough to
// tell series apart for colour-blind viewers or in greyscale prints, so each
// line series also gets a distinct dash and a distinct point marker.
export const LINE_DASHES = ["", "7 4", "2 4", "10 4 2 4", "1 5"]
export type MarkerShapeKind = "circle" | "square" | "triangle" | "diamond"
export const MARKER_SHAPES: MarkerShapeKind[] = ["circle", "square", "triangle", "diamond"]
export function seriesDash(i: number): string {
  return LINE_DASHES[i % LINE_DASHES.length]
}
export function seriesShape(i: number): MarkerShapeKind {
  return MARKER_SHAPES[i % MARKER_SHAPES.length]
}

// High-cardinality pie data (e.g. a per-namespace Pod count with 20+ entries)
// renders as a fan of unreadable slivers. Keep the largest slices and roll the
// long tail into a single "Others" bucket so the chart stays legible.
export const PIE_MAX_SLICES = 12

// othersIndex is the index of the collapsed "Others" slice, or -1 when the
// data was small enough to render as-is. The caller colours that slice grey.
export function collapsePieSlices(
  slices: PieSlice[],
  max = PIE_MAX_SLICES,
): { slices: PieSlice[]; othersIndex: number } {
  if (slices.length <= max) return { slices, othersIndex: -1 }
  const sorted = [...slices].sort((a, b) => b.value - a.value)
  const head = sorted.slice(0, max - 1)
  const tail = sorted.slice(max - 1)
  const tailTotal = tail.reduce((a, s) => a + Math.max(0, s.value), 0)
  return {
    slices: [...head, { label: `Others (${tail.length})`, value: tailTotal }],
    othersIndex: head.length,
  }
}

export function pieSliceColor(index: number, othersIndex: number): string {
  return index === othersIndex ? OTHERS_COLOR : PALETTE[index % PALETTE.length]
}

export function approxTextWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) {
    // CJK ideographs + fullwidth forms render roughly square (one em wide).
    if (/[\u4e00-\u9fff\uff00-\uffef]/.test(ch)) w += fontSize
    else if (/[A-Z0-9]/.test(ch)) w += fontSize * 0.62
    else w += fontSize * 0.52
  }
  return w
}

// Compact, human-readable number formatting for axis ticks and tooltips.
// Everyday magnitudes must NOT use scientific notation — a Pod count of 1200
// should read "1,200", not "1.20e+3". SI suffixes cover the genuinely large;
// values below 1 keep significant-digit precision (so 0.003 stays "0.003" and
// is not rounded down to "0" by a fixed 2-decimal format); exponential is the
// last resort for values outside any sane chart range.
export function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  if (n === 0) return "0"
  const abs = Math.abs(n)
  if (abs >= 1e15 || abs < 1e-4) return n.toExponential(1).replace("e+", "e")
  if (abs >= 1e6) {
    const units: Array<[string, number]> = [["T", 1e12], ["G", 1e9], ["M", 1e6]]
    for (const [u, d] of units) {
      if (abs >= d) {
        const v = n / d
        return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + u
      }
    }
  }
  if (abs >= 1000) return Math.round(n).toLocaleString("en-US")
  if (Number.isInteger(n)) return String(n)
  if (abs >= 1) return String(Number(n.toFixed(2)))
  // abs in [1e-4, 1): two significant digits, no scientific notation.
  return String(Number(n.toPrecision(2)))
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range || 1))
  const f = range / Math.pow(10, exp)
  let nf: number
  if (round) {
    if (f < 1.5) nf = 1
    else if (f < 3) nf = 2
    else if (f < 7) nf = 5
    else nf = 10
  } else if (f <= 1) nf = 1
  else if (f <= 2) nf = 2
  else if (f <= 5) nf = 5
  else nf = 10
  return nf * Math.pow(10, exp)
}

export interface Axis { min: number; max: number; ticks: number[]; log?: boolean }

export function niceAxis(min: number, max: number, count = 5): Axis {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1, ticks: [0, 0.5, 1] }
  }
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1
    min -= pad; max += pad
  }
  const range = niceNum(max - min, false)
  const step = niceNum(range / (count - 1), true)
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = niceMin; v <= niceMax + step / 2; v += step) {
    ticks.push(Number(v.toFixed(10)))
  }
  return { min: niceMin, max: niceMax, ticks }
}

// Log-scale axis spanning whole powers of ten. Used when a linear axis would
// flatten small series into an unreadable band along the baseline.
export function logAxis(dataMin: number, dataMax: number): Axis {
  const loExp = Math.floor(Math.log10(dataMin))
  const hiExp = Math.max(Math.ceil(Math.log10(dataMax)), loExp + 1)
  const ticks: number[] = []
  for (let e = loExp; e <= hiExp + 1e-9; e++) ticks.push(Math.pow(10, e))
  return { min: Math.pow(10, loExp), max: Math.pow(10, hiExp), ticks, log: true }
}

// Fraction (0..1) of a value's position along its axis, log-aware.
export function axisFrac(axis: Axis, v: number): number {
  if (axis.log) {
    const lmin = Math.log10(axis.min)
    const lmax = Math.log10(axis.max)
    const lv = Math.log10(Math.max(v, axis.min))
    return lmax > lmin ? (lv - lmin) / (lmax - lmin) : 0
  }
  return axis.max > axis.min ? (v - axis.min) / (axis.max - axis.min) : 0
}

// A log scale is *possible* — and the toolbar toggle worth offering — whenever
// every value is positive (log of <=0 is undefined) and there are at least two
// values to span. This is intentionally permissive: the user can switch to log
// even on a modest spread, the same way bar and line charts both expose it.
export function logPossible(values: number[]): boolean {
  const finite = values.filter((v) => Number.isFinite(v))
  const pos = finite.filter((v) => v > 0)
  return pos.length >= 2 && pos.length === finite.length
}

// A log scale is *beneficial* — worth auto-selecting in "auto" mode — only when
// it's possible AND the spread is large enough that a linear axis would flatten
// small values into an unreadable band along the baseline.
export function logBeneficial(values: number[]): boolean {
  if (!logPossible(values)) return false
  const pos = values.filter((v) => Number.isFinite(v) && v > 0)
  return Math.max(...pos) / Math.min(...pos) >= 50
}

export function collectChartValues(spec: ChartSpec): number[] {
  if (spec.type === "bar") return spec.data.series.flatMap((s) => s.values)
  if (spec.type === "line") return spec.data.series.flatMap((s) => s.points.map((p) => p.y))
  return []
}

// Legend swatch/spacing geometry, shared by layout + render so wrapping math
// and drawn positions never drift.
export const LEGEND_SWATCH = 12
export const LEGEND_GAP = 6
export const LEGEND_BETWEEN = 18
export const LEGEND_MARGIN = 16

// Pack legend entries into rows that each fit within the chart width. A single
// long row used to overflow the viewBox and silently clip every entry past the
// right edge — wrapping keeps all series visible.
export function layoutLegendRows(names: string[], width: number): string[][] {
  const maxW = width - LEGEND_MARGIN * 2
  const itemW = (n: string) => LEGEND_SWATCH + LEGEND_GAP + approxTextWidth(n, LEGEND_SIZE)
  const rows: string[][] = []
  let cur: string[] = []
  let curW = 0
  for (const n of names) {
    const w = itemW(n)
    const add = cur.length ? LEGEND_BETWEEN + w : w
    if (cur.length && curW + add > maxW) {
      rows.push(cur)
      cur = []
      curW = 0
    }
    cur.push(n)
    curW += cur.length === 1 ? w : LEGEND_BETWEEN + w
  }
  if (cur.length) rows.push(cur)
  return rows
}

// Number of legend rows the chart will need at a given width. Single source of
// truth: both the canvas-height calculation and computePlot must agree on this,
// otherwise the legend eats space the plot thinks it has and the plot collapses
// to a sliver. Pie charts use a vertical side-legend, so they need 0 rows here.
export function legendRowsFor(spec: ChartSpec, width: number): number {
  if (spec.type === "bar" || spec.type === "line") {
    const names = spec.data.series.map((s) => s.name)
    return names.length > 1 ? layoutLegendRows(names, width).length : 0
  }
  return 0
}

export interface Plot { left: number; right: number; top: number; bottom: number; w: number; h: number }
// `rotatedTickH` is the height of the x-tick band when ticks are rotated; the
// caller measures it from the actual longest label (see barTickLayout) so a
// long category label never overhangs past the canvas bottom. Defaults to the
// historic fixed value for callers that don't rotate.
// `xTickSidePadding` reserves left/right plot margins for rotated edge labels;
// without this, the first long -30deg x label can extend beyond the SVG viewBox.
export function computePlot(
  width: number, height: number,
  hasTitle: boolean, legendRows: number,
  hasXLabels: boolean, rotateXTicks: boolean,
  hasYAxisLabel: boolean, hasXAxisLabel: boolean,
  rotatedTickH = 50,
  xTickSidePadding: { left?: number; right?: number } = {},
): Plot {
  const titleH = hasTitle ? 30 : 6
  const legendH = legendRows > 0 ? legendRows * LEGEND_LINE_H + 6 : 0
  const xTickH = hasXLabels ? (rotateXTicks ? rotatedTickH : 26) : 8
  const xLabelH = hasXAxisLabel ? 22 : 0
  const yLabelW = hasYAxisLabel ? 22 : 0
  const top = titleH + legendH + 8
  const bottom = height - xTickH - xLabelH - 8
  const left = 60 + yLabelW + Math.max(0, xTickSidePadding.left ?? 0)
  const right = width - 24 - Math.max(0, xTickSidePadding.right ?? 0)
  return { left, right, top, bottom, w: right - left, h: bottom - top }
}

// Bar x-tick geometry — single source of truth shared by chartCanvasSize (which
// grows the canvas to fit) and renderBar (which draws + reserves the band).
// Category labels rotate to -30° when they'd otherwise overlap; a rotated label
// overhangs the axis by labelWidth*sin(30°), so the band must be tall enough to
// contain that overhang or the labels get clipped at the canvas bottom.
export const BAR_TICK_ROTATE_DEG = 30
// Gap from the plot bottom to the rotated label's anchor (matches renderBar).
const BAR_TICK_GAP = 16
// Historic fixed rotated-tick band height; canvas growth is measured against it.
export const BAR_TICK_BASE_H = 50

export function barTickLayout(
  categories: string[], width: number,
  opts: { hasYAxisLabel?: boolean } = {},
): { rotate: boolean; tickBandH: number; sidePaddingLeft: number; sidePaddingRight: number } {
  const longest = categories.reduce(
    (m, c) => Math.max(m, approxTextWidth(c, TICK_SIZE)),
    0,
  )
  const approxGroupW = categories.length ? (width - 80) / categories.length : width
  const rotate = longest + 4 > approxGroupW
  if (!rotate) return { rotate: false, tickBandH: 26, sidePaddingLeft: 0, sidePaddingRight: 0 }
  const angle = (BAR_TICK_ROTATE_DEG * Math.PI) / 180
  const verticalOverhang = longest * Math.sin(angle)

  // Rotated bar labels are end-anchored, so the first label extends up-left
  // from its category centre. Reserve enough extra left margin for that label
  // to stay inside the SVG viewport. The right edge does not need symmetric
  // padding with the current end-anchor geometry, but keep the field explicit
  // so computePlot has a stable shape if the label anchoring changes later.
  const first = categories[0] ?? ""
  const firstW = approxTextWidth(first, TICK_SIZE)
  const baseLeft = 60 + (opts.hasYAxisLabel ? 22 : 0)
  const baseRight = width - 24
  const n = Math.max(1, categories.length)
  const basePlotW = Math.max(1, baseRight - baseLeft)
  const firstAnchor = baseLeft + basePlotW / n / 2
  const edgePad = 8
  const deficit = firstW * Math.cos(angle) + edgePad - firstAnchor
  const denom = 1 - 1 / (2 * n)
  const maxSidePadding = Math.max(0, width * 0.28)
  const sidePaddingLeft = Math.min(
    maxSidePadding,
    Math.max(0, Math.ceil(deficit / denom)),
  )

  return {
    rotate: true,
    tickBandH: Math.ceil(BAR_TICK_GAP + verticalOverhang + 8),
    sidePaddingLeft,
    sidePaddingRight: 0,
  }
}

export function defaultSize(type: ChartSpec["type"]): { width: number; height: number } {
  if (type === "pie") return { width: 760, height: 480 }
  return { width: 900, height: 520 }
}

export function describeChart(spec: ChartSpec): string {
  if (spec.type === "pie") return `Pie chart with ${spec.data.slices.length} segment(s).`
  if (spec.type === "bar") {
    return `Bar chart with ${spec.data.categories.length} categories and ${spec.data.series.length} series.`
  }
  return `Line chart with ${spec.data.series.length} series.`
}

// Single source of truth for chart canvas dimensions.
//
// width:  the container's measured width, clamped to [300, specWidth] so the
//         chart fills a narrow chat bubble without ever upscaling past its
//         ideal size. Falls back to specWidth before the first measurement.
// height: the spec height is a FLOOR, never scaled down. A narrow width forces
//         the legend to wrap onto more rows; shrinking the canvas at the same
//         time would collapse the plot to a sliver. Instead the canvas GROWS
//         by one line per extra wrapped legend row.
// legendRows: returned so renderBar/renderLine reuse the exact same count via
//         computePlot — they must not recompute it independently.
export function chartCanvasSize(
  spec: ChartSpec,
  measuredW: number | null,
): { width: number; height: number; legendRows: number } {
  const def = defaultSize(spec.type)
  const specWidth = spec.width ?? def.width
  const specHeight = spec.height ?? def.height
  const width = measuredW
    ? Math.round(Math.min(Math.max(measuredW, 300), specWidth))
    : specWidth
  const legendRows = legendRowsFor(spec, width)
  let height = specHeight + Math.max(0, legendRows - 1) * LEGEND_LINE_H
  // Grow the canvas when bar category labels rotate and overhang past the
  // historic fixed tick band — same "canvas GROWS, plot never collapses"
  // philosophy as the legend-row growth above.
  if (spec.type === "bar") {
    const { tickBandH } = barTickLayout(spec.data.categories, width, { hasYAxisLabel: !!spec.y_label })
    height += Math.max(0, tickBandH - BAR_TICK_BASE_H)
  }
  return { width, height, legendRows }
}

// ---- Trust-boundary spec parser -------------------------------------------

// Heuristic: does the text look like a fully-streamed JSON object, or are we
// still mid-stream? During streaming ReactMarkdown re-parses on every token,
// so the chart fence is rendered before the closing `}` arrives — without
// this check tryParseChartSpec would return null and Markdown.tsx would flash
// the red "parse failed" box for every chart until streaming completes.
// Returns true when the text is empty, doesn't end with `}`, or has more
// opening braces than closing ones (ignoring braces inside JSON strings).
export function chartSpecLooksIncomplete(raw: string): boolean {
  const text = raw.trim()
  if (!text || !text.endsWith("}")) return true
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (esc) { esc = false; continue }
    if (inStr) {
      if (ch === "\\") esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === "{") depth++
    else if (ch === "}") depth--
  }
  return depth !== 0 || inStr
}

// The chart spec round-trips through the LLM as plain text in the final reply.
// On a small fraction of generations the model double-escapes non-ASCII —
// emits a literal backslash-u-XXXX sequence instead of the character (or a
// single \u escape JSON.parse would decode). JSON.parse then yields the
// literal 6-char string. Decode such stray escapes so CJK titles/labels render.
function decodeStrayUnicodeEscapes(s: string): string {
  if (!s.includes("\\u")) return s
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

// String coercion for model-emitted leaf text: the renderer iterates these
// with `for..of` (would throw on a number) and draws them verbatim (would
// show stray unicode escapes). Both hazards are normalised here.
function toCleanString(v: unknown): string {
  return decodeStrayUnicodeEscapes(String(v))
}

function pickCommonOpts(obj: Record<string, unknown>): CommonOpts | null {
  const rawVersion = obj.schema_version
  if (rawVersion !== undefined && rawVersion !== CHART_SPEC_VERSION) return null
  const out: CommonOpts = { schema_version: CHART_SPEC_VERSION }
  for (const k of ["title", "x_label", "y_label"] as const) {
    if (typeof obj[k] === "string") out[k] = decodeStrayUnicodeEscapes(obj[k] as string)
  }
  for (const k of ["width", "height"] as const) {
    if (typeof obj[k] === "number" && Number.isFinite(obj[k])) out[k] = obj[k] as number
  }
  return out
}

// Coerce a leaf value to a finite number the way the backend handler does
// (accepts numeric strings), or return null when it can't — JSON.stringify
// would otherwise serialise a NaN as `null` and the renderer would silently
// draw wrong data.
function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

// Deep validation + normalisation mirroring backend handler.ts `validate()`.
// The chart JSON is re-emitted by the LLM in its final reply (not the original
// tool response), so it crosses a trust boundary even though the MCP tool
// itself validated input — the model can rewrite, truncate, or corrupt fields
// during paste. Beyond shape checks this also normalises leaf values: category
// / series-name fields are coerced to strings (the renderer iterates them with
// `for..of` and would throw on a number) and numeric fields are coerced to
// finite numbers (a non-finite value rejects the whole spec). Returning null
// lets Markdown.tsx fall back to <ChartParseError> instead of crashing the
// chat bubble inside the chart renderers.
export function tryParseChartSpec(raw: string): ChartSpec | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    if (!obj || typeof obj !== "object") return null
    const data = obj.data as Record<string, unknown> | undefined
    if (!data || typeof data !== "object") return null
    const common = pickCommonOpts(obj)
    if (!common) return null

    if (obj.type === "pie") {
      const rawSlices = data.slices
      if (!Array.isArray(rawSlices) || !rawSlices.length) return null
      const slices: PieSlice[] = []
      for (let i = 0; i < rawSlices.length; i++) {
        const s = rawSlices[i] as { label?: unknown; value?: unknown }
        if (!s || typeof s !== "object") return null
        const value = toFiniteNumber(s.value)
        if (value === null) return null
        slices.push({ label: toCleanString(s.label ?? `slice ${i}`), value })
      }
      return { type: "pie", data: { slices }, ...common }
    }

    if (obj.type === "bar") {
      const rawCats = data.categories
      const rawSeries = data.series
      if (!Array.isArray(rawCats) || !rawCats.length) return null
      if (!Array.isArray(rawSeries) || !rawSeries.length) return null
      const categories = rawCats.map(toCleanString)
      const series: BarSeries[] = []
      for (let i = 0; i < rawSeries.length; i++) {
        const s = rawSeries[i] as { name?: unknown; values?: unknown }
        if (!s || typeof s !== "object" || !Array.isArray(s.values)) return null
        if (s.values.length !== categories.length) return null
        const values: number[] = []
        for (const v of s.values) {
          const n = toFiniteNumber(v)
          if (n === null) return null
          values.push(n)
        }
        series.push({ name: toCleanString(s.name ?? `series ${i}`), values })
      }
      return { type: "bar", data: { categories, series }, ...common }
    }

    if (obj.type === "line") {
      const rawSeries = data.series
      if (!Array.isArray(rawSeries) || !rawSeries.length) return null
      const series: LineSeries[] = []
      for (let i = 0; i < rawSeries.length; i++) {
        const s = rawSeries[i] as { name?: unknown; points?: unknown }
        if (!s || typeof s !== "object" || !Array.isArray(s.points) || !s.points.length) return null
        const points: LinePoint[] = []
        for (const p of s.points) {
          const pt = p as { x?: unknown; y?: unknown }
          if (!pt || typeof pt !== "object") return null
          const y = toFiniteNumber(pt.y)
          if (y === null) return null
          const x = typeof pt.x === "number" ? pt.x : toCleanString(pt.x)
          points.push({ x, y })
        }
        series.push({ name: toCleanString(s.name ?? `series ${i}`), points })
      }
      return { type: "line", data: { series }, ...common }
    }

    return null
  } catch {
    return null
  }
}
