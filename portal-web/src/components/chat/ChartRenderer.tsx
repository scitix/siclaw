/**
 * Client-side chart renderer.
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
 * This file is the contract shared with MCP — the MCP tool emits a chart spec
 * matching the ChartSpec union below, fenced as ```chart in markdown.
 */

import { type CSSProperties, type ReactNode, useRef, useState, useCallback } from "react"

type PieSlice = { label: string; value: number }
type BarSeries = { name: string; values: number[] }
type LinePoint = { x: number | string; y: number }
type LineSeries = { name: string; points: LinePoint[] }

interface CommonOpts {
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

const PALETTE = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac",
]

const TITLE_SIZE = 18
const LEGEND_SIZE = 13
const AXIS_LABEL_SIZE = 13
const TICK_SIZE = 12
const PIE_LABEL_SIZE = 12

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

function approxTextWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) {
    if (/[一-鿿＀-￯]/.test(ch)) w += fontSize
    else if (/[A-Z0-9]/.test(ch)) w += fontSize * 0.62
    else w += fontSize * 0.52
  }
  return w
}

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  const abs = Math.abs(n)
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) return n.toExponential(2)
  return Number.isInteger(n) ? n.toString() : n.toFixed(2)
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

interface Axis { min: number; max: number; ticks: number[] }
function niceAxis(min: number, max: number, count = 5): Axis {
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

interface Plot { left: number; right: number; top: number; bottom: number; w: number; h: number }
function computePlot(
  width: number, height: number,
  hasTitle: boolean, hasLegend: boolean,
  hasXLabels: boolean, rotateXTicks: boolean,
  hasYAxisLabel: boolean, hasXAxisLabel: boolean,
): Plot {
  const titleH = hasTitle ? 30 : 6
  const legendH = hasLegend ? 26 : 0
  const xTickH = hasXLabels ? (rotateXTicks ? 50 : 26) : 8
  const xLabelH = hasXAxisLabel ? 22 : 0
  const yLabelW = hasYAxisLabel ? 22 : 0
  const top = titleH + legendH + 8
  const bottom = height - xTickH - xLabelH - 8
  const left = 60 + yLabelW
  const right = width - 24
  return { left, right, top, bottom, w: right - left, h: bottom - top }
}

function Title({ text, width }: { text?: string; width: number }) {
  if (!text) return null
  return (
    <text x={width / 2} y={22} textAnchor="middle" fontSize={TITLE_SIZE} fontWeight={600}
          className="chart-title">{text}</text>
  )
}

function LegendRow({ width, y, names }: { width: number; y: number; names: string[] }) {
  const swatch = 12, gap = 6, between = 18
  const widths = names.map(n => swatch + gap + approxTextWidth(n, LEGEND_SIZE))
  const totalW = widths.reduce((a, b) => a + b, 0) + (names.length - 1) * between
  let x = Math.max(16, (width - totalW) / 2)
  const out: ReactNode[] = []
  names.forEach((n, i) => {
    const color = PALETTE[i % PALETTE.length]
    out.push(
      <rect key={`s${i}`} x={x} y={y - swatch + 2} width={swatch} height={swatch}
            fill={color} rx={2} />,
      <text key={`t${i}`} x={x + swatch + gap} y={y + 2} fontSize={LEGEND_SIZE}
            className="chart-legend">{n}</text>,
    )
    x += widths[i] + between
  })
  return <>{out}</>
}

function YAxis({ plot, axis, label }: { plot: Plot; axis: Axis; label?: string }) {
  const out: ReactNode[] = []
  axis.ticks.forEach((t, i) => {
    const y = plot.bottom - ((t - axis.min) / (axis.max - axis.min)) * plot.h
    out.push(
      <line key={`g${i}`} x1={plot.left} y1={y} x2={plot.right} y2={y}
            strokeWidth={1} className="chart-grid" />,
      <text key={`y${i}`} x={plot.left - 8} y={y + 4} textAnchor="end" fontSize={TICK_SIZE}
            className="chart-tick">{fmtNumber(t)}</text>,
    )
  })
  out.push(
    <line key="ay" x1={plot.left} y1={plot.top} x2={plot.left} y2={plot.bottom}
          strokeWidth={1} className="chart-axis-line" />,
    <line key="ax" x1={plot.left} y1={plot.bottom} x2={plot.right} y2={plot.bottom}
          strokeWidth={1} className="chart-axis-line" />,
  )
  if (label) {
    const cy = plot.top + plot.h / 2
    out.push(
      <text key="yl" x={18} y={cy} textAnchor="middle" fontSize={AXIS_LABEL_SIZE}
            transform={`rotate(-90 18 ${cy})`} className="chart-axis-label">{label}</text>,
    )
  }
  return <>{out}</>
}

function XAxisTitle({ plot, height, label }: { plot: Plot; height: number; label?: string }) {
  if (!label) return null
  return (
    <text x={(plot.left + plot.right) / 2} y={height - 10} textAnchor="middle"
          fontSize={AXIS_LABEL_SIZE} className="chart-axis-label">{label}</text>
  )
}

function PieChart({ spec, width, height }: { spec: Extract<ChartSpec, { type: "pie" }>; width: number; height: number }) {
  const slices = spec.data.slices
  const total = slices.reduce((a, s) => a + Math.max(0, s.value), 0)
  if (total <= 0) {
    return (
      <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={14}
            className="chart-tick">no data</text>
    )
  }
  const titleH = spec.title ? 30 : 6
  const padY = 16
  const top = titleH + padY
  const bottom = height - padY
  const innerH = bottom - top
  const labels = slices.map(s => `${s.label} (${fmtNumber(s.value)}, ${(s.value / total * 100).toFixed(1)}%)`)
  const legendW = Math.min(
    Math.max(...labels.map(l => approxTextWidth(l, LEGEND_SIZE))) + 28,
    width * 0.42,
  )
  const pieAreaW = width - legendW - 32
  const cx = 16 + pieAreaW / 2
  const cy = top + innerH / 2
  const r = Math.max(60, Math.min(pieAreaW / 2 - 12, innerH / 2 - 8))

  const slicesEls: ReactNode[] = []
  let angle = -Math.PI / 2
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
    const color = PALETTE[i % PALETTE.length]
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
          {(v / total * 100).toFixed(1)}%
        </text>,
      )
    }
    angle = a2
  })

  // Legend column on the right
  const legX = width - legendW - 8
  const lineH = LEGEND_SIZE + 10
  const legBlockH = labels.length * lineH
  let legY = Math.max(top + 8, top + (innerH - legBlockH) / 2 + LEGEND_SIZE)
  const legendEls: ReactNode[] = []
  labels.forEach((label, i) => {
    const color = PALETTE[i % PALETTE.length]
    legendEls.push(
      <rect key={`ls${i}`} x={legX} y={legY - LEGEND_SIZE + 2} width={14} height={14}
            fill={color} rx={2} />,
      <text key={`lt${i}`} x={legX + 22} y={legY + 2} fontSize={LEGEND_SIZE}
            className="chart-legend">{label}</text>,
    )
    legY += lineH
  })

  return <>{slicesEls}{legendEls}</>
}

