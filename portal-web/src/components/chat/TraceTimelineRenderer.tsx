import {
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
} from "react"
import { ChevronDown, Download, Maximize2, X } from "lucide-react"
import {
  TraceTimeline,
  TraceSnapshot,
  TracePreview,
  TraceCompactMeta,
  TraceCompactStatus,
  useTraceView,
  TraceLanguageSelect,
} from "./TraceTimeline"
import { traceFollowUp, type WaterfallSpec } from "./waterfall-spec"
import { TraceHostContext } from "./TraceContext"
import { useTraceLocale } from "./trace-locale"
import "./trace-timeline.css"
import { svgToPngBlob, downloadBlob, safeDownloadName } from "./svg-export"
function TraceButton({
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={`trace-button inline-flex shrink-0 whitespace-nowrap items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-foreground hover:bg-secondary focus-visible:outline focus-visible:outline-ring aria-pressed:bg-secondary disabled:opacity-50 ${className}`}
    />
  )
}
export function TraceTimelineRenderer({
  spec,
  className,
  style,
}: {
  spec: WaterfallSpec
  className?: string
  style?: CSSProperties
}) {
  const host = useContext(TraceHostContext),
    language = useTraceLocale(host.locale)
  const { labels, locale } = language
  const [view, setView] = useTraceView(spec),
    [open, setOpen] = useState(false),
    [expanded, setExpanded] = useState(false),
    [exportError, setExportError] = useState(false),
    [exporting, setExporting] = useState(false)
  const svgRef = useRef<SVGSVGElement>(null),
    dialog = useRef<HTMLDialogElement>(null)
  const detailsId = useId()
  useEffect(() => {
    if (open) dialog.current?.showModal()
    else dialog.current?.close()
  }, [open])
  useEffect(() => {
    if (
      spec.visual_id &&
      host.requestedVisualId === spec.visual_id
    ) {
      setExpanded(true)
    }
  }, [spec.visual_id, host.requestedVisualId])
  const body = (
    <TraceTimeline
      spec={spec}
      labels={labels}
      view={view}
      onChange={setView}
      Button={TraceButton}
      onInvestigate={
        host.onFollowUp
          ? (selection) =>
              host.onFollowUp!(traceFollowUp(spec, selection, locale))
          : undefined
      }
    />
  )
  const downloadPng = async () => {
    if (!svgRef.current) return
    setExporting(true)
    setExportError(false)
    try {
      downloadBlob(
        await svgToPngBlob(svgRef.current, 2),
        `${safeDownloadName(spec.title ?? "request-trace", "request-trace")}.png`,
      )
    } catch {
      setExportError(true)
    } finally {
      setExporting(false)
    }
  }
  const downloadAction = (
    <TraceButton
      disabled={exporting}
      aria-label={labels.export}
      title={labels.export}
      onClick={downloadPng}
    >
      <Download className="h-3.5 w-3.5" />
      {labels.export}
    </TraceButton>
  )
  return (
    <div
      className={`trace-card chart-host relative my-3 min-w-0 w-full rounded-lg border border-border bg-card p-3 ${expanded ? "" : "max-w-2xl"} ${className ?? ""}`}
      style={style}
      data-visual-id={spec.visual_id}
      data-trace-expanded={expanded}
      data-trace-locale={locale}
      lang={locale}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3
          className="m-0 min-w-0 truncate text-sm font-medium"
          title={spec.title ?? labels.title}
        >
          {spec.title ?? labels.title}
        </h3>
        <div className="flex shrink-0 items-center gap-1.5">
          <TraceLanguageSelect
            preference={language.preference}
            labels={labels}
            onChange={language.setPreference}
          />
          <TraceButton
            aria-label={labels.preview}
            title={labels.preview}
            onClick={() => setOpen(true)}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </TraceButton>
        </div>
      </div>
      <TraceCompactMeta spec={spec} labels={labels} />
      {!expanded && (
        <div className="mt-3">
          <TracePreview spec={spec} labels={labels} />
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <TraceCompactStatus spec={spec} labels={labels} />
        <TraceButton
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? labels.collapse : labels.expand}
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 ${expanded ? "rotate-180" : ""}`}
          />
        </TraceButton>
      </div>
      <div id={detailsId} hidden={!expanded}>
        {expanded && (
          <>
            <div className="mt-2 flex justify-end border-t border-border pt-2">
              {downloadAction}
            </div>
            <div
              className="trace-inline mt-2 overflow-y-auto overscroll-contain"
              tabIndex={0}
              role="region"
              aria-label={labels.title}
            >
              {body}
            </div>
          </>
        )}
      </div>
      {exportError && !open && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {labels.exportFailed}
        </p>
      )}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute h-0 w-0 overflow-hidden"
      >
        <TraceSnapshot spec={spec} labels={labels} svgRef={svgRef} />
      </div>
      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        aria-label={spec.title ?? labels.title}
        className="trace-dialog fixed inset-0 z-50 rounded-xl border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/50"
        data-trace-dialog
        lang={locale}
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpen(false)
        }}
      >
        {open && (
          <div className="trace-dialog-layout">
            <header className="trace-dialog-header border-b border-border p-4">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <h3
                  className="m-0 min-w-0 truncate text-sm font-semibold"
                  title={spec.title ?? labels.title}
                >
                  {spec.title ?? labels.title}
                </h3>
                <TraceButton
                  aria-label={labels.close}
                  onClick={() => setOpen(false)}
                >
                  <X className="h-4 w-4" />
                </TraceButton>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <TraceCompactMeta spec={spec} labels={labels} />
                  <TraceCompactStatus spec={spec} labels={labels} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <TraceLanguageSelect
                    preference={language.preference}
                    labels={labels}
                    onChange={language.setPreference}
                  />
                  {downloadAction}
                </div>
              </div>
              {exportError && (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {labels.exportFailed}
                </p>
              )}
            </header>
            <div className="trace-dialog-body p-4">{body}</div>
          </div>
        )}
      </dialog>
    </div>
  )
}
