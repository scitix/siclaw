/**
 * Grafana-style time range picker for the Metrics dashboard.
 *
 * A trigger button shows the current range label; clicking opens a popover with
 *   • left  — absolute From/To text inputs (accept `now-30m` or `2026-06-15 10:30`)
 *             plus a dependency-free mini month calendar that sets the date part
 *   • right — quick relative ranges (searchable list)
 *
 * The picker only ever emits a `TimeRange` of literal expressions/ISO strings —
 * resolution to absolute ms happens in the data hooks (`resolveRange`), so a
 * relative range stays relative (slides) and an absolute one stays fixed.
 *
 * Hand-rolled (no shadcn/radix/date-fns in this repo): popover is an absolute
 * panel closed on outside `mousedown`; the calendar is plain `Date` math.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Clock, ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react"
import { QUICK_RANGES, isValidRange, rangeLabel, type TimeRange } from "../../hooks/useMetrics"

interface Props {
  value: TimeRange
  onChange: (r: TimeRange) => void
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export interface MonthCell { day: number; inMonth: boolean; iso: string }

/** Build a 6×7 (42-cell) grid for `month` (0-based) of `year`, padded with the
 *  surrounding days so the first column is always Sunday. Pure — unit-tested. */
export function buildMonthGrid(year: number, month: number): MonthCell[] {
  const startOffset = new Date(year, month, 1).getDay() // Sunday = 0
  const cells: MonthCell[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - startOffset + i)
    const p = (n: number) => String(n).padStart(2, "0")
    cells.push({
      day: d.getDate(),
      inMonth: d.getMonth() === month,
      iso: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    })
  }
  return cells
}

/** Pull the time-of-day `HH:mm` out of a draft like "2026-06-15 10:30",
 *  "2026-06-15 10:30:45", or an ISO "2026-06-15T10:30:45Z" (seconds and timezone
 *  are dropped), else "". Split on the date/time separator first so the segment
 *  match never picks up the seconds field — a trailing-anchored regex on
 *  "10:30:45" would otherwise yield "30:45" and corrupt the field. Exported for
 *  unit tests. */
export function extractTime(v: string): string {
  const seg = v.trim().split(/[ T]+/)[1] ?? ""
  const m = /^(\d{1,2}:\d{2})/.exec(seg)
  return m ? m[1] : ""
}

