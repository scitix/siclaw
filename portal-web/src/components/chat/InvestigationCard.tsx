import { useState, useEffect, useRef } from "react"
import { Search, CheckCircle2, XCircle, AlertTriangle, Clock, ChevronDown, ChevronUp, Loader2, SkipForward } from "lucide-react"
import { cn } from "./cn"
import { Markdown } from "./Markdown"
import type { PilotMessage, InvestigationProgress } from "./types"

// --- Types ---

type HypothesisStatus = "validated" | "invalidated" | "inconclusive" | "pending" | "skipped" | "validating"

interface EvidenceItem {
  tool: string
  command: string
  outputPreview: string
  interpretation: string
}

interface ParsedHypothesis {
  id: string
  text: string
  status: HypothesisStatus
  confidence: number
  reasoning?: string
  toolCallsUsed?: number
  evidence?: EvidenceItem[]
}

interface ParsedInvestigation {
  conclusion: string
  hypotheses: ParsedHypothesis[]
  stats: {
    toolCalls: number
    duration: string
    hypothesesSummary: string
  }
  reportPath?: string
}

// --- Parser ---

const STATUS_MAP: Record<string, HypothesisStatus> = {
  VALIDATED: "validated",
  INVALIDATED: "invalidated",
  INCONCLUSIVE: "inconclusive",
  PENDING: "pending",
  SKIPPED: "skipped",
}

