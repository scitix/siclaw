import { useEffect, useState } from "react"
import { api } from "../../api"
import { Markdown } from "../chat/Markdown"

/**
 * Sub-agent transcript drill-in (design §13). A child sub-agent runs as its own
 * persisted chat_session, so we fetch its full record by childSessionId via the
 * same messages endpoint the main chat uses — available even after the sub-agent
 * is released. Shows the terminal status so "why it failed" is visible at a glance.
 */

interface ChildMessage {
  id: string
  role: string
  content?: string | null
  tool_name?: string | null
  outcome?: string | null
}

const STATUS_STYLE: Record<string, string> = {
  done: "bg-green-500/10 text-green-400 border-green-500/30",
  partial: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  failed: "bg-red-500/10 text-red-400 border-red-500/30",
  timed_out: "bg-red-500/10 text-red-400 border-red-500/30",
}

const OUTCOME_STYLE: Record<string, string> = {
  success: "text-green-400",
  error: "text-red-400",
  blocked: "text-amber-400",
}

export function SubagentTranscript({
  agentId,
  childSessionId,
  status,
  label,
  onClose,
}: {
  agentId: string
  childSessionId: string
  status?: string
  label?: string
  onClose?: () => void
}) {
  const [messages, setMessages] = useState<ChildMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api<{ data: ChildMessage[] }>(
      `/siclaw/agents/${agentId}/chat/sessions/${childSessionId}/messages?page=1&page_size=200`,
    )
      .then((res) => {
        if (cancelled) return
        setMessages(Array.isArray(res?.data) ? res.data : [])
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId, childSessionId])

  return (
    <aside className="w-96 shrink-0 flex flex-col border-l border-border bg-background overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border gap-2">
        <div className="min-w-0">
          <h2 className="text-[13px] font-medium truncate">{label || "Sub-agent"}</h2>
          <p className="text-[10px] text-muted-foreground/60 truncate">{childSessionId}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {status && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_STYLE[status] ?? "border-border text-muted-foreground"}`}>
              {status}
            </span>
          )}
          {onClose && (
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-[12px]" title="Close">✕</button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3 text-[12px]">
        {loading && <p className="text-muted-foreground/60">Loading transcript…</p>}
        {error && <p className="text-red-400">Failed to load transcript: {error}</p>}
        {!loading && !error && messages.length === 0 && (
          <p className="text-muted-foreground/60">No transcript recorded.</p>
        )}
        {messages.map((m) => (
          <div key={m.id}>
            {m.tool_name ? (
              <div className="rounded border border-border/50 px-2 py-1">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono text-muted-foreground">{m.tool_name}</span>
                  {m.outcome && <span className={OUTCOME_STYLE[m.outcome] ?? "text-muted-foreground"}>{m.outcome}</span>}
                </div>
                {m.content && (
                  <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-muted-foreground/80 max-h-40 overflow-y-auto">
                    {m.content}
                  </pre>
                )}
              </div>
            ) : (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">{m.role}</div>
                <Markdown>{m.content ?? ""}</Markdown>
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  )
}