export function TimeRangePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const [fromDraft, setFromDraft] = useState(value.from)
  const [toDraft, setToDraft] = useState(value.to)
  const [activeField, setActiveField] = useState<"from" | "to">("from")
  const [search, setSearch] = useState("")

  const today = useMemo(() => new Date(), [])
  const [calYear, setCalYear] = useState(today.getFullYear())
  const [calMonth, setCalMonth] = useState(today.getMonth())

  // Re-seed drafts each time the popover opens or the committed value changes.
  useEffect(() => {
    if (open) { setFromDraft(value.from); setToDraft(value.to) }
  }, [open, value.from, value.to])

  // Outside-click close (mousedown, only while open). The trigger lives inside
  // rootRef too, so one containment check covers trigger + panel.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  const draft: TimeRange = { from: fromDraft.trim(), to: toDraft.trim() }
  const draftValid = isValidRange(draft)

  const filteredRanges = QUICK_RANGES.filter((r) =>
    r.label.toLowerCase().includes(search.trim().toLowerCase()),
  )

  const pickQuick = (from: string) => {
    onChange({ from, to: "now" })
    setSearch("")
    setOpen(false)
  }

  const applyAbsolute = () => {
    if (!draftValid) return
    onChange(draft)
    setOpen(false)
  }

  const pickDay = (iso: string) => {
    const cur = activeField === "from" ? fromDraft : toDraft
    const time = extractTime(cur)
    const next = `${iso} ${time || "00:00"}`
    if (activeField === "from") { setFromDraft(next); setActiveField("to") }
    else setToDraft(next)
  }

  const grid = buildMonthGrid(calYear, calMonth)
  const prevMonth = () => {
    if (calMonth === 0) { setCalMonth(11); setCalYear(calYear - 1) } else setCalMonth(calMonth - 1)
  }
  const nextMonth = () => {
    if (calMonth === 11) { setCalMonth(0); setCalYear(calYear + 1) } else setCalMonth(calMonth + 1)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="h-8 px-2.5 inline-flex items-center gap-1.5 text-[12px] rounded-md bg-secondary border border-border text-foreground hover:border-blue-500/60 focus:outline-none focus:border-blue-500"
      >
        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        <span>{rangeLabel(value)}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute right-0 mt-1 z-20 w-[480px] rounded-lg border border-border bg-card shadow-xl">
          <div className="grid grid-cols-[1fr_200px]">
            {/* ── Absolute editor ─────────────────────── */}
            <div className="p-3 border-r border-border">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Absolute time range</h4>

              <label className="block text-[11px] text-muted-foreground mb-1">From</label>
              <input
                value={fromDraft}
                onChange={(e) => setFromDraft(e.target.value)}
                onFocus={() => setActiveField("from")}
                placeholder="now-7d or 2026-06-15 10:30"
                className={`w-full h-8 px-2 mb-2 text-[12px] rounded-md bg-secondary border text-foreground focus:outline-none ${activeField === "from" ? "border-blue-500" : "border-border"}`}
              />

              <label className="block text-[11px] text-muted-foreground mb-1">To</label>
              <input
                value={toDraft}
                onChange={(e) => setToDraft(e.target.value)}
                onFocus={() => setActiveField("to")}
                placeholder="now"
                className={`w-full h-8 px-2 mb-2 text-[12px] rounded-md bg-secondary border text-foreground focus:outline-none ${activeField === "to" ? "border-blue-500" : "border-border"}`}
              />

              {/* Mini calendar — sets the date portion of the active field. */}
              <div className="mt-1 mb-2">
                <div className="flex items-center justify-between mb-1">
                  <button onClick={prevMonth} className="p-1 rounded hover:bg-secondary text-muted-foreground" aria-label="Previous month"><ChevronLeft className="h-3.5 w-3.5" /></button>
                  <span className="text-[12px] font-medium">{MONTHS[calMonth]} {calYear}</span>
                  <button onClick={nextMonth} className="p-1 rounded hover:bg-secondary text-muted-foreground" aria-label="Next month"><ChevronRight className="h-3.5 w-3.5" /></button>
                </div>
                <div className="grid grid-cols-7 gap-0.5 text-center">
                  {WEEKDAYS.map((w) => (
                    <div key={w} className="text-[10px] text-muted-foreground py-0.5">{w}</div>
                  ))}
                  {grid.map((c, i) => (
                    <button
                      key={i}
                      onClick={() => pickDay(c.iso)}
                      className={`text-[11px] py-1 rounded hover:bg-blue-500/20 ${c.inMonth ? "text-foreground" : "text-muted-foreground/40"}`}
                    >
                      {c.day}
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={applyAbsolute}
                disabled={!draftValid}
                className="w-full h-8 text-[12px] rounded-md bg-blue-500 text-white font-medium hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Apply time range
              </button>
              {!draftValid && (
                <p className="mt-1 text-[10px] text-red-400">Enter a valid range (from must be before to).</p>
              )}
            </div>

            {/* ── Quick ranges ────────────────────────── */}
            <div className="p-3 flex flex-col">
              <div className="relative mb-2">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search…"
                  className="w-full h-7 pl-7 pr-2 text-[12px] rounded-md bg-secondary border border-border text-foreground focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex flex-col overflow-y-auto max-h-[260px] -mr-1 pr-1">
                {filteredRanges.length === 0 ? (
                  <div className="text-[11px] text-muted-foreground py-2 text-center">No matches</div>
                ) : filteredRanges.map((r) => {
                  const active = value.to === "now" && value.from === r.from
                  return (
                    <button
                      key={r.key}
                      onClick={() => pickQuick(r.from)}
                      className={`text-left text-[12px] px-2 py-1.5 rounded-md hover:bg-secondary ${active ? "bg-secondary text-blue-400 font-medium" : "text-foreground"}`}
                    >
                      {r.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
