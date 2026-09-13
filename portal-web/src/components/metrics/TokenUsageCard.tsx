import type { TokenFieldTotals, TokenUsageData, UsageSortKey } from "../../hooks/useMetrics"

/**
 * Token spend per provider × model, and per actor.
 *
 * Two rendering rules carry the whole point of the pipeline behind this:
 *
 *   - A field nothing reported shows "—", never 0. The collection side went to
 *     some length to keep those apart; painting a dash as a zero here would
 *     undo it at the last step.
 *   - A number summed over FEWER calls than the row has says so. Otherwise a
 *     partial sum is indistinguishable from a complete one.
 */

const COLUMNS: { key: UsageSortKey; label: string; hint: string }[] = [
  { key: "input", label: "Input", hint: "prompt tokens as the provider reported them" },
  { key: "output", label: "Output", hint: "completion tokens, reasoning included" },
  { key: "cacheWrite", label: "Cache write", hint: "tokens written into the prompt cache" },
  { key: "cacheRead", label: "Cache read", hint: "tokens served from the prompt cache" },
  { key: "billable", label: "Charged", hint: "per-protocol total; cache is inside input on some APIs" },
  { key: "calls", label: "Calls", hint: "model calls with provider-reported usage" },
]

function fmtTokens(n: number | null): string {
  if (n === null) return "—"
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** A cell that can say "nothing reported" and "reported by only some calls". */
function TokenCell({ value, calls }: { value: TokenFieldTotals; calls: number }) {
  const missing = value.total === null
  const partial = !missing && value.reportedCalls < calls
  return (
    <div
      className={`text-right tabular-nums ${missing ? "text-muted-foreground/50" : "text-foreground"}`}
      title={
        missing
          ? "No call in this row reported this field — not the same as zero"
          : partial
          ? `Summed over ${value.reportedCalls} of ${calls} calls; the rest never reported this field`
          : undefined
      }
    >
      {fmtTokens(value.total)}
      {partial && <span className="text-amber-500 ml-0.5">*</span>}
    </div>
  )
}

function SortableHead({
  column, active, onSort,
}: {
  column: { key: UsageSortKey; label: string; hint: string }
  active: UsageSortKey
  onSort: (key: UsageSortKey) => void
}) {
  const isActive = active === column.key
  return (
    <button
      type="button"
      onClick={() => onSort(column.key)}
      title={column.hint}
      className={`text-right text-[11px] hover:text-foreground transition-colors ${
        isActive ? "text-foreground font-medium" : "text-muted-foreground"
      }`}
    >
      {column.label}
      {isActive && <span className="ml-0.5">↓</span>}
    </button>
  )
}

const GRID = "grid grid-cols-[minmax(9rem,1.6fr)_repeat(6,minmax(4.25rem,0.7fr))] gap-x-3 gap-y-1.5 text-[11px] items-center"

export function TokenUsageCard({
  data, loading, rangeLabel, sort, onSort,
}: {
  data: TokenUsageData | null
  loading: boolean
  rangeLabel: string
  sort: UsageSortKey
  onSort: (key: UsageSortKey) => void
}) {
  const models = data?.models ?? []
  const actors = data?.actors ?? []
  const coverage = data?.coverage
  const anyPartial =
    models.some((g) => [g.input, g.output, g.cacheRead, g.cacheWrite].some((f) => f.total !== null && f.reportedCalls < g.calls)) ||
    actors.some((a) => [a.input, a.output, a.cacheRead, a.cacheWrite].some((f) => f.total !== null && f.reportedCalls < a.calls))

  return (
    <div className="border border-border rounded-lg bg-card p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Token usage</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Per call, sub-agents included · {rangeLabel}
          </p>
        </div>
        {coverage && coverage.excluded > 0 && (
          <span
            title={`${coverage.excluded} call(s) excluded: the provider reported no usage, or its provenance could not be established. Including them would count their placeholder zeros as real.`}
            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-500 select-text"
          >
            {coverage.trustworthy}/{coverage.trustworthy + coverage.excluded} measured
          </span>
        )}
      </div>

      {loading && !data ? (
        <p className="text-[11px] text-muted-foreground py-6 text-center">Loading…</p>
      ) : models.length === 0 && actors.length === 0 ? (
        <p className="text-[11px] text-muted-foreground py-6 text-center">
          No measured calls in this window.
        </p>
      ) : (
        <>
          <div className={GRID}>
            <div className="text-muted-foreground">Provider · model</div>
            {COLUMNS.map((c) => (
              <SortableHead key={c.key} column={c} active={sort} onSort={onSort} />
            ))}
            {models.map((g) => (
              <Row
                key={`${g.provider}/${g.modelId}/${g.apiType}`}
                label={g.modelId}
                sub={`${g.provider} · ${g.apiType}`}
                row={g}
              />
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-border">
            <h4 className="text-[11px] font-semibold text-foreground mb-2">By user</h4>
            {actors.length === 0 ? (
              <p className="text-[11px] text-muted-foreground py-2">No attributable calls in this window.</p>
            ) : (
              <div className={GRID}>
                <div className="text-muted-foreground">User</div>
                {COLUMNS.map((c) => (
                  <SortableHead key={c.key} column={c} active={sort} onSort={onSort} />
                ))}
                {actors.map((a) => (
                  <Row
                    key={`${a.kind}:${a.id}`}
                    label={a.id}
                    sub={a.kind === "channel" ? "channel sender" : "platform user"}
                    row={a}
                    note={a.mixedProtocols ? "Calls span protocols that bill cache differently" : undefined}
                  />
                ))}
              </div>
            )}
          </div>

          {anyPartial && (
            <p className="text-[10px] text-muted-foreground mt-3">
              <span className="text-amber-500">*</span> summed over only the calls that reported that
              field — hover for the count.
            </p>
          )}
        </>
      )}
    </div>
  )
}

function Row({
  label, sub, row, note,
}: {
  label: string
  sub: string
  note?: string
  row: {
    calls: number
    input: TokenFieldTotals
    output: TokenFieldTotals
    cacheRead: TokenFieldTotals
    cacheWrite: TokenFieldTotals
    billable: number | null
  }
}) {
  return (
    <>
      <div className="min-w-0" title={note}>
        <div className="truncate font-medium text-foreground">
          {label}
          {note && <span className="text-amber-500 ml-1">†</span>}
        </div>
        <div className="truncate text-[10px] text-muted-foreground">{sub}</div>
      </div>
      <TokenCell value={row.input} calls={row.calls} />
      <TokenCell value={row.output} calls={row.calls} />
      <TokenCell value={row.cacheWrite} calls={row.calls} />
      <TokenCell value={row.cacheRead} calls={row.calls} />
      <div
        className={`text-right tabular-nums ${row.billable === null ? "text-muted-foreground/50" : "text-foreground font-medium"}`}
        title={row.billable === null ? "A component this protocol charges for was never reported, so the total is unknown" : undefined}
      >
        {fmtTokens(row.billable)}
      </div>
      <div className="text-right tabular-nums text-muted-foreground">{row.calls}</div>
    </>
  )
}