function BarChart({ spec, width, height }: { spec: Extract<ChartSpec, { type: "bar" }>; width: number; height: number }) {
  const { categories, series } = spec.data
  if (!categories.length || !series.length) {
    return (
      <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={14}
            className="chart-tick">no data</text>
    )
  }
  const hasLegend = series.length > 1
  const approxGroupW = (width - 80) / categories.length
  const longest = Math.max(...categories.map(c => approxTextWidth(c, TICK_SIZE)))
  const rotate = longest + 4 > approxGroupW
  const plot = computePlot(width, height, !!spec.title, hasLegend, true, rotate, !!spec.y_label, !!spec.x_label)

  let dataMin = 0, dataMax = 0
  series.forEach(s => s.values.forEach(v => {
    if (!Number.isFinite(v)) return
    if (v < dataMin) dataMin = v
    if (v > dataMax) dataMax = v
  }))
  if (dataMax === 0 && dataMin === 0) dataMax = 1
  const axis = niceAxis(dataMin, dataMax)
  const groupW = plot.w / categories.length
  const groupPad = Math.min(20, groupW * 0.22)
  const barW = (groupW - groupPad) / series.length
  const zeroY = plot.bottom - ((0 - axis.min) / (axis.max - axis.min)) * plot.h

  const els: ReactNode[] = []
  categories.forEach((cat, gi) => {
    const gx = plot.left + gi * groupW + groupPad / 2
    series.forEach((s, si) => {
      const v = s.values[gi] ?? 0
      if (!Number.isFinite(v)) return
      const y = plot.bottom - ((v - axis.min) / (axis.max - axis.min)) * plot.h
      const top = Math.min(y, zeroY)
      const h = Math.abs(y - zeroY)
      const x = gx + si * barW
      const color = PALETTE[si % PALETTE.length]
      els.push(
        <rect key={`b${gi}-${si}`} x={x} y={top} width={barW - 2} height={h}
              fill={color} rx={2} />,
      )
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
  })

  return (
    <>
      {hasLegend && <LegendRow width={width} y={(spec.title ? 30 : 6) + 18} names={series.map(s => s.name)} />}
      <YAxis plot={plot} axis={axis} label={spec.y_label} />
      {els}
      <XAxisTitle plot={plot} height={height} label={spec.x_label} />
    </>
  )
}

function LineChart({ spec, width, height }: { spec: Extract<ChartSpec, { type: "line" }>; width: number; height: number }) {
  const { series } = spec.data
  const allPoints = series.flatMap(s => s.points)
  if (!allPoints.length) {
    return (
      <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={14}
            className="chart-tick">no data</text>
    )
  }
  const hasLegend = series.length > 1

  const xsNumeric = allPoints.every(p => typeof p.x === "number")
  let xMin = 0, xMax = 1
  let categories: string[] | undefined
  if (xsNumeric) {
    xMin = Math.min(...allPoints.map(p => p.x as number))
    xMax = Math.max(...allPoints.map(p => p.x as number))
    if (xMin === xMax) xMax = xMin + 1
  } else {
    const seen = new Map<string, number>()
    allPoints.forEach(p => { const k = String(p.x); if (!seen.has(k)) seen.set(k, seen.size) })
    categories = Array.from(seen.keys())
    xMin = 0; xMax = Math.max(1, categories.length - 1)
  }

  const plot = computePlot(width, height, !!spec.title, hasLegend, true, false, !!spec.y_label, !!spec.x_label)

  let yMin = Infinity, yMax = -Infinity
  allPoints.forEach(p => { if (!Number.isFinite(p.y)) return; if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y })
  if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1 }
  const yAxis = niceAxis(yMin, yMax)

  const xToPx = (x: number | string) => {
    const xv = xsNumeric ? (x as number) : categories!.indexOf(String(x))
    return plot.left + ((xv - xMin) / (xMax - xMin)) * plot.w
  }
  const yToPx = (y: number) => plot.bottom - ((y - yAxis.min) / (yAxis.max - yAxis.min)) * plot.h

  const xTickCount = Math.min(8, xsNumeric ? 6 : Math.max(2, categories!.length))
  const xTicks: ReactNode[] = []
  for (let i = 0; i < xTickCount; i++) {
    const t = xMin + ((xMax - xMin) * i) / (xTickCount - 1)
    const px = plot.left + ((t - xMin) / (xMax - xMin)) * plot.w
    let label: string
    if (xsNumeric) {
      if (t > 1e9) {
        const d = new Date(t * 1000)
        label = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`
      } else label = fmtNumber(t)
    } else label = categories![Math.round(t)] ?? ""
    xTicks.push(
      <line key={`xt${i}`} x1={px} y1={plot.bottom} x2={px} y2={plot.bottom + 4}
            className="chart-axis-line" />,
      <text key={`xl${i}`} x={px} y={plot.bottom + 18} textAnchor="middle"
            fontSize={TICK_SIZE} className="chart-tick">{label}</text>,
    )
  }

  const lines: ReactNode[] = []
  series.forEach((s, si) => {
    const color = PALETTE[si % PALETTE.length]
    const pts = s.points.filter(p => Number.isFinite(p.y))
    if (!pts.length) return
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${xToPx(p.x).toFixed(2)} ${yToPx(p.y).toFixed(2)}`).join(" ")
    lines.push(
      <path key={`p${si}`} d={d} fill="none" stroke={color} strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round" />,
    )
    if (pts.length <= 80) {
      pts.forEach((p, i) => lines.push(
        <circle key={`d${si}-${i}`} cx={xToPx(p.x)} cy={yToPx(p.y)} r={2.6} fill={color} />,
      ))
    }
  })

  return (
    <>
      {hasLegend && <LegendRow width={width} y={(spec.title ? 30 : 6) + 18} names={series.map(s => s.name)} />}
      <YAxis plot={plot} axis={yAxis} label={spec.y_label} />
      {xTicks}
      {lines}
      <XAxisTitle plot={plot} height={height} label={spec.x_label} />
    </>
  )
}

function defaultSize(type: ChartSpec["type"]): { width: number; height: number } {
  if (type === "pie") return { width: 760, height: 480 }
  return { width: 900, height: 520 }
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
  // Fill opaque white so PNGs pasted into WeChat/QQ don't show a transparent
  // halo when the theme background was dark — chart-bg already paints, but
  // anti-aliased edges can leak through without this base.
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/png")
  })
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

