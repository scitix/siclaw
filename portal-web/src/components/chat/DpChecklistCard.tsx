import {
  Circle,
  Loader2,
  CheckCircle2,
  SearchCode,
  SkipForward,
  XCircle,
  AlertTriangle,
  Clock,
  X,
} from "lucide-react"
import { useState } from "react"
import { cn } from "./cn"
import type { DpChecklistItem, InvestigationProgress, InvestigationHypothesisProgress } from "./types"

export interface DpChecklistCardProps {
  items: DpChecklistItem[]
  investigationProgress?: InvestigationProgress | null
  onDismiss?: () => void
}

function StepIcon({ status }: { status: DpChecklistItem["status"] }) {
  if (status === "done") return <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
  if (status === "in_progress") return <Loader2 className="w-4 h-4 text-blue-500 animate-spin shrink-0 mt-0.5" />
  if (status === "skipped") return <SkipForward className="w-3.5 h-3.5 text-muted-foreground/70 shrink-0 mt-0.5" />
  if (status === "error") return <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
  return <Circle className="w-4 h-4 text-muted-foreground/50 shrink-0 mt-0.5" />
}

function HypothesisIcon({ status }: { status: string }) {
  const base = "w-3.5 h-3.5 shrink-0"
  switch (status) {
    case "validated":
      return <CheckCircle2 className={cn(base, "text-green-500")} />
    case "invalidated":
      return <XCircle className={cn(base, "text-red-400")} />
    case "inconclusive":
      return <AlertTriangle className={cn(base, "text-amber-500")} />
    case "validating":
      return <Loader2 className={cn(base, "text-blue-500 animate-spin")} />
    case "skipped":
      return <SkipForward className={cn(base, "text-muted-foreground/70")} />
    default:
      return <Clock className={cn(base, "text-muted-foreground/50")} />
  }
}

function ProgressBar({ used, max }: { used: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1 bg-gray-200 rounded-full overflow-hidden max-w-[80px]">
        <div className="h-full bg-blue-400 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-muted-foreground/70 font-mono tabular-nums">
        {used}/{max}
      </span>
    </div>
  )
}

const STATUS_COLOR: Record<string, string> = {
  validated: "text-green-600",
  invalidated: "text-red-500",
  inconclusive: "text-amber-400",
  validating: "text-blue-500",
  pending: "text-muted-foreground/70",
  skipped: "text-muted-foreground/70",
}

const STATUS_LABEL: Record<string, string> = {
  validated: "VALIDATED",
  invalidated: "INVALIDATED",
  inconclusive: "INCONCLUSIVE",
  validating: "validating...",
  pending: "pending",
  skipped: "SKIPPED",
}

