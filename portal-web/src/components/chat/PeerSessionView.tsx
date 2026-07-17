import { useMemo, useState } from "react"
import { X, ListTodo, Users } from "lucide-react"
import { usePilotChat } from "../../hooks/usePilotChat"
import { PilotArea } from "./PilotArea"
import { PlanPanel } from "../plan/PlanPanel"
import { foldPlan } from "../plan/foldPlan"

/**
 * Full session view for a delegated peer agent (design: delegation open-full-session).
 *
 * Unlike the compact SubagentTranscript, this reuses the MAIN window's rendering
 * machinery keyed by the peer session id — usePilotChat (history + live events SSE)
 * feeding a read-only PilotArea — so the peer's plan panel, nested subagent cards,
 * tool cards and markdown all render natively and update live. The peer session is
 * persisted (agent_id = coordinator, target_agent_id = peer) and authorized via the
 * parent-session link, so the same /chat/sessions/:id/{messages,events} endpoints work.
 */
export function PeerSessionView({
  agentId,
  sessionId,
  status,
  label,
  onClose,
  onOpenSubagent,
}: {
  agentId: string
  sessionId: string
  status?: string
  label?: string
  onClose?: () => void
  onOpenSubagent?: (childSessionId: string, status?: string, label?: string, opts?: { full?: boolean }) => void
}) {
  // Force live: the peer session runs in the peer's box, so liveness is
  // unobservable from the coordinator agent — trust the card's running status.
  const isLive = status === "running" || status === "launched"
  const pilot = usePilotChat({ agentId, sessionId, forceLive: isLive })
  const [showPlan, setShowPlan] = useState(false)
  const plan = useMemo(() => foldPlan(pilot.messages), [pilot.messages])
  const hasPlan = plan.length > 0

  return (
    <>
      {/* Backdrop — floats the drawer OVER the main window; click blank area to close. */}
      <div className="absolute inset-0 z-40 bg-black/20 backdrop-blur-[1px]" onClick={onClose} aria-hidden />
      {/* Slide-over panel */}
      <div className="absolute inset-y-0 right-0 z-50 flex w-[920px] max-w-[85vw] flex-col overflow-hidden border-l border-border bg-background shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border bg-secondary/40 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-purple-500/30 bg-purple-500/10">
            <Users className="h-3.5 w-3.5 text-purple-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-foreground">{label || "Delegated session"}</span>
              {isLive && (
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" /> Live
                </span>
              )}
            </div>
            <div className="truncate font-mono text-[10.5px] text-muted-foreground/50">{sessionId}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {hasPlan && (
            <button
              onClick={() => setShowPlan((v) => !v)}
              className={`rounded-md p-1.5 transition-colors hover:bg-secondary ${showPlan ? "text-foreground" : "text-muted-foreground"}`}
              title="Plan"
            >
              <ListTodo className="h-4 w-4" />
            </button>
          )}
          <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground" title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {/* Body — the peer's full session, rendered by the same PilotArea as the main window.
          pl insets PilotArea's left gutter so message avatars don't hug the panel border. */}
      <div className="relative flex min-w-0 flex-1 overflow-hidden pl-5">
        <PilotArea
          agentId={agentId}
          messages={pilot.messages}
          // While the delegation is running, keep the "working…" indicator on
          // continuously — driven by the delegation status, not the relayed live
          // stream (which is an unreliable proxy signal for this drawer). Content
          // fills in via the poll refetch; this guarantees the drawer never looks
          // like a dead/empty panel mid-run.
          isLoading={isLive || pilot.streaming}
          hasBackgroundWork={pilot.hasBackgroundWork}
          hasMore={pilot.hasMore}
          loadingMore={pilot.loadingMore}
          onLoadMore={pilot.loadMore}
          sendMessage={() => {}}
          sessionKey={sessionId}
          onOpenSubagent={onOpenSubagent}
          readOnly
        />
        {showPlan && hasPlan && (
          <PlanPanel messages={pilot.messages} onDrillIn={(id) => onOpenSubagent?.(id)} onClose={() => setShowPlan(false)} />
        )}
      </div>
      </div>
    </>
  )
}
