interface Point { date: string; value: number }

interface Props {
  title: string
  subtitle: string
  data: Point[]
  color: string // hex, e.g. "#34d399"
}

// viewBox geometry — the SVG scales to its container width, so these are
// abstract units, not pixels.
const VBW = 640
const VBH = 220
const PAD = { left: 34, right: 12, top: 14, bottom: 26 }
const PLOT_W = VBW - PAD.left - PAD.right
const PLOT_H = VBH - PAD.top - PAD.bottom

/** Catmull-Rom → cubic-bezier so the line reads as a smooth curve. */
function smoothLine(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return ""
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`
  let d = `M${pts[0].x},${pts[0].y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? pts[i + 1]
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
  }
  return d
}

export function TrendChart({ title, subtitle, data, color }: Props) {
  const n = data.length
  const values = data.map((d) => d.value)
  const maxV = Math.max(...values, 1)
  const step = Math.max(1, Math.ceil(maxV / 4))
  const axisMax = step * 4
  const ticks = [0, 1, 2, 3, 4].map((k) => k * step)

  const xAt = (i: number) => (n > 1 ? PAD.left + (i / (n - 1)) * PLOT_W : PAD.left + PLOT_W / 2)
  const yAt = (v: number) => PAD.top + (1 - v / axisMax) * PLOT_H

  const pts = data.map((d, i) => ({ x: xAt(i), y: yAt(d.value) }))
  const linePath = smoothLine(pts)
  const baseY = PAD.top + PLOT_H
  const areaPath = pts.length
    ? `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${baseY} L${pts[0].x.toFixed(1)},${baseY} Z`
    : ""

  // X labels: ≤8 points show all; otherwise ~7 evenly-spaced indices (the even
  // division naturally includes first + last without forcing an adjacent last
  // tick, which is what made the 30-day axis collide at the right edge).
  const labelIdx = n <= 8
    ? data.map((_, i) => i)
    : [...new Set(Array.from({ length: 7 }, (_, k) => Math.round((k * (n - 1)) / 6)))]
  const gradId = `trend-grad-${color.replace("#", "")}`

  const total = values.reduce((s, v) => s + v, 0)
  const avg = n > 0 ? total / n : 0
  const peak = Math.max(...values, 0)

  return (
    <div className="border border-border rounded-lg bg-card p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <span className="text-[11px] text-muted-foreground">{subtitle}</span>
      </div>

      <svg viewBox={`0 0 ${VBW} ${VBH}`} className="w-full h-auto" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>

        {/* Y gridlines + labels */}
        {ticks.map((t) => {
          const y = yAt(t)
          return (
            <g key={t}>
              <line x1={PAD.left} y1={y} x2={VBW - PAD.right} y2={y} stroke="currentColor" strokeOpacity={0.08} strokeWidth={1} />
              <text x={PAD.left - 6} y={y + 3} textAnchor="end" className="fill-current text-muted-foreground" fontSize={10}>{t}</text>
            </g>
          )
        })}

        {/* Area + line */}
        {areaPath && <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />}
        {linePath && <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}

        {/* X labels — "MM-DD" only (year is redundant within the window and the
            full date overflowed); edges anchored inward so they don't clip. */}
        {labelIdx.map((i) => (
          <text
            key={data[i].date}
            x={xAt(i)}
            y={VBH - 8}
            textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
            className="fill-current text-muted-foreground"
            fontSize={10}
          >
            {data[i].date.slice(5)}
          </text>
        ))}
      </svg>

      <div className="flex items-center gap-4 mt-2 text-[11px] text-muted-foreground">
        <span>Total <span className="text-foreground font-medium tabular-nums">{total.toLocaleString()}</span></span>
        <span>Daily avg <span className="text-foreground font-medium tabular-nums">{avg.toFixed(1)}</span></span>
        <span>Peak <span className="text-foreground font-medium tabular-nums">{peak.toLocaleString()}</span></span>
      </div>
    </div>
  )
}
