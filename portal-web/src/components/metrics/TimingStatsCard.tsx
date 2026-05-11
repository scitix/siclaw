/**
 * Per-metric latency statistics card for the Metrics dashboard.
 *
 * Two sections:
 *   • Model — ⏳ TTFT, 💭 Thinking
 *   • Tools — top-N tools by invocation count, default top 3, selector for
 *     3 / 5 / 10. Switching N is a client-side slice (no extra request);
 *     backend always returns the full sorted list.
 *
 * Numbers come from /api/v1/siclaw/metrics/timing — same per-message timing
 * fields the chat UI shows as ⏳/💭/⚙️ badges. Whatever is summed in chat
 * for a turn is what gets aggregated here for the period.
 */
import { useState } from "react"
import type { LatencyStats, TimingStats, ToolLatencyStats } from "../../hooks/useMetrics"

interface Props {
  data: TimingStats | null
  period: "today" | "7d" | "30d"
}

const PERIOD_LABEL: Record<Props["period"], string> = {
  today: "today",
  "7d": "last 7 days",
  "30d": "last 30 days",
}

const TOP_OPTIONS = [3, 5, 10] as const
type TopN = typeof TOP_OPTIONS[number]

/** Match the chat-bubble badge formatter so dashboard reads agree with chat. */
function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

const MODEL_ROWS: Array<{ key: "ttft" | "thinking"; emoji: string; label: string; hint: string }> = [
  { key: "ttft", emoji: "⏳", label: "TTFT", hint: "first token" },
  { key: "thinking", emoji: "💭", label: "Thinking", hint: "boundary → first token" },
]

export function TimingStatsCard({ data, period }: Props) {
  const [topN, setTopN] = useState<TopN>(3)
  const tools = data?.tools ?? []
  const visibleTools = tools.slice(0, topN)

  return (
    <div className="border border-border rounded-lg bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Latency Breakdown</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            avg · min · max · p90 · {PERIOD_LABEL[period]}
          </p>
        </div>
        {data?.truncated && (
          <span
            title="Query hit the row-scan cap; figures are a recency-biased sample, not the full window."
            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-500 select-text"
          >
            sampled
          </span>
        )}
      </div>

      {/* ── Model section: ⏳ + 💭 ───────────────────── */}
      <StatGrid>
        <GridHeader />
        {MODEL_ROWS.map((row) => {
          const stats: LatencyStats = data?.[row.key] ?? { count: 0, avg: 0, min: 0, max: 0, p90: 0 }
          const empty = stats.count === 0
          return <Row key={row.key} emoji={row.emoji} label={row.label} hint={row.hint} stats={stats} empty={empty} />
        })}
      </StatGrid>

      {/* ── Tools section: top-N by invocation count ─── */}
      <div className="mt-4 pt-3 border-t border-border">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {/* Larger gear marks the section header — mirrors the chat
                bubble's ⚙️ but at twice the body-text size for visual weight. */}
            <span className="text-[13px] leading-none select-none" aria-hidden="true">⚙️</span>
            <div className="flex items-baseline gap-2">
              <h4 className="text-[11px] font-semibold text-foreground">Tools</h4>
              <span className="text-[10px] text-muted-foreground">
                top {Math.min(topN, tools.length)} of {tools.length} · by invocation count
              </span>
            </div>
          </div>
          {/* Slice selector — pure client-side, no re-fetch needed. */}
          <div className="flex items-center gap-1">
            {TOP_OPTIONS.map((n) => (
              <button
                key={n}
                onClick={() => setTopN(n)}
                className={
                  "px-2 py-0.5 text-[11px] rounded-md border transition-colors " +
                  (topN === n
                    ? "border-blue-500 bg-blue-500/10 text-blue-400"
                    : "border-border bg-secondary text-muted-foreground hover:text-foreground")
                }
              >
                Top {n}
              </button>
            ))}
          </div>
        </div>

        {visibleTools.length === 0 ? (
          <div className="text-[11px] text-muted-foreground/70 py-2 select-text">
            No tool executions in this window.
          </div>
        ) : (
          <StatGrid>
            <GridHeader />
            {visibleTools.map((tool) => {
              const empty = tool.count === 0
              return (
                <Row
                  // 🔧 wrench distinguishes individual tool rows from the
                  // ⚙️ gear used for the section header — same family of
                  // "tool" iconography, different role.
                  key={tool.toolName}
                  emoji="🔧"
                  label={tool.toolName}
                  hint="tool execution"
                  stats={tool}
                  empty={empty}
                />
              )
            })}
          </StatGrid>
        )}
      </div>
    </div>
  )
}

function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_repeat(5,minmax(0,1fr))] gap-x-4 gap-y-1 items-baseline text-[12px]">
      {children}
    </div>
  )
}

function GridHeader() {
  return (
    <>
      <div />
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground text-right">avg</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground text-right">min</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground text-right">max</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground text-right">p90</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground text-right">n</div>
    </>
  )
}

function Row({ emoji, label, hint, stats, empty }: {
  emoji: string; label: string; hint: string; stats: LatencyStats | ToolLatencyStats; empty: boolean
}) {
  return (
    <>
      <div className="py-1.5 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-base leading-none select-text">{emoji}</span>
          <div className="min-w-0">
            <div className="font-medium text-foreground truncate select-text" title={label}>{label}</div>
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
