/** Shared interaction and layout; host wrappers supply product controls and translations. */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentType,
  type Ref,
} from "react"
import {
  ChevronDown,
  ChevronRight,
  Focus,
  HelpCircle,
  Languages,
  RotateCcw,
} from "lucide-react"
import {
  formatTraceMs,
  traceDomain,
  traceSummary,
  type TraceSelection,
  type TraceSpan,
  type WaterfallSpec,
} from "./waterfall-spec"

import {
  TRACE_EN,
  type TraceLabels,
  type TraceLanguagePreference,
} from "./trace-locale"
export { TRACE_EN, TRACE_ZH, type TraceLabels } from "./trace-locale"

export function traceStatusLabel(span: TraceSpan, labels: TraceLabels): string {
  const status = {
    ok: labels.statusOk,
    error: labels.statusError,
    cancelled: labels.statusCancelled,
    unset: labels.statusUnset,
    unknown: labels.unknown,
  }[span.status]
  return span.http_status ? `HTTP ${span.http_status} · ${status}` : status
}
export function traceLayout(width: number) {
  const split = width >= 980
  const chartWidth = Math.max(0, width - (split ? 304 : 0))
  const narrow = chartWidth < 580
  return {
    split,
    chartWidth,
    narrow,
    left: narrow ? 0 : chartWidth < 720 ? 170 : 190,
    right: narrow ? 0 : 84,
  }
}
export function TraceLanguageSelect({
  preference,
  labels,
  onChange,
}: {
  preference: TraceLanguagePreference
  labels: TraceLabels
  onChange: (value: TraceLanguagePreference) => void
}) {
  return (
    <label
      className="trace-language inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground"
      title={labels.language}
    >
      <Languages className="h-3.5 w-3.5" aria-hidden="true" />
      <select
        aria-label={labels.language}
        value={preference}
        className="min-w-0 cursor-pointer bg-transparent py-1.5 text-xs text-foreground focus-visible:outline focus-visible:outline-ring"
        onChange={(event) =>
          onChange(event.target.value as TraceLanguagePreference)
        }
      >
        <option value="auto">{labels.followPlatform}</option>
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
    </label>
  )
}

/** A bounded preview of observed intervals, never a sum of nested spans. */
export function compactTraceSpans(spec: WaterfallSpec): TraceSpan[] {
  const calls = spec.data.spans.filter((s) => s.layer === "http")
  const candidates = calls.length
    ? calls
    : spec.data.spans.length === 1
      ? spec.data.spans
      : spec.data.spans.filter((s) => s.span_id !== spec.data.root_span_id)
  return [...candidates]
    .sort((a, b) => {
      // Keep unfinished calls visible instead of treating them as zero duration.
      if (a.end_ms === null && b.end_ms !== null) return -1
      if (b.end_ms === null && a.end_ms !== null) return 1
      return (
        (b.end_ms ?? b.start_ms) -
        b.start_ms -
        ((a.end_ms ?? a.start_ms) - a.start_ms)
      )
    })
    .slice(0, 3)
    .sort(
      (a, b) => a.start_ms - b.start_ms || a.span_id.localeCompare(b.span_id),
    )
}

