import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, Clipboard, Copy, Download, Maximize2, X } from "lucide-react"
import { useCopyFeedback } from "./clipboard"
import {
  copyBlobToClipboard,
  downloadBlob,
  safeDownloadName,
  svgToPngBlob,
} from "./svg-export"

const MAX_MERMAID_CHARS = 12000
const MAX_MERMAID_LINES = 160
const MAX_MERMAID_EDGES = 80

type MermaidValidation =
  | { ok: true; source: string; kind: "flowchart" | "sequence" | "timeline" | "xychart" }
  | { ok: false; reason: string }

type RenderState =
  | { status: "rendering" }
  | { status: "ready"; svg: string }
  | { status: "error"; title: string; description: string }

let mermaidIdSeq = 0

function nextMermaidId(): string {
  mermaidIdSeq += 1
  return `siclaw-mermaid-${Date.now()}-${mermaidIdSeq}`
}

function firstMeaningfulLine(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("%%")) ?? ""
}

function normalizeMermaidSource(raw: string): string {
  return raw.trim().replace(/^\s*\d+-(?:content|text):\s*/gm, "")
}

export function countMermaidEdges(source: string): number {
  return (
    source.match(/(?:-->|---|==>|->>|-->>|-\)|--\)|<-->|<->|--x|--o)/g) ?? []
  ).length
}

