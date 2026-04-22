import { useState } from "react"
import { Loader2, AlertCircle, ChevronDown, ChevronRight, Wrench } from "lucide-react"
import { Markdown } from "./chat/Markdown"

export interface TraceMessage {
  id: string
  role: "user" | "assistant" | "tool"
  content: string
  toolName?: string | null
  toolInput?: string | null
  outcome?: "success" | "error" | "blocked" | null
  durationMs?: number | null
  timestamp?: string | null
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m ${secs}s`
}

export function TraceView({
  loading,
  error,
  messages,
  truncated,
}: {
  loading: boolean
  error: string | null
  messages: TraceMessage[]
  truncated: boolean
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-[12px] text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading trace...
      </div>
    )
  }
  if (error) {
    return (
      <div className="rounded-md border border-red-500/20 bg-red-500/5 p-3 text-[12px] text-red-400">
        Failed to load trace: {error}
      </div>
    )
  }
  if (messages.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground/50 italic py-4 text-center">
        No trace recorded
      </p>
    )
  }
  return (
    <div className="space-y-1.5">
      {truncated && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md border border-amber-500/20 bg-amber-500/5 text-[10px] text-amber-400">
          <AlertCircle className="h-3 w-3 shrink-0" />
          Showing the most recent {messages.length} messages — older messages omitted.
        </div>
      )}
      {messages.map((m) => (
        <TraceMessageRow key={m.id} message={m} />
      ))}
    </div>
  )
}

function TraceMessageRow({ message }: { message: TraceMessage }) {
  const [expanded, setExpanded] = useState(false)

  if (message.role === "user") {
    return (
      <div className="px-3 py-2 rounded-md border border-blue-500/20 bg-blue-500/5">
        <div className="text-[10px] font-medium text-blue-400 uppercase tracking-wider mb-1">User</div>
        <div className="text-[12px] text-foreground/90 whitespace-pre-wrap break-words">{message.content}</div>
      </div>
    )
  }
  if (message.role === "assistant") {
    return (
      <div className="px-3 py-2 rounded-md border border-border bg-background">
        <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Assistant</div>
        <div className="prose prose-invert prose-sm max-w-none text-[12px]">
          <Markdown>{message.content}</Markdown>
        </div>
      </div>
    )
  }
  const outcomeColor =
    message.outcome === "error" ? "text-red-400"
      : message.outcome === "blocked" ? "text-orange-400"
      : message.outcome === "success" ? "text-green-400"
      : "text-muted-foreground/70"
  return (
    <div className="rounded-md border border-border overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-secondary/30 transition-colors text-left"
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        }
        <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-[12px] font-mono text-foreground/90 truncate flex-1">
          {message.toolName || "tool"}
        </span>
        {message.outcome && (
          <span className={`text-[10px] font-medium uppercase ${outcomeColor}`}>
            {message.outcome}
          </span>
        )}
        {message.durationMs != null && (
          <span className="text-[10px] text-muted-foreground/60 tabular-nums">
            {formatDuration(message.durationMs)}
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2 bg-background/60 space-y-2">
          {message.toolInput && (
            <div>
              <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Input</div>
              <pre className="text-[11px] text-foreground/80 bg-background border border-border rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
                {message.toolInput}
              </pre>
            </div>
          )}
          {message.content && (
            <div>
              <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Output</div>
              <pre className="text-[11px] text-foreground/80 bg-background border border-border rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
                {message.content}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
