import { useEffect, useMemo } from "react"
import { Loader2, X } from "lucide-react"
import { useSessionSnapshot, originLabel } from "../../hooks/useMetrics"
import { buildPilotMessages } from "../../hooks/usePilotChat"
import { PilotArea } from "../chat/PilotArea"

function formatTime(ts: string | null): string {
  if (!ts) return ""
  const d = new Date(ts)
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
}

const noop = () => {}

/**
 * Read-only transcript snapshot for the Metrics Sessions tab. Admin-only audit
 * view of ANY user's session — fetched via /audit/sessions/:id/messages (not the
 * owner-scoped chat endpoint). Centered modal; renders through the SAME PilotArea
 * the live chat uses (readOnly: no composer / edit / steer) so the content looks
 * identical to chat. Close returns to the session list.
 */
export function SessionSnapshot({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { data, loading, error } = useSessionSnapshot(sessionId)
  const s = data?.session

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const messages = useMemo(() => (data ? buildPilotMessages(data.data) : []), [data])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative flex h-full max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-border shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight truncate">{s?.title || "Session transcript"}</h3>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
              {s?.agentName && <span className="text-foreground">{s.agentName}</span>}
              {s && <span className="px-1.5 py-0.5 rounded text-[10px] bg-secondary">{originLabel(s.origin)}</span>}
              {s && <span className="font-mono">{s.sessionId.slice(0, 8)}…</span>}
              {s && <span>{s.messageCount} msgs</span>}
              {s?.createdAt && <span>{formatTime(s.createdAt)}</span>}
              <span className="px-1.5 py-0.5 rounded text-[10px] border border-border">Read-only</span>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground shrink-0" title="Close (Esc)">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body — identical rendering to the live chat via PilotArea (readOnly) */}
        <div className="flex-1 min-h-0 flex flex-col">
          {loading && (
            <div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          )}
          {error && !loading && (
            <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">Failed to load session transcript.</div>
          )}
          {!loading && !error && data && (
            <PilotArea
              readOnly
              messages={messages}
              isLoading={false}
              sendMessage={noop}
              agentId={s?.agentId}
              sessionKey={sessionId}
            />
          )}
        </div>

        {data?.truncated && (
          <div className="shrink-0 border-t border-border px-5 py-1.5 text-center text-[11px] text-amber-500">
            Transcript truncated — showing the first 1000 messages.
          </div>
        )}
      </div>
    </div>
  )
}