// Layered guard before mounting Mermaid output: bound input size/complexity,
// reject init directives so chat content cannot weaken renderer config, then
// whitelist only the diagram families Siclaw intentionally supports.
export function validateMermaidSource(raw: string): MermaidValidation {
  const source = normalizeMermaidSource(raw)
  if (!source) return { ok: false, reason: "The Mermaid block is empty." }
  if (source.length > MAX_MERMAID_CHARS) {
    return {
      ok: false,
      reason: `The Mermaid block is too large (${source.length} characters, max ${MAX_MERMAID_CHARS}).`,
    }
  }
  const lines = source.split(/\r?\n/)
  if (lines.length > MAX_MERMAID_LINES) {
    return {
      ok: false,
      reason: `The Mermaid block has too many lines (${lines.length}, max ${MAX_MERMAID_LINES}).`,
    }
  }
  if (/^\s*%%\{/m.test(source)) {
    return {
      ok: false,
      reason: "Mermaid init/config directives are not allowed in chat diagrams.",
    }
  }
  const edges = countMermaidEdges(source)
  if (edges > MAX_MERMAID_EDGES) {
    return {
      ok: false,
      reason: `The Mermaid diagram has too many edges (${edges}, max ${MAX_MERMAID_EDGES}).`,
    }
  }

  const head = firstMeaningfulLine(source)
  if (/^(flowchart|graph)\s+/i.test(head)) {
    return { ok: true, source, kind: "flowchart" }
  }
  if (/^sequenceDiagram\b/i.test(head)) {
    return { ok: true, source, kind: "sequence" }
  }
  if (/^timeline\b/i.test(head)) {
    return { ok: true, source, kind: "timeline" }
  }
  if (/^xychart-beta\b/i.test(head)) {
    return { ok: true, source, kind: "xychart" }
  }
  return {
    ok: false,
    reason: "Only flowchart/graph, sequenceDiagram, timeline, and xychart-beta diagrams are supported.",
  }
}

function mermaidConfig() {
  return {
    startOnLoad: false,
    // This is the load-bearing XSS defense for the SVG later mounted with
    // dangerouslySetInnerHTML. Chat-authored %%{init}%% directives are rejected
    // above so a response cannot downgrade this setting.
    securityLevel: "strict",
    maxTextSize: MAX_MERMAID_CHARS,
    maxEdges: MAX_MERMAID_EDGES,
    theme: "base",
    flowchart: {
      htmlLabels: false,
      useMaxWidth: true,
    },
    sequence: {
      useMaxWidth: true,
    },
    themeVariables: {
      background: "#ffffff",
      mainBkg: "#f8fafc",
      primaryColor: "#e0f2fe",
      primaryTextColor: "#0f172a",
      primaryBorderColor: "#0284c7",
      secondaryColor: "#f1f5f9",
      tertiaryColor: "#f8fafc",
      lineColor: "#475569",
      textColor: "#0f172a",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    },
  } as const
}

function decorateMermaidSvg(svg: string): string {
  // Mermaid already parsed/rendered this string under strict mode. Keep this as
  // a tiny string decoration so we do not need to reparse browser-only SVG DOM
  // just to add accessibility metadata.
  return svg.replace(/<svg\b[^>]*>/, (tag) => {
    let next = /\brole=/.test(tag)
      ? tag.replace(/\srole=(["']).*?\1/, ' role="img"')
      : tag.replace("<svg", '<svg role="img"')
    next = /\baria-label=/.test(next)
      ? next.replace(/\saria-label=(["']).*?\1/, ' aria-label="Mermaid diagram"')
      : next.replace("<svg", '<svg aria-label="Mermaid diagram"')
    return next
  })
}

function mermaidDownloadBase(source: string, kind: string): string {
  const title = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^title\s+/i.test(line))
    ?.replace(/^title\s+/i, "")
  return safeDownloadName(title || `mermaid-${kind}`, "mermaid-diagram")
}

const TOOLBAR_BTN =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors " +
  "hover:bg-slate-200 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"

function MermaidShell({
  source,
  children,
  actions,
}: {
  source: string
  children: ReactNode
  actions?: ReactNode
}) {
  const [copied, copy] = useCopyFeedback()
  return (
    <div className="mermaid-host my-3 overflow-hidden rounded-lg border border-border bg-white text-slate-900 shadow-sm dark:border-slate-700 dark:bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-1 dark:border-slate-800 dark:bg-slate-900">
        <span className="font-mono text-[11px] font-medium text-slate-500 dark:text-slate-400">
          mermaid
        </span>
        <div className="flex items-center gap-1">
          {actions}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void copy(source)
            }}
            aria-label="Copy Mermaid source"
            title="Copy Mermaid source"
            className={TOOLBAR_BTN}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      {children}
    </div>
  )
}

function MermaidError({
  source,
  title,
  description,
}: {
  source: string
  title: string
  description: string
}) {
  return (
    <MermaidShell source={source}>
      <div className="p-3 text-sm text-red-900 dark:text-red-100">
        <div className="font-semibold">{title}</div>
        <div className="mt-1 text-xs opacity-80">{description}</div>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium">View Mermaid source</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded bg-slate-950 p-3 text-xs text-slate-100">
            {source}
          </pre>
        </details>
      </div>
    </MermaidShell>
  )
}

export function MermaidRenderer({
  source,
  isStreaming = false,
}: {
  source: string
  isStreaming?: boolean
}) {
  const validation = useMemo(() => validateMermaidSource(source), [source])
  const cleanSource = validation.ok ? validation.source : source.trim()
  const [state, setState] = useState<RenderState>({ status: "rendering" })
  const [status, setStatus] = useState<null | { kind: "ok" | "err"; text: string }>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const diagramRef = useRef<HTMLDivElement | null>(null)

  const flash = useCallback((kind: "ok" | "err", text: string) => {
    setStatus({ kind, text })
    setTimeout(() => setStatus(null), 1800)
  }, [])

  const getSvg = useCallback(() => diagramRef.current?.querySelector<SVGSVGElement>("svg") ?? null, [])

  const onCopyImage = useCallback(async () => {
    const svg = getSvg()
    if (!svg) return
    try {
      const blob = await svgToPngBlob(svg, 2)
      const ok = await copyBlobToClipboard(blob)
      if (ok) flash("ok", "Image copied to clipboard")
      else {
        downloadBlob(blob, "mermaid-diagram.png")
        flash("ok", "Clipboard image copy unavailable — downloaded PNG instead")
      }
    } catch (err) {
      console.warn("[copy] Mermaid image copy failed:", err)
      flash("err", "Copy failed")
    }
  }, [flash, getSvg])

  const onDownload = useCallback(async () => {
    const svg = getSvg()
    if (!svg) return
    try {
      const blob = await svgToPngBlob(svg, 2)
      const base = mermaidDownloadBase(cleanSource, validation.ok ? validation.kind : "diagram")
      downloadBlob(blob, `${base}.png`)
      flash("ok", "PNG downloaded")
    } catch (err) {
      console.warn("[download] Mermaid PNG export failed:", err)
      flash("err", "Download failed")
    }
  }, [cleanSource, flash, getSvg, validation])

  useEffect(() => {
    let cancelled = false
    if (isStreaming) {
      setState({ status: "rendering" })
      return () => {
        cancelled = true
      }
    }
    if (!validation.ok) {
      setState({
        status: "error",
        title: "Unsupported Mermaid diagram",
        description: validation.reason,
      })
      return () => {
        cancelled = true
      }
    }

    setState({ status: "rendering" })
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default
        mermaid.initialize(mermaidConfig())
        const parsed = await mermaid.parse(validation.source)
        if (!parsed) throw new Error("Mermaid parser rejected the diagram syntax.")
        const { svg } = await mermaid.render(nextMermaidId(), validation.source)
        // Dynamic import/render can resolve after a newer source or streaming
        // state has already triggered another effect; avoid replacing fresh
        // state with a stale render.
        if (!cancelled) setState({ status: "ready", svg: decorateMermaidSvg(svg) })
      } catch (err) {
        if (cancelled) return
        setState({
          status: "error",
          title: "Failed to render Mermaid diagram",
          description: err instanceof Error ? err.message : String(err),
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [validation, isStreaming])

  useEffect(() => {
    if (!previewOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [previewOpen])

  if (state.status === "error") {
    return (
      <MermaidError
        source={cleanSource}
        title={state.title}
        description={state.description}
      />
    )
  }

  const actions = state.status === "ready" ? (
    <>
      <button
        type="button"
        onClick={() => setPreviewOpen(true)}
        aria-label="Open larger Mermaid preview"
        title="Open larger Mermaid preview"
        className={TOOLBAR_BTN}
      >
        <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onCopyImage}
        aria-label="Copy Mermaid diagram as PNG to clipboard"
        title="Copy Mermaid diagram as PNG to clipboard"
        className={TOOLBAR_BTN}
      >
        <Clipboard className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onDownload}
        aria-label="Download Mermaid diagram as PNG"
        title="Download Mermaid diagram as PNG"
        className={TOOLBAR_BTN}
      >
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </>
  ) : null

  return (
    <>
      <MermaidShell source={cleanSource} actions={actions}>
        <div className="relative">
          {state.status === "ready" ? (
            <div
              ref={diagramRef}
              className="overflow-auto p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
              aria-label="Mermaid diagram"
              dangerouslySetInnerHTML={{ __html: state.svg }}
            />
          ) : (
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-slate-500 dark:text-slate-400" role="status">
              <svg
                className="h-4 w-4 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              Rendering diagram...
            </div>
          )}
          {status && (
            <div
              className={`absolute left-1/2 top-3 -translate-x-1/2 rounded-md px-2.5 py-1 text-xs shadow-sm ${
                status.kind === "ok" ? "bg-emerald-600 text-white" : "bg-red-600 text-white"
              }`}
            >
              {status.text}
            </div>
          )}
        </div>
      </MermaidShell>

      {state.status === "ready" && previewOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Mermaid preview"
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="max-h-[92vh] w-[min(1200px,96vw)] overflow-auto rounded-lg border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-950"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="min-w-0 truncate text-sm font-medium text-slate-700 dark:text-slate-200">
                Mermaid preview
              </div>
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                aria-label="Close Mermaid preview"
                title="Close Mermaid preview"
                className={TOOLBAR_BTN}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div
              className="overflow-auto p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-none"
              dangerouslySetInnerHTML={{ __html: state.svg }}
            />
          </div>
        </div>
      )}
    </>
  )
}
