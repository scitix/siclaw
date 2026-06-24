import { useState, type ReactNode } from "react"
import type { LatencyStats, TimingStats, ToolLatencyStats } from "../../hooks/useMetrics"

type TopN = 3 | 5 | 10
const TOP_OPTIONS: TopN[] = [3, 5, 10]

const EMPTY_STATS: LatencyStats = { count: 0, avg: 0, min: 0, max: 0, p90: 0 }

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,1.4fr)_repeat(5,minmax(3.75rem,0.65fr))] gap-x-3 gap-y-1.5 text-[11px] items-center">
      {children}
    </div>
  )
}

function GridHeader() {
  return (
    <>
      <div className="text-muted-foreground">Metric</div>
      <div className="text-muted-foreground text-right">Count</div>
      <div className="text-muted-foreground text-right">Avg</div>
      <div className="text-muted-foreground text-right">Min</div>
      <div className="text-muted-foreground text-right">Max</div>
      <div className="text-muted-foreground text-right">P90</div>
    </>
  )
}

function StatRow({ label, hint, stats }: { label: string; hint: string; stats: LatencyStats }) {
  const empty = stats.count === 0
  const cell = (v: string) => (
    <div className={`text-right tabular-nums ${empty ? "text-muted-foreground/50" : "text-foreground"}`}>
      {empty ? "-" : v}
    </div>
  )
  return (
    <>
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground">{label}</div>
        <div className="truncate text-[10px] text-muted-foreground">{hint}</div>
      </div>
      <div className="text-right tabular-nums text-foreground">{stats.count}</div>
      {cell(fmtMs(stats.avg))}
      {cell(fmtMs(stats.min))}
      {cell(fmtMs(stats.max))}
      {cell(fmtMs(stats.p90))}
    </>
  )
}

/**
 * TTFT / thinking / per-tool latency card — count/avg/min/max/p90 from
 * chat_messages timing metadata + tool duration.
 */
export function TimingStatsCard({
  data,
  rangeLabel,
  entryLabel,
}: {
  data: TimingStats | null
  rangeLabel: string
  entryLabel: string
}) {
  const [topN, setTopN] = useState<TopN>(3)
  const tools = data?.tools ?? []
  const visibleTools: ToolLatencyStats[] = tools.slice(0, topN)

  return (
    <div className="border border-border rounded-lg bg-card p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Response timing</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {entryLabel} · {rangeLabel}
          </p>
        </div>
        {data?.truncated && (
          <span
            title="Sampled — too many rows in window; figures from a capped sample"
            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-500 select-text"
          >
            Sampled
          </span>
        )}
      </div>

      <StatGrid>
        <GridHeader />
        <StatRow label="TTFT" hint="time to first token" stats={data?.ttft ?? EMPTY_STATS} />
        <StatRow label="Thinking" hint="reasoning before output" stats={data?.thinking ?? EMPTY_STATS} />
      </StatGrid>

      <div className="mt-4 pt-3 border-t border-border">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div>
            <h4 className="text-[11px] font-semibold text-foreground">Tool latency</h4>
            <p className="text-[10px] text-muted-foreground">
              Showing {Math.min(topN, tools.length)} of {tools.length}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {TOP_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setTopN(n)}
                className={`px-2 py-0.5 text-[11px] rounded-md border transition-colors ${
                  topN === n
                    ? "border-blue-500 bg-blue-500/10 text-blue-400"
                    : "border-border bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                Top {n}
              </button>
            ))}
          </div>
        </div>

        {visibleTools.length === 0 ? (
          <div className="text-[11px] text-muted-foreground/70 py-2 select-text">No tool executions in this window.</div>
        ) : (
          <StatGrid>
            <GridHeader />
            {visibleTools.map((tool) => (
              <StatRow key={tool.toolName} label={tool.toolName} hint="tool execution" stats={tool} />
            ))}
          </StatGrid>
        )}
      </div>
    </div>
  )
}
