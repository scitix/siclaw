/**
 * Per-metric latency statistics card for the Metrics dashboard.
 *
 * Renders three rows — ⏳ TTFT, 💭 Thinking, ⚙️ Bash — each with avg / min /
 * max / p90 columns. Numbers come from /api/v1/siclaw/metrics/timing which
 * aggregates the same per-message timing fields the chat UI shows as badges.
 */
import type { LatencyStats, TimingStats } from "../../hooks/useMetrics"

interface Props {
  data: TimingStats | null
  period: "today" | "7d" | "30d"
}

const PERIOD_LABEL: Record<Props["period"], string> = {
  today: "today",
  "7d": "last 7 days",
  "30d": "last 30 days",
}

/** Match the chat-bubble badge formatter so dashboard reads agree with chat. */
function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

const ROWS: Array<{ key: keyof TimingStats; emoji: string; label: string; hint: string }> = [
  { key: "ttft", emoji: "⏳", label: "TTFT", hint: "first token" },
  { key: "thinking", emoji: "💭", label: "Thinking", hint: "boundary → first token" },
  { key: "bash", emoji: "⚙️", label: "Bash", hint: "tool execution" },
]

export function TimingStatsCard({ data, period }: Props) {
  return (
    <div className="border border-border rounded-lg bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Latency Breakdown</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            avg · min · max · p90 · {PERIOD_LABEL[period]}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-[auto_repeat(5,minmax(0,1fr))] gap-x-4 gap-y-1 items-baseline text-[12px]">
        {/* Header */}
        <div />
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground text-right">avg</div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground text-right">min</div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground text-right">max</div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground text-right">p90</div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground text-right">n</div>
        {ROWS.map((row) => {
          const stats: LatencyStats = data?.[row.key] ?? { count: 0, avg: 0, min: 0, max: 0, p90: 0 }
          const empty = stats.count === 0
          return (
            <Row key={row.key} emoji={row.emoji} label={row.label} hint={row.hint} stats={stats} empty={empty} />
          )
        })}
      </div>
    </div>
  )
}

function Row({ emoji, label, hint, stats, empty }: {
  emoji: string; label: string; hint: string; stats: LatencyStats; empty: boolean
}) {
  return (
    <>
      <div className="py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-base leading-none select-text">{emoji}</span>
          <div>
            <div className="font-medium text-foreground">{label}</div>
            <div className="text-[10px] text-muted-foreground -mt-0.5">{hint}</div>
          </div>
        </div>
      </div>
      <Cell value={stats.avg} empty={empty} />
      <Cell value={stats.min} empty={empty} />
      <Cell value={stats.max} empty={empty} />
      <Cell value={stats.p90} empty={empty} />
      <div className={`font-mono tabular-nums text-right py-1.5 select-text ${empty ? "text-muted-foreground/50" : "text-muted-foreground"}`}>
        {empty ? "—" : stats.count.toLocaleString()}
      </div>
    </>
  )
}

function Cell({ value, empty }: { value: number; empty: boolean }) {
  return (
    <div className={`font-mono tabular-nums text-right py-1.5 select-text ${empty ? "text-muted-foreground/50" : "text-foreground"}`}>
      {empty ? "—" : fmtMs(value)}
    </div>
  )
}