export function TracePreview({
  spec,
  labels,
}: {
  spec: WaterfallSpec
  labels: TraceLabels
}) {
  const [lo, hi] = traceDomain(spec)
  const extent = Math.max(0.001, hi - lo)
  return (
    <ul
      className="m-0 list-none space-y-1 p-0"
      data-trace-preview
      aria-label={labels.stages}
    >
      {compactTraceSpans(spec).map((span) => {
        const left = Math.max(
          0,
          Math.min(100, ((span.start_ms - lo) / extent) * 100),
        )
        const width =
          span.end_ms === null
            ? 0
            : Math.max(
                0,
                Math.min(
                  100 - left,
                  ((span.end_ms - span.start_ms) / extent) * 100,
                ),
              )
        return (
          <li
            key={span.span_id}
            className="grid min-w-0 grid-cols-[minmax(0,1.5fr)_minmax(32px,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_minmax(48px,1.5fr)_auto] items-center gap-3 text-xs leading-5"
          >
            <span
              className="flex min-w-0 items-center gap-1.5"
              title={`${span.label} · ${span.http_status ?? traceStatusLabel(span, labels)}`}
            >
              <span className="truncate text-muted-foreground">
                {span.label}
              </span>
              {(span.http_status !== undefined ||
                span.status === "error" ||
                span.status === "cancelled") && (
                <span
                  className={`shrink-0 font-mono text-[10px] ${span.status === "error" || (span.http_status ?? 0) >= 400 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}
                >
                  {span.http_status ?? traceStatusLabel(span, labels)}
                </span>
              )}
            </span>
            <span
              className="relative h-1.5 rounded-sm bg-secondary"
              aria-hidden="true"
            >
              <span
                className={`absolute top-0 h-full rounded-sm ${span.end_ms === null ? "border border-dashed border-muted-foreground" : span.status === "error" || (span.http_status ?? 0) >= 400 ? "bg-destructive/60" : "bg-foreground/55"}`}
                style={{
                  left: `min(${left}%, calc(100% - 2px))`,
                  width: `${width}%`,
                  minWidth: 2,
                  maxWidth: "100%",
                }}
              />
            </span>
            <span
              className="min-w-[4.5rem] text-right font-mono text-[11px] tabular-nums"
              title={span.end_ms === null ? labels.open : undefined}
            >
              {formatTraceMs(
                span.end_ms === null ? null : span.end_ms - span.start_ms,
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export function TraceCompactMeta({
  spec,
  labels,
}: {
  spec: WaterfallSpec
  labels: TraceLabels
}) {
  const root = spec.data.spans.find((s) => s.span_id === spec.data.root_span_id)
  const summary = traceSummary(spec)
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {root && (
        <span>
          {labels.root}{" "}
          <span className="font-mono tabular-nums text-foreground">
            {formatTraceMs(
              root.end_ms === null ? null : root.end_ms - root.start_ms,
            )}
          </span>
        </span>
      )}
      <span>
        {summary.http_calls} {labels.httpCalls}
      </span>
      <span>
        {spec.data.spans.length} {labels.spans}
      </span>
    </p>
  )
}
/** Compact disclosure keeps incomplete evidence visible before opening the chart. */
export function TraceCompactStatus({
  spec,
  labels,
}: {
  spec: WaterfallSpec
  labels: TraceLabels
}) {
  const summary = traceSummary(spec)
  const partial =
    !spec.data.coverage.complete ||
    spec.data.coverage.missing.length > 0 ||
    summary.open_spans > 0 ||
    summary.outside_root
  const missing = spec.data.coverage.missing
  return (
    <span
      className={`min-w-0 text-xs ${partial ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
      title={[
        ...missing,
        ...(summary.open_spans ? [labels.open] : []),
        ...(summary.outside_root ? [labels.outside] : []),
      ].join(" · ")}
    >
      {partial ? labels.partial : labels.observed}
      {missing.length > 0
        ? ` · ${missing.length} ${missing.length === 1 ? labels.gap : labels.gaps}`
        : summary.open_spans > 0
          ? ` · ${labels.open}`
          : ""}
    </span>
  )
}
export interface TraceViewState {
  range: [number, number]
  selected: string
  grouping: "attempt" | "parent"
  collapsed: Set<string>
}
export function initialTraceView(spec: WaterfallSpec): TraceViewState {
  const longest = [...spec.data.spans]
    .filter((s) => s.layer === "http" && s.end_ms !== null)
    .sort((a, b) => b.end_ms! - b.start_ms - (a.end_ms! - a.start_ms))[0]
  return {
    range: traceDomain(spec),
    selected: longest?.span_id ?? spec.data.spans[0].span_id,
    grouping: "attempt",
    collapsed: new Set(["internal"]),
  }
}
export function clampTraceRange(
  range: [number, number],
  domain: [number, number],
): [number, number] {
  const width = Math.max(
    0.001,
    Math.min(domain[1] - domain[0], range[1] - range[0]),
  )
  const lo = Math.max(domain[0], Math.min(domain[1] - width, range[0]))
  return [lo, lo + width]
}
export function useTraceView(spec: WaterfallSpec) {
  const [state, setState] = useState(() => initialTraceView(spec))
  const signature = JSON.stringify(spec)
  useEffect(() => {
    setState(initialTraceView(spec))
  }, [signature]) // stable while the assistant streams unrelated prose
  return [state, setState] as const
}
interface Row {
  id: string
  label: string
  depth: number
  span?: TraceSpan
  children?: number
  groupKey?: string
}
export function traceRows(spec: WaterfallSpec, view: TraceViewState): Row[] {
  const spans = [...spec.data.spans].sort(
    (a, b) => a.start_ms - b.start_ms || a.span_id.localeCompare(b.span_id),
  )
  if (view.grouping === "parent") {
    const ids = new Set(spans.map((s) => s.span_id)),
      rows: Row[] = []
    const visit = (span: TraceSpan, depth: number) => {
      const children = spans.filter((s) => s.parent_span_id === span.span_id)
      rows.push({
        id: span.span_id,
        label: span.label,
        depth,
        span,
        children: children.length,
        groupKey: `span:${span.span_id}`,
      })
      if (!view.collapsed.has(`span:${span.span_id}`))
        children.forEach((s) => visit(s, depth + 1))
    }
    spans
      .filter((s) => !s.parent_span_id || !ids.has(s.parent_span_id))
      .forEach((s) => visit(s, 0))
    return rows
  }
  const rows: Row[] = []
  const root = spans.find((s) => s.span_id === spec.data.root_span_id)
  if (root)
    rows.push({ id: root.span_id, label: root.label, depth: 0, span: root })
  const attempts = new Map<string, TraceSpan[]>()
  const other: TraceSpan[] = []
  for (const s of spans) {
    if (s === root) continue
    if (!s.attempt_id) {
      other.push(s)
      continue
    }
    const group = attempts.get(s.attempt_id) ?? []
    group.push(s)
    attempts.set(s.attempt_id, group)
  }
  if (other.length) {
    rows.push({
      id: "group:internal",
      label: "",
      depth: 0,
      children: other.length,
      groupKey: "internal",
    })
    if (!view.collapsed.has("internal"))
      other.forEach((s) =>
        rows.push({ id: s.span_id, label: s.label, depth: 1, span: s }),
      )
  }
  for (const [attempt, group] of attempts) {
    rows.push({
      id: `attempt-group:${attempt}`,
      label: attempt,
      depth: 0,
      children: group.length,
      groupKey: `attempt:${attempt}`,
    })
    if (!view.collapsed.has(`attempt:${attempt}`))
      group.forEach((s) =>
        rows.push({ id: s.span_id, label: s.label, depth: 1, span: s }),
      )
  }
  return rows
}
export interface TraceTimelineProps {
  spec: WaterfallSpec
  labels: TraceLabels
  view: TraceViewState
  onChange: (view: TraceViewState) => void
  Button: ComponentType<ButtonHTMLAttributes<HTMLButtonElement>>
  onInvestigate?: (selection: TraceSelection) => void | Promise<void>
}
export function TraceTimeline({
  spec,
  labels: l,
  view,
  onChange,
  Button,
  onInvestigate,
}: TraceTimelineProps) {
  const host = useRef<HTMLDivElement>(null),
    overview = useRef<HTMLButtonElement>(null)
  const [width, setWidth] = useState(760),
    [detailsOpen, setDetailsOpen] = useState(false),
    [helpOpen, setHelpOpen] = useState(false),
    [sending, setSending] = useState(false),
    [error, setError] = useState(false)
  useEffect(() => {
    if (!host.current) return
    const measure = () =>
      setWidth(host.current!.getBoundingClientRect().width || 760)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(measure)
    ro.observe(host.current)
    return () => ro.disconnect()
  }, [])
  const domain = useMemo(() => traceDomain(spec), [spec]),
    summary = traceSummary(spec)
  const rows = traceRows(spec, view),
    selected =
      spec.data.spans.find((s) => s.span_id === view.selected) ??
      spec.data.spans[0]
  const { split, chartWidth, narrow, left, right } = traceLayout(width)
  const detailsId = useId()
  const plotWidth = Math.max(80, chartWidth - left - right),
    spanWidth = view.range[1] - view.range[0]
  const x = (t: number) => ((t - view.range[0]) / spanWidth) * plotWidth
  const overviewWidth = Math.max(width, 100),
    dx = (t: number) =>
      8 + ((t - domain[0]) / (domain[1] - domain[0])) * (overviewWidth - 16)
  const tickValues = Array.from(
    { length: narrow ? 3 : 4 },
    (_, i) => view.range[0] + (spanWidth * i) / (narrow ? 2 : 3),
  )
  const axisValue = (n: number) =>
    (n / 1000).toFixed(
      spanWidth > 10000 ? 1 : spanWidth > 1000 ? 2 : spanWidth > 1 ? 4 : 6,
    )
  const setRange = (range: [number, number]) =>
    onChange({ ...view, range: clampTraceRange(range, domain) })
  const drag = useRef<{
    mode: string
    time: number
    range: [number, number]
  } | null>(null)
  const timeAt = (clientX: number) => {
    const box = overview.current!.getBoundingClientRect()
    return Math.max(
      domain[0],
      Math.min(
        domain[1],
        domain[0] +
          ((clientX - box.left - 8) / (box.width - 16)) *
            (domain[1] - domain[0]),
      ),
    )
  }
  const toggle = (key: string) => {
    const collapsed = new Set(view.collapsed)
    collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key)
    onChange({ ...view, collapsed })
  }
  const selectedDuration =
    selected.end_ms === null ? null : selected.end_ms - selected.start_ms
  const inspectorOpen = split || detailsOpen
  const inspector = (
    <section
      className="min-w-0 rounded-lg border border-border bg-secondary/20"
      aria-label={l.evidence}
      data-trace-inspector
    >
      <div className="flex min-w-0 items-center justify-between gap-3 p-3">
        <div className="min-w-0">
          <p className="m-0 text-[11px] font-medium text-muted-foreground">
            {l.selected}
          </p>
          <p
            className="m-0 mt-1 truncate text-sm font-medium"
            title={selected.label}
          >
            {selected.label}
          </p>
        </div>
        {!split && (
          <Button
            aria-expanded={inspectorOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen(!detailsOpen)}
          >
            {l.details}
            <ChevronDown
              className={`h-3.5 w-3.5 ${inspectorOpen ? "rotate-180" : ""}`}
            />
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3">
        <span className="font-mono text-xl font-semibold tabular-nums">
          {formatTraceMs(selectedDuration)}
        </span>
        <span
          className={`rounded px-1.5 py-0.5 text-[11px] ${selected.status === "error" || (selected.http_status ?? 0) >= 400 ? "bg-destructive/10 text-red-600 dark:text-red-400" : "bg-secondary text-muted-foreground"}`}
        >
          {traceStatusLabel(selected, l)}
        </span>
      </div>
      <div id={detailsId} hidden={!inspectorOpen}>
        {inspectorOpen && (
          <div className="trace-inspector-body space-y-3 border-t border-border p-3">
            <dl className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-muted-foreground">{l.start}</dt>
                <dd className="m-0 mt-1 break-all font-mono tabular-nums">
                  {selected.start_ms} ms
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{l.end}</dt>
                <dd className="m-0 mt-1 break-all font-mono tabular-nums">
                  {selected.end_ms === null ? l.open : `${selected.end_ms} ms`}
                </dd>
              </div>
            </dl>
            <dl className="space-y-2 text-xs">
              {[
                [l.span, selected.span_id],
                [l.parent, selected.parent_span_id ?? (selected.span_id === spec.data.root_span_id ? l.root : l.unknown)],
                ...(spec.data.request_id
                  ? [[l.request, spec.data.request_id]]
                  : []),
                ...(spec.data.trace_id ? [[l.trace, spec.data.trace_id]] : []),
                [l.evidence, selected.evidence_refs.join(" · ") || l.unknown],
              ].map(([key, value]) => (
                <div key={key}>
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="m-0 mt-0.5 break-all text-xs">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="space-y-1.5 border-t border-border pt-3 text-xs">
              <p className="m-0 font-medium">{l.coverage}</p>
              <p className="m-0 break-words text-muted-foreground">
                {l.observed}:{" "}
                {spec.data.coverage.observed.join(" · ") || l.unknown}
              </p>
              {spec.data.coverage.missing.length > 0 && (
                <div className="text-amber-700 dark:text-amber-400">
                  <p className="m-0">{l.missing}</p>
                  <ul className="m-0 mt-1 list-disc space-y-1 pl-4">
                    {spec.data.coverage.missing.map((item, i) => (
                      <li key={i} className="break-words">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <p className="m-0 text-xs leading-relaxed text-muted-foreground">
              {l.grouping}
            </p>
            {summary.outside_root && (
              <p className="m-0 text-xs text-amber-700 dark:text-amber-400">
                {l.outside}
              </p>
            )}
            {onInvestigate && (
              <div className="space-y-2">
                <Button
                  disabled={sending}
                  onClick={async () => {
                    setSending(true)
                    setError(false)
                    try {
                      await onInvestigate({
                        span_id: selected.span_id,
                        range_ms: view.range,
                      })
                    } catch {
                      setError(true)
                    } finally {
                      setSending(false)
                    }
                  }}
                >
                  {sending ? l.pending : l.investigate}
                </Button>
                {error && (
                  <p
                    role="alert"
                    className="m-0 text-xs text-red-600 dark:text-red-400"
                  >
                    {l.failed}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
  return (
    <div
      ref={host}
      className="trace-view min-w-0 space-y-3 text-sm text-foreground"
      data-trace-view
      data-trace-layout={split ? "split" : narrow ? "mobile" : "stacked"}
      data-range-start={view.range[0]}
      data-range-end={view.range[1]}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {narrow ? (
          <select
            aria-label={l.raw}
            value={view.grouping}
            className="trace-button min-w-0 max-w-[50%] rounded-md border border-border bg-card px-2 text-xs"
            onChange={(event) =>
              onChange({
                ...view,
                grouping: event.target.value as TraceViewState["grouping"],
              })
            }
          >
            <option value="attempt">{l.attempts}</option>
            <option value="parent">{l.hierarchy}</option>
          </select>
        ) : (
          <div
            className="inline-flex rounded-md border border-border p-0.5"
            role="group"
            aria-label={l.raw}
          >
            {(["attempt", "parent"] as const).map((mode) => (
              <Button
                key={mode}
                aria-pressed={view.grouping === mode}
                onClick={() => onChange({ ...view, grouping: mode })}
              >
                {mode === "attempt" ? l.attempts : l.hierarchy}
              </Button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            aria-label={l.fit}
            title={l.fit}
            onClick={() => {
              const end = selected.end_ms ?? selected.start_ms + 1
              const pad = Math.max(0.001, (end - selected.start_ms) * 0.1)
              setRange([selected.start_ms - pad, end + pad])
            }}
          >
            <Focus className="h-3.5 w-3.5" aria-hidden="true" />
            {!narrow && l.fit}
          </Button>
          <Button
            aria-label={l.reset}
            title={l.reset}
            onClick={() => setRange(domain)}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {!narrow && l.reset}
          </Button>
          <Button
            aria-label={l.help}
            title={l.help}
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen(!helpOpen)}
          >
            <HelpCircle className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {helpOpen && (
        <p className="m-0 rounded-md bg-secondary p-2 text-xs text-muted-foreground">
          {l.brushHint} {l.unknownHint}
        </p>
      )}
      <div>
        <div className="mb-1 flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
          <span title={l.range}>
            {!narrow && `${l.range}: `}
            <span className="font-mono tabular-nums">
              {axisValue(view.range[0])}–{axisValue(view.range[1])} s
            </span>
          </span>
          <label className="flex items-center gap-2">
            {l.zoom}
            <input
              type="range"
              min={0}
              max={20}
              step={0.1}
              value={Math.min(
                20,
                Math.log2((domain[1] - domain[0]) / spanWidth),
              )}
              aria-label={l.zoom}
              className="w-20 accent-primary"
              onChange={(e) => {
                const half =
                  (domain[1] - domain[0]) / 2 ** Number(e.target.value) / 2
                const center = (view.range[0] + view.range[1]) / 2
                setRange([center - half, center + half])
              }}
            />
          </label>
        </div>
        <button
          type="button"
          ref={overview}
          className="trace-overview block w-full touch-none rounded-md border border-border bg-secondary/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={l.brushHint}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            const time = timeAt(e.clientX),
              px = dx(view.range[1]) - dx(view.range[0])
            const near =
              Math.abs(dx(time) - dx((view.range[0] + view.range[1]) / 2)) < 22
            const handle = (e.target as Element).getAttribute("data-handle")
            const mode =
              px < 36
                ? near
                  ? "move"
                  : "brush"
                : handle ||
                  (spanWidth < domain[1] - domain[0] &&
                  time > view.range[0] &&
                  time < view.range[1]
                    ? "move"
                    : "brush")
            drag.current = { mode, time, range: view.range }
            e.currentTarget.setPointerCapture(e.pointerId)
            e.currentTarget.focus()
            e.preventDefault()
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d) return
            const time = timeAt(e.clientX)
            if (d.mode === "move")
              setRange([d.range[0] + time - d.time, d.range[1] + time - d.time])
            else if (d.mode === "lo")
              setRange([Math.min(time, d.range[1] - 0.001), d.range[1]])
            else if (d.mode === "hi")
              setRange([d.range[0], Math.max(time, d.range[0] + 0.001)])
            else if (Math.abs(time - d.time) > 0.001)
              setRange([Math.min(time, d.time), Math.max(time, d.time)])
          }}
          onPointerUp={() => {
            drag.current = null
          }}
          onPointerCancel={() => {
            drag.current = null
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault()
              const delta = spanWidth * (e.key === "ArrowLeft" ? -0.2 : 0.2)
              setRange([view.range[0] + delta, view.range[1] + delta])
            } else if (["+", "=", "-"].includes(e.key)) {
              e.preventDefault()
              const half = spanWidth * (e.key === "-" ? 1 : 0.25),
                center = (view.range[0] + view.range[1]) / 2
              setRange([center - half, center + half])
            } else if (e.key === "Home") {
              e.preventDefault()
              setRange(domain)
            }
          }}
        >
          <svg
            preserveAspectRatio="none"
            viewBox={`0 0 ${overviewWidth} 48`}
            className="block h-9 w-full"
            aria-hidden="true"
          >
            {spec.data.spans
              .filter((s) => s.layer === "route" || s.layer === "http")
              .map((s) => (
                <rect
                  key={s.span_id}
                  x={dx(s.start_ms)}
                  y={s.layer === "http" ? 25 : 12}
                  width={Math.max(
                    0.5,
                    dx(s.end_ms ?? s.start_ms) - dx(s.start_ms),
                  )}
                  height={8}
                  className={
                    s.layer === "http"
                      ? "fill-blue-500/70"
                      : "fill-muted-foreground/25"
                  }
                />
              ))}
            <rect
              x={dx(view.range[0])}
              y={4}
              width={Math.max(1, dx(view.range[1]) - dx(view.range[0]))}
              height={40}
              rx={3}
              className="fill-blue-500/5 stroke-blue-500/70"
            />
            {(["lo", "hi"] as const).map((k, i) => (
              <g key={k}>
                <rect
                  x={dx(view.range[i]) - 2}
                  y={13}
                  width={4}
                  height={22}
                  rx={2}
                  className="fill-blue-500"
                />
                <rect
                  data-handle={k}
                  x={dx(view.range[i]) - 12}
                  y={0}
                  width={24}
                  height={48}
                  fill="transparent"
                />
              </g>
            ))}
          </svg>
        </button>
      </div>
      <div
        className="grid min-w-0 items-start gap-4"
        style={{
          gridTemplateColumns: split ? "minmax(0,1fr) 288px" : "minmax(0,1fr)",
        }}
      >
        <div
          className="min-w-0"
          style={{ gridColumn: 1, gridRow: split ? 1 : 2 }}
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>{l.seconds}</span>
            <div
              className="flex flex-wrap items-center gap-3"
              aria-label={l.stages}
            >
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-3 rounded-sm bg-blue-500/70" />
                {l.legendHttp}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-3 rounded-sm bg-muted-foreground/30" />
                {l.legendOther}
              </span>
            </div>
          </div>
          <div
            className="trace-rows min-w-0 overflow-y-auto overscroll-contain rounded-md border border-border"
            data-trace-rows
          >
            <div
              className="sticky top-0 z-10 grid items-center bg-card pt-2 border-b border-border pb-2 text-xs text-muted-foreground"
              style={{
                gridTemplateColumns: narrow
                  ? "1fr"
                  : `${left}px minmax(0,1fr) ${right}px`,
              }}
            >
              {!narrow && <span>{l.stages}</span>}
              <svg
                viewBox={`0 0 ${plotWidth} 22`}
                className="block h-[22px] w-full"
                aria-label={l.seconds}
                role="presentation"
              >
                {tickValues.map((t, i) => (
                  <text
                    key={i}
                    x={Math.max(1, Math.min(plotWidth - 1, x(t)))}
                    y={15}
                    textAnchor={
                      i === 0
                        ? "start"
                        : i === tickValues.length - 1
                          ? "end"
                          : "middle"
                    }
                    className="fill-muted-foreground"
                    fontSize={11}
                  >
                    {axisValue(t)}
                  </text>
                ))}
              </svg>
              {!narrow && <span className="text-right">{l.duration}</span>}
            </div>
            {rows.map((row) => {
              const s = row.span,
                outside =
                  s &&
                  (s.start_ms > view.range[1] ||
                    (s.end_ms ?? domain[1]) < view.range[0])
              const isSelected = s?.span_id === selected.span_id
              return (
                <div
                  key={`${row.span ? "span" : "group"}:${row.id}`}
                  data-trace-row={row.id}
                  className={`trace-row grid min-w-0 items-center border-b border-border/50 ${isSelected ? "bg-blue-500/10" : row.span ? "hover:bg-secondary/50" : "bg-secondary/40"}`}
                  style={{
                    gridTemplateColumns: narrow
                      ? "minmax(0,1fr) 96px"
                      : `${left}px minmax(0,1fr) ${right}px`,
                  }}
                >
                  <div
                    className="flex min-w-0 items-center"
                    style={{ paddingLeft: Math.min(row.depth, 6) * 12 }}
                  >
                    {row.children ? (
                      <button
                        type="button"
                        aria-expanded={!view.collapsed.has(row.groupKey!)}
                        aria-label={`${row.groupKey?.startsWith("attempt:") ? `${l.attempt} ${row.label.replace(/^attempt-(\d+)$/, "$1")}` : row.label || l.internal} (${row.children})`}
                        onClick={() => toggle(row.groupKey!)}
                        className="trace-row-toggle flex h-8 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary focus-visible:outline focus-visible:outline-ring"
                      >
                        {view.collapsed.has(row.groupKey!) ? (
                          <ChevronRight className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                      </button>
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    {s ? (
                      <button
                        type="button"
                        className="trace-row-label min-h-9 min-w-0 truncate rounded px-1 text-left text-[13px] font-medium hover:text-primary focus-visible:outline focus-visible:outline-ring"
                        aria-pressed={isSelected}
                        onClick={() =>
                          onChange({ ...view, selected: s.span_id })
                        }
                        title={row.label}
                      >
                        {row.label}
                      </button>
                    ) : (
                      <span className="truncate text-xs font-medium">
                        {row.groupKey?.startsWith("attempt:")
                          ? `${l.attempt} ${row.label.replace(/^attempt-(\d+)$/, "$1")}`
                          : row.label || l.internal}
                        <span className="ml-1.5 font-normal text-muted-foreground">
                          {row.children} {l.spans}
                        </span>
                      </span>
                    )}
                  </div>
                  {s ? (
                    <button
                      type="button"
                      className="trace-row-bar block h-9 min-w-0 w-full rounded focus-visible:outline focus-visible:outline-ring"
                      style={
                        narrow ? { gridColumn: "1/-1", gridRow: 2 } : undefined
                      }
                      aria-label={`${s.label}: ${outside ? l.emptyRange : formatTraceMs(s.end_ms === null ? null : s.end_ms - s.start_ms)}`}
                      onClick={() => onChange({ ...view, selected: s.span_id })}
                    >
                      <svg
                        preserveAspectRatio="none"
                        viewBox={`0 0 ${plotWidth} 40`}
                        className="block h-8 w-full"
                        aria-hidden="true"
                      >
                        {tickValues.map((t, i) => (
                          <line
                            key={i}
                            x1={x(t)}
                            x2={x(t)}
                            y1={0}
                            y2={40}
                            className="stroke-border/50"
                          />
                        ))}
                        {!outside && (
                          <>
                            <rect
                              data-trace-interval={s.span_id}
                              x={Math.max(0, x(s.start_ms))}
                              y={s.layer === "http" ? 14 : 12}
                              width={Math.max(
                                0.25,
                                Math.min(plotWidth, x(s.end_ms ?? domain[1])) -
                                  Math.max(0, x(s.start_ms)),
                              )}
                              height={s.layer === "http" ? 10 : 14}
                              rx={2}
                              strokeDasharray={
                                s.end_ms === null || s.layer === "derived"
                                  ? "4 3"
                                  : undefined
                              }
                              className={
                                s.end_ms === null
                                  ? "fill-transparent stroke-muted-foreground"
                                  : s.layer === "derived"
                                    ? "fill-muted-foreground/10 stroke-muted-foreground"
                                    : s.layer === "http"
                                      ? "fill-blue-500/70"
                                      : "fill-muted-foreground/30"
                              }
                            />
                            {s.end_ms === null && (
                              <text
                                x={plotWidth - 3}
                                y={24}
                                textAnchor="end"
                                className="fill-foreground"
                                fontSize={12}
                              >
                                ?
                              </text>
                            )}
                            {s.end_ms !== null &&
                              x(s.end_ms) - x(s.start_ms) < 2 && (
                                <circle
                                  cx={Math.max(
                                    2,
                                    Math.min(plotWidth - 2, x(s.start_ms)),
                                  )}
                                  cy={19}
                                  r={2}
                                  className="fill-blue-500"
                                />
                              )}
                          </>
                        )}
                      </svg>
                    </button>
                  ) : (
                    !narrow && <span />
                  )}
                  <div
                    className="pr-2 text-right font-mono text-xs tabular-nums"
                    style={narrow ? { gridColumn: 2, gridRow: 1 } : undefined}
                  >
                    {s && (
                      <>
                        {formatTraceMs(
                          s.end_ms === null ? null : s.end_ms - s.start_ms,
                        )}
                        <span
                          className={`block text-[11px] ${s.status === "error" || s.status === "cancelled" ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}
                        >
                          {s.http_status
                            ? `HTTP ${s.http_status}`
                            : s.status === "error" || s.status === "cancelled"
                              ? traceStatusLabel(s, l)
                              : ""}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <p className="m-0 mt-2 text-[11px] text-muted-foreground">
            {l.selectHint}
          </p>
        </div>
        <div
          className="min-w-0"
          style={{ gridColumn: split ? 2 : 1, gridRow: 1 }}
        >
          {inspector}
        </div>
      </div>
    </div>
  )
}
/** Single, deterministic SVG for message copy and IM. Interactive controls never enter the PNG. */
export function TraceSnapshot({
  spec,
  labels: l,
  svgRef,
}: {
  spec: WaterfallSpec
  labels: TraceLabels
  svgRef: Ref<SVGSVGElement>
}) {
  const width = 1000,
    rowHeight = 34,
    top = 100,
    footer = 116,
    height = top + spec.data.spans.length * rowHeight + footer
  const root = spec.data.spans.find(
    (span) => span.span_id === spec.data.root_span_id,
  )
  const domain = traceDomain(spec),
    summary = traceSummary(spec),
    left = 280,
    right = 126
  const x = (t: number) =>
    left + ((t - domain[0]) / (domain[1] - domain[0])) * (width - left - right)
  const ellipsis = (s: string, max: number) => {
    let units = 0,
      result = ""
    for (const char of s) {
      units += /[^\u0000-\u00ff]/.test(char) ? 2 : 1
      if (units > max - 1) return result + "…"
      result += char
    }
    return result
  }
  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={spec.title ?? l.title}
      data-trace-export
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="text-foreground"
    >
      <title>{spec.title ?? l.title}</title>
      <rect
        className="chart-bg fill-background"
        width={width}
        height={height}
      />
      <text
        x={24}
        y={30}
        className="fill-foreground"
        fontSize={18}
        fontWeight={500}
      >
        {ellipsis(spec.title ?? l.title, 65)}
      </text>
      <text x={24} y={54} className="fill-muted-foreground" fontSize={12}>
        {spec.data.spans.length} {l.spans} · {summary.http_calls} {l.httpCalls}
        {root &&
          ` · ${l.root}: ${formatTraceMs(root.end_ms === null ? null : root.end_ms - root.start_ms)}`}
        {!spec.data.coverage.complete ||
        spec.data.coverage.missing.length > 0 ||
        summary.open_spans > 0 ||
        summary.outside_root
          ? ` · ${l.partial}`
          : ""}
      </text>
      <text x={24} y={80} className="fill-muted-foreground" fontSize={12}>
        {l.stages}
      </text>
      <text
        x={width - 24}
        y={80}
        textAnchor="end"
        className="fill-muted-foreground"
        fontSize={12}
      >
        {l.duration}
      </text>
      {Array.from({ length: 5 }, (_, i) => {
        const t = domain[0] + ((domain[1] - domain[0]) * i) / 4
        return (
          <g key={i}>
            <line
              x1={x(t)}
              x2={x(t)}
              y1={top - 12}
              y2={height - footer}
              className="stroke-border"
            />
            <text
              x={x(t)}
              y={height - footer + 20}
              textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}
              className="fill-muted-foreground"
              fontSize={12}
            >
              {Number((t / 1000).toFixed(4))} s
            </text>
          </g>
        )
      })}
      {spec.data.spans.map((s, i) => {
        const y = top + i * rowHeight
        return (
          <g key={s.span_id}>
            <text x={24} y={y + 11} className="fill-foreground" fontSize={12}>
              {ellipsis(s.label, 27)}
            </text>
            <rect
              x={x(s.start_ms)}
              y={y}
              width={Math.max(0.5, x(s.end_ms ?? domain[1]) - x(s.start_ms))}
              height={12}
              strokeDasharray={
                s.end_ms === null || s.layer === "derived" ? "4 3" : undefined
              }
              className={
                s.end_ms === null
                  ? "fill-transparent stroke-muted-foreground"
                  : s.layer === "derived"
                    ? "fill-muted-foreground/10 stroke-muted-foreground"
                    : s.layer === "http"
                      ? "fill-blue-500/70"
                      : "fill-muted-foreground/30"
              }
            />
            <text
              x={width - 24}
              y={y + 6}
              textAnchor="end"
              className="fill-foreground"
              fontSize={12}
            >
              {formatTraceMs(s.end_ms === null ? null : s.end_ms - s.start_ms)}
            </text>
            <text
              x={width - 24}
              y={y + 20}
              textAnchor="end"
              className={
                s.status === "error"
                  ? "fill-red-600 dark:fill-red-400"
                  : "fill-muted-foreground"
              }
              fontSize={11}
            >
              {s.http_status
                ? `HTTP ${s.http_status}`
                : s.end_ms === null
                  ? l.open
                  : traceStatusLabel(s, l)}
            </text>
          </g>
        )
      })}
      <text
        x={24}
        y={height - 65}
        className="fill-muted-foreground"
        fontSize={12}
      >
        {ellipsis(
          `${l.observed}: ${spec.data.coverage.observed.join(" · ")}`,
          110,
        )}
      </text>
      <text
        x={24}
        y={height - 43}
        className="fill-muted-foreground"
        fontSize={12}
      >
        {ellipsis(
          `${l.missing}: ${spec.data.coverage.missing.join(" · ") || "—"}`,
          110,
        )}
      </text>
      <text
        x={24}
        y={height - 21}
        className="fill-muted-foreground"
        fontSize={12}
      >
        {ellipsis(l.grouping, 112)}
      </text>
    </svg>
  )
}