function HypothesisRow({ h }: { h: InvestigationHypothesisProgress }) {
  const isDone =
    h.status === "validated" || h.status === "invalidated" || h.status === "inconclusive" || h.status === "skipped"
  const isActive = h.status === "validating"

  return (
    <div className={cn("flex items-start gap-1.5 py-0.5", isDone && "opacity-70")}>
      <HypothesisIcon status={h.status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1">
          <span
            className={cn(
              "text-xs font-medium shrink-0",
              isActive ? "text-blue-400" : isDone ? "text-muted-foreground" : "text-muted-foreground",
            )}
          >
            {h.id}
          </span>
          <span className={cn("text-xs truncate", isDone ? "text-muted-foreground/70" : "text-muted-foreground")}>{h.text}</span>
          {h.confidence > 0 && (
            <span className={cn("text-[10px] font-semibold shrink-0 ml-auto", STATUS_COLOR[h.status] || "text-muted-foreground/70")}>
              {h.confidence}%
            </span>
          )}
        </div>
        {/* Active: show progress bar + current action */}
        {isActive && (
          <div className="mt-0.5 space-y-0.5">
            {h.maxCalls > 0 && <ProgressBar used={h.callsUsed} max={h.maxCalls} />}
            {h.lastAction && <p className="text-[10px] text-blue-500 font-mono truncate">{h.lastAction}</p>}
          </div>
        )}
        {/* Done: show verdict */}
        {isDone && (
          <span className={cn("text-[10px] font-medium", STATUS_COLOR[h.status])}>
            {STATUS_LABEL[h.status]}
            {h.callsUsed > 0 && ` · ${h.callsUsed} calls`}
          </span>
        )}
      </div>
    </div>
  )
}

export function DpChecklistCard({ items, investigationProgress, onDismiss }: DpChecklistCardProps) {
  const [confirmingExit, setConfirmingExit] = useState(false)
  const done = items.filter((i) => i.status === "done" || i.status === "skipped").length
  const total = items.length
  const allDone = done === total
  const hasError = items.some((i) => i.status === "error")
  const current = items.find((i) => i.status === "in_progress") || items.find((i) => i.status === "pending")

  // Show hypothesis tree when deep_search has run
  const deepSearchItem = items.find((i) => i.id === "deep_search")
  const hypotheses = investigationProgress?.hypotheses ?? []
  const showHypothesisTree =
    (deepSearchItem?.status === "in_progress" || deepSearchItem?.status === "done" || deepSearchItem?.status === "error") &&
    hypotheses.length > 0

  return (
    <div className="pl-12">
      <div
        className={cn(
          "rounded-lg border px-4 py-3 transition-colors max-w-lg",
          hasError
            ? "border-red-500/30 bg-red-500/10/50"
            : allDone
              ? "border-green-500/30 bg-green-500/100/10"
              : "border-indigo-500/30 bg-indigo-500/10",
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-2">
          <SearchCode
            className={cn("w-4 h-4 shrink-0", hasError ? "text-red-500" : allDone ? "text-green-500" : "text-indigo-500")}
          />
          <span className="text-sm font-semibold text-foreground">Deep Investigation</span>
          {current && !allDone && current.status === "in_progress" && (
            <span className="text-xs text-muted-foreground">{current.label}</span>
          )}
          <span
            className={cn(
              "ml-auto text-xs font-medium px-1.5 py-0.5 rounded",
              hasError
                ? "bg-red-500/15 text-red-400"
                : allDone
                  ? "bg-green-500/15 text-green-400"
                  : "bg-indigo-500/15 text-indigo-400",
            )}
          >
            {done}/{total}
          </span>
          {onDismiss &&
            !allDone &&
            (confirmingExit ? (
              <div className="flex items-center gap-1 text-xs ml-1">
                <button
                  onClick={() => {
                    setConfirmingExit(false)
                    onDismiss()
                  }}
                  className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 hover:bg-red-500/20 font-medium"
                >
                  Exit
                </button>
                <button
                  onClick={() => setConfirmingExit(false)}
                  className="px-1.5 py-0.5 rounded bg-secondary text-muted-foreground hover:bg-gray-200 font-medium"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingExit(true)}
                className="ml-1 p-0.5 rounded hover:bg-gray-200 text-muted-foreground/70 hover:text-muted-foreground"
                title="Exit investigation"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            ))}
        </div>

        {/* Checklist */}
        <div className="space-y-1.5">
          {items.map((item) => (
            <div key={item.id}>
              <div className="flex items-start gap-2">
                <StepIcon status={item.status} />
                <div className="min-w-0">
                  <span
                    className={cn(
                      "text-sm leading-relaxed",
                      item.status === "done"
                        ? "text-muted-foreground/70 line-through"
                        : item.status === "skipped"
                          ? "text-muted-foreground/70"
                          : item.status === "error"
                            ? "text-red-400 font-medium"
                            : item.status === "in_progress"
                              ? "text-foreground font-medium"
                              : "text-muted-foreground",
                    )}
                  >
                    {item.label}
                  </span>
                  {item.summary &&
                    (item.status === "done" || item.status === "skipped" || item.status === "error") && (
                      <p
                        className={cn("text-xs mt-0.5", item.status === "error" ? "text-red-500" : "text-muted-foreground")}
                        style={{ textDecoration: "none" }}
                      >
                        {item.summary}
                      </p>
                    )}
                </div>
              </div>

              {/* Hypothesis tree — expanded under deep_search step */}
              {item.id === "deep_search" && showHypothesisTree && (
                <div className="ml-6 mt-1.5 mb-1 pl-2 border-l-2 border-indigo-500/30 space-y-0.5">
                  {hypotheses.map((h) => (
                    <HypothesisRow key={h.id} h={h} />
                  ))}
                  {/* Current action bar */}
                  {investigationProgress?.currentAction && (
                    <div className="flex items-center gap-1.5 mt-1 px-2 py-1 bg-blue-500/10 rounded">
                      <Loader2 className="w-3 h-3 animate-spin text-blue-400 shrink-0" />
                      <span className="text-[10px] text-blue-400 font-mono truncate">
                        {investigationProgress.currentAction}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
