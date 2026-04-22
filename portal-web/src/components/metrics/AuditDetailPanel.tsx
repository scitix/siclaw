import { useState } from "react"
import { Loader2 } from "lucide-react"
import { useAuditDetail, type AuditLog } from "../../hooks/useMetrics"

function formatDuration(ms: number | null): string {
  if (ms == null) return "—"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function AuditDetailPanel({ log }: { log: AuditLog }) {
  const { detail, loading } = useAuditDetail(log.id)
  const [showFull, setShowFull] = useState(false)

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-[12px]">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    )
  }
  if (!detail) return <div className="text-muted-foreground text-[12px]">Failed to load details</div>

  // Try to parse toolInput for structured display
  let parsedInput: Record<string, unknown> | null = null
  try { if (detail.toolInput) parsedInput = JSON.parse(detail.toolInput) } catch { /* ignore */ }

  const content = detail.content ?? ""
  const isLong = content.length > 800
  const displayContent = showFull || !isLong ? content : content.slice(0, 800) + "…"

  const outcomeColor = detail.outcome === "success" ? "text-green-400"
    : detail.outcome === "error" ? "text-red-400"
    : detail.outcome === "blocked" ? "text-amber-400"
    : "text-muted-foreground"

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[12px]">
        <span className="text-muted-foreground">Tool</span>
        <span className="font-mono">{detail.toolName ?? "—"}</span>

        {parsedInput && detail.toolName === "local_script" && (
          <>
            <span className="text-muted-foreground">Skill</span>
            <span className="font-mono">{String((parsedInput as Record<string, unknown>).skill ?? "")}</span>
            <span className="text-muted-foreground">Script</span>
            <span className="font-mono">{String((parsedInput as Record<string, unknown>).script ?? "")}</span>
            {(parsedInput as Record<string, unknown>).args && (
              <>
                <span className="text-muted-foreground">Args</span>
                <span className="font-mono text-muted-foreground">{String((parsedInput as Record<string, unknown>).args)}</span>
              </>
            )}
          </>
        )}

        <span className="text-muted-foreground">Outcome</span>
        <span className={`font-medium ${outcomeColor}`}>{detail.outcome ?? "—"}</span>

        <span className="text-muted-foreground">Duration</span>
        <span>{formatDuration(detail.durationMs)}</span>

        {detail.sessionId && (
          <>
            <span className="text-muted-foreground">Session</span>
            <span className="font-mono text-[11px] text-muted-foreground">{detail.sessionId}</span>
          </>
        )}
      </div>

      {detail.toolInput && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Command</div>
          <pre className="p-3 bg-black/60 text-foreground rounded-md text-[11px] font-mono overflow-auto max-h-48 border border-border">
{detail.toolInput}
          </pre>
        </div>
      )}

      {content && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Output</div>
          <pre className={`p-3 bg-black/60 text-foreground rounded-md text-[11px] font-mono overflow-auto border border-border ${!showFull && isLong ? "max-h-64" : "max-h-[500px]"}`}>
{displayContent}
          </pre>
          {isLong && (
            <button
              onClick={() => setShowFull(!showFull)}
              className="mt-1 text-[11px] text-blue-400 hover:text-blue-300"
            >
              {showFull ? "Show less" : "Show full output"}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
