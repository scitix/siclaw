import { Clock, Check, Eye } from "lucide-react"
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

export function ScheduleCard({
  message,
  onOpenPanel,
}: {
  message: PilotMessage
  onOpenPanel?: (msg: PilotMessage) => void
}) {
  let parsed: ParsedResult | null = null
  try {
    parsed = JSON.parse(message.content)
  } catch {
    // ignore
  }

  if (!parsed || parsed.error) {
    return null
  }

  const action = parsed.action
  const isRename = action === "rename"
  const displayName = isRename
    ? `${parsed.name || parsed.id} -> ${parsed.newName}`
    : parsed.schedule?.name || parsed.name || parsed.id || "..."

  const actionLabel = (() => {
    switch (action) {
      case "delete":
        return "Delete"
      case "pause":
        return "Pause"
      case "resume":
        return "Resume"
      case "rename":
        return "Rename"
      case "update":
        return "Update"
      default:
        return "Create"
    }
  })()

  const isDelete = action === "delete"

  return (
    <div className="pl-12">
      <div
        className={cn(
          "inline-flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors",
          isDelete ? "border-red-500/30 bg-red-500/10/50" : "border-amber-200 bg-amber-500/10/50",
        )}
      >
        <Clock className={cn("w-4 h-4 shrink-0", isDelete ? "text-red-500" : "text-amber-500")} />

        <span className="text-sm font-medium text-foreground">{displayName}</span>

        {parsed.schedule && (
          <span className="font-mono text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
            {parsed.schedule.schedule}
          </span>
        )}

        <span
          className={cn(
            "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium",
            isDelete ? "bg-red-500/15 text-red-400" : "bg-amber-500/15 text-amber-400",
          )}
        >
          {actionLabel}
        </span>

        {/* View button */}
        {onOpenPanel && (
          <button
            onClick={() => onOpenPanel(message)}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-muted-foreground hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
          >
            <Eye className="w-3 h-3" />
            View
          </button>
        )}
      </div>
    </div>
  )
}