interface ChartRendererProps {
  spec: ChartSpec
  className?: string
  style?: CSSProperties
}

export function ChartRenderer({ spec, className, style }: ChartRendererProps) {
  const def = defaultSize(spec.type)
  const width = spec.width ?? def.width
  const height = spec.height ?? def.height
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [status, setStatus] = useState<null | { kind: "ok" | "err"; text: string }>(null)

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
      flash("ok", "已下载 PNG")
    } catch {
      flash("err", "下载失败")
    }
  }, [spec.title, spec.type, flash])

  const onCopy = useCallback(async () => {
    if (!svgRef.current) return
    try {
      const blob = await svgToPngBlob(svgRef.current, 2)
      const ok = await copyBlobToClipboard(blob)
      if (ok) flash("ok", "已复制图片，可直接粘贴到微信/QQ")
      else {
        downloadBlob(blob, "chart.png")
        flash("ok", "浏览器不支持复制图片，已改为下载 PNG")
      }
    } catch {
      flash("err", "复制失败")
    }
  }, [flash])

  return (
    <div
      className={`chart-host group relative my-3 w-full ${THEME_CLASSES} ${className ?? ""}`}
      style={{ lineHeight: 0, ...style }}
    >
      <svg
        ref={svgRef}
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height="auto"
        preserveAspectRatio="xMidYMid meet"
        fontFamily="ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"
        style={{ display: "block" }}
      >
        <rect width={width} height={height} className="chart-bg" />
        <Title text={spec.title} width={width} />
        {spec.type === "pie" && <PieChart spec={spec} width={width} height={height} />}
        {spec.type === "bar" && <BarChart spec={spec} width={width} height={height} />}
        {spec.type === "line" && <LineChart spec={spec} width={width} height={height} />}
      </svg>
      <div
        className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
        style={{ lineHeight: "normal" }}
      >
        <button
          type="button"
          onClick={onCopy}
          aria-label="复制为 PNG 图片到剪贴板"
          title="复制为 PNG 图片到剪贴板"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/90 dark:bg-slate-800/90 text-gray-700 dark:text-gray-100 border border-gray-200 dark:border-slate-700 shadow-sm hover:bg-white dark:hover:bg-slate-800"
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
          aria-label="下载 PNG 文件"
          title="下载 PNG 文件"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/90 dark:bg-slate-800/90 text-gray-700 dark:text-gray-100 border border-gray-200 dark:border-slate-700 shadow-sm hover:bg-white dark:hover:bg-slate-800"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>
      {status && (
        <div
          className={`absolute left-1/2 top-2 -translate-x-1/2 rounded-md px-2.5 py-1 text-xs shadow-sm ${
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
  )
}

export function tryParseChartSpec(raw: string): ChartSpec | null {
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== "object") return null
    if (obj.type !== "pie" && obj.type !== "bar" && obj.type !== "line") return null
    if (!obj.data || typeof obj.data !== "object") return null
    return obj as ChartSpec
  } catch {
    return null
  }
}