function parseInvestigationResult(content: string): ParsedInvestigation | null {
  if (!content || !content.includes("Deep Search Summary")) return null

  const conclusionMatch = content.match(/### Conclusion\n([\s\S]*?)(?=\n### )/)
  const conclusion = conclusionMatch?.[1]?.trim() ?? ""

  const hypotheses: ParsedHypothesis[] = []
  const verdictsMatch = content.match(/### Hypothesis Verdicts\n([\s\S]*?)(?=\n### )/)
  if (verdictsMatch) {
    const verdictsBlock = verdictsMatch[1]
    const lines = verdictsBlock.split("\n")
    let currentHypothesis: ParsedHypothesis | null = null

    for (const line of lines) {
      const simpleMatch = line.match(/^- .+?\*\*(\w+)\*\*:\s+(.+?)\s+—\s+(\d+)%/)
      if (simpleMatch) {
        let status: HypothesisStatus = "pending"
        if (line.includes("VALIDATED") && !line.includes("INVALIDATED")) status = "validated"
        else if (line.includes("INVALIDATED")) status = "invalidated"
        else if (line.includes("INCONCLUSIVE")) status = "inconclusive"
        else if (line.includes("SKIPPED")) status = "skipped"
        else if (line.includes("PENDING")) status = "pending"

        if (currentHypothesis) hypotheses.push(currentHypothesis)
        currentHypothesis = {
          id: simpleMatch[1],
          text: simpleMatch[2],
          status,
          confidence: parseInt(simpleMatch[3], 10),
        }
      } else if (line.trim() && currentHypothesis && line.startsWith("  ")) {
        currentHypothesis.reasoning = line.trim()
      }
    }
    if (currentHypothesis) hypotheses.push(currentHypothesis)
  }

  const statsMatch = content.match(/Tool calls:\s*(\d+)\s*\|\s*Duration:\s*([^\s|]+)\s*\|\s*Hypotheses:\s*(.+)/)
  const stats = {
    toolCalls: statsMatch ? parseInt(statsMatch[1], 10) : 0,
    duration: statsMatch?.[2] ?? "",
    hypothesesSummary: statsMatch?.[3]?.trim() ?? "",
  }

  const reportMatch = content.match(/Full report:\s*`([^`]+)`/)
  const reportPath = reportMatch?.[1]

  return { conclusion, hypotheses, stats, reportPath }
}

function extractFromDetails(details: Record<string, unknown>): ParsedHypothesis[] | null {
  const hyps = details.hypotheses as Array<Record<string, unknown>> | undefined
  if (!hyps || !Array.isArray(hyps)) return null

  return hyps.map((h) => ({
    id: h.id as string,
    text: h.text as string,
    status: (h.status as HypothesisStatus) ?? "pending",
    confidence: (h.confidence as number) ?? 0,
    reasoning: h.reasoning as string | undefined,
    toolCallsUsed: h.toolCallsUsed as number | undefined,
    evidence: (h.evidence as EvidenceItem[] | undefined)?.filter((e) => e.command || e.outputPreview),
  }))
}

// --- Status display helpers ---

function StatusIcon({ status, className }: { status: HypothesisStatus; className?: string }) {
  const size = cn("w-4 h-4 shrink-0", className)
  switch (status) {
    case "validated":
      return <CheckCircle2 className={cn(size, "text-green-500")} />
    case "invalidated":
      return <XCircle className={cn(size, "text-red-400")} />
    case "inconclusive":
      return <AlertTriangle className={cn(size, "text-amber-500")} />
    case "skipped":
      return <SkipForward className={cn(size, "text-muted-foreground/70")} />
    case "validating":
      return <Loader2 className={cn(size, "text-blue-500 animate-spin")} />
    case "pending":
    default:
      return <Clock className={cn(size, "text-muted-foreground/70")} />
  }
}

const STATUS_LABEL: Record<HypothesisStatus, string> = {
  validated: "VALIDATED",
  invalidated: "INVALIDATED",
  inconclusive: "INCONCLUSIVE",
  pending: "PENDING",
  skipped: "SKIPPED",
  validating: "VALIDATING",
}

const STATUS_COLOR: Record<HypothesisStatus, string> = {
  validated: "text-green-600",
  invalidated: "text-red-500",
  inconclusive: "text-amber-400",
  pending: "text-muted-foreground",
  skipped: "text-muted-foreground/70",
  validating: "text-blue-500",
}

// --- Component ---

export interface InvestigationCardProps {
  message: PilotMessage
  progress?: InvestigationProgress | null
  sendMessage?: (text: string) => void
}

function ElapsedTimer() {
  const startRef = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const minutes = Math.floor(elapsed / 60)
  const seconds = elapsed % 60
  return (
    <span className="text-xs text-muted-foreground/70 font-mono tabular-nums">
      {minutes}:{seconds.toString().padStart(2, "0")}
    </span>
  )
}

export function InvestigationCard({ message, progress, sendMessage }: InvestigationCardProps) {
  const [expanded, setExpanded] = useState(false)
  const isRunning = message.toolStatus === "running"
  const isError = message.toolStatus === "error"

  const parsed = !isRunning ? parseInvestigationResult(message.content) : null

  const richHypotheses = message.toolDetails ? extractFromDetails(message.toolDetails) : null
  const reportPath = (message.toolDetails?.reportPath as string) ?? parsed?.reportPath

  const question = message.toolInput || ""

  const hypotheses = richHypotheses ?? parsed?.hypotheses ?? []

  const sortedHypotheses = hypotheses.slice().sort((a, b) => {
    if (a.status === "validated" && b.status !== "validated") return -1
    if (b.status === "validated" && a.status !== "validated") return 1
    return b.confidence - a.confidence
  })

  // --- Running state ---
  if (isRunning) {
    const hasProgress = progress && progress.hypotheses.length > 0

    return (
      <div className="pl-12">
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10/50 px-4 py-3 max-w-2xl">
          <div className="flex items-center gap-2 mb-2">
            <Search className="w-4 h-4 text-blue-500 shrink-0" />
            <span className="text-sm font-semibold text-foreground">Deep Investigation</span>
            {progress?.phase && (
              <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">
                {progress.phase}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <ElapsedTimer />
              <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
            </div>
          </div>

          {question && <p className="text-sm text-muted-foreground mb-3 line-clamp-2">&ldquo;{question}&rdquo;</p>}

          {hasProgress ? (
            <div className="space-y-1 mb-3">
              {progress.hypotheses.map((h) => (
                <div key={h.id} className="flex items-start gap-2">
                  <StatusIcon status={h.status as HypothesisStatus} className="mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-foreground">
                      <span className="font-medium">{h.id}</span> <span className="text-muted-foreground">{h.text}</span>
                    </span>
                    <span
                      className={cn(
                        "text-xs font-medium ml-1.5",
                        STATUS_COLOR[(h.status as HypothesisStatus)] || "text-muted-foreground",
                      )}
                    >
                      {h.status === "validating" && h.lastAction ? (
                        <span className="text-blue-500 font-mono">{h.lastAction}</span>
                      ) : h.status === "validated" || h.status === "invalidated" || h.status === "inconclusive" ? (
                        `${STATUS_LABEL[(h.status as HypothesisStatus)] || h.status} (${h.confidence}%)`
                      ) : (
                        STATUS_LABEL[(h.status as HypothesisStatus)] || h.status
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex items-center gap-2 px-3 py-2 bg-blue-500/10 rounded-md">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500 shrink-0" />
            <span className="text-xs text-blue-400 font-mono truncate">
              {progress?.currentAction || "Investigating hypotheses..."}
            </span>
          </div>
        </div>
      </div>
    )
  }

  // --- Error state ---
  if (isError || !parsed) {
    return (
      <div className="pl-12">
        <div className="rounded-lg border border-red-500/30 bg-red-500/10/50 px-4 py-3 max-w-2xl">
          <div className="flex items-center gap-2 mb-2">
            <Search className="w-4 h-4 text-red-500 shrink-0" />
            <span className="text-sm font-semibold text-foreground">Deep Investigation</span>
            <XCircle className="w-4 h-4 text-red-500 ml-auto shrink-0" />
          </div>
          {question && <p className="text-sm text-muted-foreground mb-2">&ldquo;{question}&rdquo;</p>}
          <pre className="text-xs text-red-400 whitespace-pre-wrap bg-red-500/10 rounded-md px-3 py-2">
            {message.content || "Investigation failed."}
          </pre>
        </div>
      </div>
    )
  }

  // --- Done state ---
  const allDone = sortedHypotheses.length > 0
  const hasEvidence = sortedHypotheses.some((h) => h.evidence && h.evidence.length > 0)

  return (
    <div className="pl-12">
      <div
        className={cn(
          "rounded-lg border px-4 py-3 max-w-2xl transition-colors",
          allDone ? "border-green-500/30 bg-green-500/100/10" : "border-border bg-secondary/30",
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-2">
          <Search className={cn("w-4 h-4 shrink-0", allDone ? "text-green-500" : "text-muted-foreground")} />
          <span className="text-sm font-semibold text-foreground">Deep Investigation</span>
          <span className="ml-auto text-xs font-medium px-1.5 py-0.5 rounded flex items-center gap-1 bg-green-500/15 text-green-400">
            <CheckCircle2 className="w-3 h-3" />
            Done
          </span>
        </div>

        {/* Conclusion */}
        {parsed?.conclusion && (
          <div className="mb-3 text-sm text-foreground leading-relaxed [&_p]:mb-1.5 [&_p:last-child]:mb-0 [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:mb-0.5">
            <Markdown>{parsed.conclusion}</Markdown>
          </div>
        )}

        {/* Hypothesis Verdicts */}
        {sortedHypotheses.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {sortedHypotheses.map((h) => {
              const isSkipped = h.status === "skipped" || h.status === "pending"
              return (
                <div key={h.id}>
                  <div className="flex items-start gap-2">
                    <StatusIcon status={h.status} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-sm font-medium text-foreground shrink-0">{h.id}</span>
                        <span className="text-sm text-foreground truncate">{h.text}</span>
                        <span
                          className={cn(
                            "text-xs font-semibold px-1.5 py-0.5 rounded shrink-0 ml-auto",
                            h.status === "validated"
                              ? "bg-green-500/15 text-green-400"
                              : h.status === "invalidated"
                                ? "bg-red-500/15 text-red-400"
                                : h.status === "inconclusive"
                                  ? "bg-amber-500/15 text-amber-400"
                                  : "bg-secondary text-muted-foreground",
                          )}
                        >
                          {h.confidence}%
                        </span>
                      </div>
                      {!isSkipped && h.reasoning && (
                        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">{h.reasoning}</p>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Expanded details — evidence */}
        {expanded &&
          sortedHypotheses.length > 0 && (
            <div className="border-t border-green-500/30 pt-3 mb-3 space-y-3">
              {sortedHypotheses
                .filter((h) => (h.evidence && h.evidence.length > 0) || h.toolCallsUsed)
                .map((h) => (
                  <div key={h.id} className="bg-card/70 rounded-md px-3 py-2 border border-border/50">
                    <div className="flex items-center gap-2 mb-1">
                      <StatusIcon status={h.status} />
                      <span className="text-sm font-medium text-foreground">
                        {h.id}: {h.text}
                      </span>
                      <span
                        className={cn(
                          "ml-auto text-xs font-semibold px-1.5 py-0.5 rounded shrink-0",
                          h.status === "validated"
                            ? "bg-green-500/15 text-green-400"
                            : h.status === "invalidated"
                              ? "bg-red-500/15 text-red-400"
                              : h.status === "inconclusive"
                                ? "bg-amber-500/15 text-amber-400"
                                : "bg-secondary text-muted-foreground",
                        )}
                      >
                        {STATUS_LABEL[h.status]} ({h.confidence}%)
                      </span>
                    </div>
                    {h.evidence && h.evidence.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                          Evidence
                        </span>
                        {h.evidence.map((e, i) => (
                          <div key={i} className="bg-secondary rounded px-2.5 py-1.5 border border-border/50">
                            <div className="font-mono text-[11px] text-foreground truncate">
                              <span className="text-muted-foreground/70">{e.tool}:</span> {e.command}
                            </div>
                            {e.outputPreview && (
                              <pre className="text-[11px] text-muted-foreground mt-1 whitespace-pre-wrap line-clamp-3 leading-relaxed">
                                {e.outputPreview}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {h.toolCallsUsed != null && (
                      <p className="text-[11px] text-muted-foreground/70 mt-1.5">{h.toolCallsUsed} tool calls</p>
                    )}
                  </div>
                ))}
            </div>
          )}

        {/* Statistics bar */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            {(() => {
              const calls =
                parsed?.stats.toolCalls ?? (message.toolDetails?.totalToolCalls as number | undefined) ?? 0
              return calls > 0 ? <span>{calls} calls</span> : null
            })()}
            {(() => {
              if (parsed?.stats.duration) return <span>{parsed.stats.duration}</span>
              const ms = message.toolDetails?.durationMs as number | undefined
              if (ms) return <span>{(ms / 1000).toFixed(1)}s</span>
              return null
            })()}
            {parsed?.stats.hypothesesSummary && <span>{parsed.stats.hypothesesSummary}</span>}
          </div>

          {hasEvidence && (
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <>
                  <span>Collapse</span>
                  <ChevronUp className="w-3.5 h-3.5" />
                </>
              ) : (
                <>
                  <span>Evidence</span>
                  <ChevronDown className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          )}
        </div>

        {/* Report path */}
        {expanded && reportPath && (
          <div className="mt-2 pt-2 border-t border-green-500/30">
            <span className="text-xs text-muted-foreground/70">Full report: </span>
            <code className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">{reportPath}</code>
          </div>
        )}
      </div>
    </div>
  )
}
