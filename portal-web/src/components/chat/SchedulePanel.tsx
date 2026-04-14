import { useState } from "react"
import { X, Clock, Tag, ChevronRight } from "lucide-react"
import { cn } from "./cn"
import type { PilotMessage } from "./types"

interface ScheduleData {
  name: string
  description: string
  schedule: string
  status: string
}

interface ParsedResult {
  action: "create" | "update" | "delete" | "pause" | "resume" | "rename"
  id?: string
  name?: string
  newName?: string
  schedule?: ScheduleData
  summary?: string
  error?: string
}

export interface SchedulePanelProps {
  message: PilotMessage
  onClose: () => void
}

function getActionConfig(action: string) {
  switch (action) {
    case "delete":
      return {
        gradient: "from-red-50 to-orange-50",
        badge: "Delete",
        badgeColor: "bg-red-500/15 text-red-400",
        iconColor: "text-red-500",
      }
    case "pause":
      return {
        gradient: "from-amber-50 to-orange-50",
        badge: "Pause",
        badgeColor: "bg-amber-500/15 text-amber-400",
        iconColor: "text-amber-500",
      }
    case "resume":
      return {
        gradient: "from-green-50 to-emerald-50",
        badge: "Resume",
        badgeColor: "bg-green-500/15 text-green-400",
        iconColor: "text-green-500",
      }
    case "rename":
      return {
        gradient: "from-blue-50 to-indigo-50",
        badge: "Rename",
        badgeColor: "bg-blue-500/15 text-blue-400",
        iconColor: "text-blue-500",
      }
    case "update":
      return {
        gradient: "from-amber-50 to-orange-50",
        badge: "Update",
        badgeColor: "bg-amber-500/15 text-amber-400",
        iconColor: "text-amber-500",
      }
    default:
      return {
        gradient: "from-amber-50 to-yellow-50",
        badge: "Create",
        badgeColor: "bg-amber-500/15 text-amber-400",
        iconColor: "text-amber-500",
      }
  }
}

export function SchedulePanel({ message, onClose }: SchedulePanelProps) {
  const [detailsExpanded, setDetailsExpanded] = useState(true)
  const [descExpanded, setDescExpanded] = useState(true)

  let parsed: ParsedResult | null = null
  try {
    parsed = JSON.parse(message.content)
  } catch {
    // ignore
  }

  if (!parsed || parsed.error) {
    return (
      <div className="w-[480px] border-l border-border bg-card flex flex-col shrink-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm text-muted-foreground">Invalid schedule data</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-secondary">
            <X className="w-4 h-4 text-muted-foreground/70" />
          </button>
        </div>
      </div>
    )
  }

  const action = parsed.action
  const scheduleInfo = parsed.schedule
  const isRename = action === "rename"
  const displayName = isRename
    ? parsed.name || parsed.id || "..."
    : scheduleInfo?.name || parsed.name || parsed.id || "..."

  const actionConfig = getActionConfig(action)

  return (
    <div className="w-[480px] border-l border-border bg-card flex flex-col shrink-0 h-full">
      {/* Header */}
      <div
        className={cn(
          "px-4 py-3 border-b border-border bg-gradient-to-r flex items-center justify-between shrink-0",
          actionConfig.gradient,
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Clock className={cn("w-4 h-4 shrink-0", actionConfig.iconColor)} />
          <span className="font-semibold text-sm text-foreground truncate">{displayName}</span>
          <span
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0",
              actionConfig.badgeColor,
            )}
          >
            <Tag className="w-2.5 h-2.5" />
            {actionConfig.badge}
          </span>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-card/60 transition-colors shrink-0">
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* Summary */}
      {parsed.summary && (
        <div className="px-4 py-2 border-b border-border/50 text-xs text-muted-foreground">{parsed.summary}</div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Schedule Details section */}
        {(scheduleInfo || isRename) && (
          <div className="border-b border-border/50">
            <button
              type="button"
              className="flex items-center gap-2 w-full px-4 py-2.5 hover:bg-secondary transition-colors text-left"
              onClick={() => setDetailsExpanded(!detailsExpanded)}
            >
              <ChevronRight
                className={cn(
                  "w-3.5 h-3.5 text-muted-foreground/70 transition-transform",
                  detailsExpanded && "rotate-90",
                )}
              />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Schedule</span>
            </button>
            {detailsExpanded && (
              <div className="px-4 pb-3 space-y-3">
                {/* Cron expression */}
                {scheduleInfo && (
                  <div>
                    <span className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">
                      Cron Expression
                    </span>
                    <div className="font-mono text-xs text-foreground bg-secondary px-2 py-1 rounded mt-1">
                      {scheduleInfo.schedule}
                    </div>
                  </div>
                )}

                {/* Status */}
                {scheduleInfo && (
                  <div>
                    <span className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">Status</span>
                    <div className="text-xs text-foreground bg-secondary px-2 py-1 rounded mt-1">
                      {scheduleInfo.status || "active"}
                    </div>
                  </div>
                )}

                {/* Rename: old -> new name */}
                {isRename && (
                  <div>
                    <span className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">Name</span>
                    <div className="mt-1 space-y-1">
                      <div className="text-xs bg-red-500/10 text-red-400 px-2 py-1 rounded line-through">
                        {parsed?.name || parsed?.id}
                      </div>
                      <div className="text-xs bg-green-500/10 text-green-400 px-2 py-1 rounded">
                        {parsed?.newName}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Description section */}
        {scheduleInfo?.description && (
          <div className="border-b border-border/50">
            <button
              type="button"
              className="flex items-center gap-2 w-full px-4 py-2.5 hover:bg-secondary transition-colors text-left"
              onClick={() => setDescExpanded(!descExpanded)}
            >
              <ChevronRight
                className={cn(
                  "w-3.5 h-3.5 text-muted-foreground/70 transition-transform",
                  descExpanded && "rotate-90",
                )}
              />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Description</span>
            </button>
            {descExpanded && (
              <div className="px-4 pb-3">
                <pre className="text-xs font-mono leading-relaxed text-muted-foreground whitespace-pre-wrap">
                  {scheduleInfo.description}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
