import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { Plus, Trash2, Loader2, MessageSquare, Search, Pencil, Check, X, History, Info } from "lucide-react"
import { api } from "../api"
import { useToast } from "./toast"
import { useConfirm } from "./confirm-dialog"
import { usePilotChat } from "../hooks/usePilotChat"
import { PilotArea } from "./chat/PilotArea"
import { SkillPanel } from "./chat/SkillPanel"
import { SchedulePanel } from "./chat/SchedulePanel"
import { PlanPanel } from "./plan/PlanPanel"
import { foldPlan } from "./plan/foldPlan"
import { SubagentTranscript } from "./plan/SubagentTranscript"
import { PeerSessionView } from "./chat/PeerSessionView"
import { latestDelegateCardStatus } from "../lib/delegateCard"
import { JobsBar } from "./plan/JobsBar"
import type { ChatAttachment, PilotMessage } from "./chat/types"

interface ChatSession {
  id: string
  title?: string
  created_at: string
  updated_at?: string
}

// ── Session Sidebar ────────────────────────────────────────

function SessionSidebar({
  sessions, activeSessionId, agentId, onSelect, onNew, onDelete, onRenamed,
}: {
  sessions: ChatSession[]
  activeSessionId: string | null
  agentId: string
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRenamed: (id: string, title: string) => void
}) {
  const toast = useToast()
  const [search, setSearch] = useState("")
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")

  const filtered = search
    ? sessions.filter(s => (s.title || "").toLowerCase().includes(search.toLowerCase()))
    : sessions

  const handleStartRename = (s: ChatSession) => {
    setRenamingId(s.id)
    setRenameValue(s.title || "")
  }

  const handleSaveRename = async () => {
    if (!renamingId || !renameValue.trim()) return
    try {
      await api(`/siclaw/agents/${agentId}/chat/sessions/${renamingId}`, {
        method: "PUT", body: { title: renameValue.trim() },
      })
      onRenamed(renamingId, renameValue.trim())
      setRenamingId(null)
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-border space-y-2">
        <button
          onClick={onNew}
          className="flex items-center gap-1.5 w-full h-8 px-3 text-[13px] rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/50"
        >
          <Plus className="h-3.5 w-3.5" />
          New Session
        </button>
        {sessions.length > 3 && (
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search sessions..."
              className="w-full h-7 pl-7 pr-2 text-[12px] rounded-md border border-border bg-background"
            />
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="text-[12px] text-muted-foreground/60 text-center py-8">
            {search ? "No matches" : "No sessions"}
          </p>
        ) : (
          filtered.map(s => (
            <div
              key={s.id}
              onClick={() => { if (renamingId !== s.id) onSelect(s.id) }}
              className={`group flex items-center justify-between px-3 py-2.5 cursor-pointer border-b border-border/20 transition-colors ${
                activeSessionId === s.id
                  ? "bg-secondary/50 text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/30"
              }`}
            >
              {renamingId === s.id ? (
                <div className="flex items-center gap-1 flex-1 min-w-0" onClick={e => e.stopPropagation()}>
                  <input
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSaveRename(); if (e.key === "Escape") setRenamingId(null); }}
                    autoFocus
                    className="flex-1 h-6 px-1.5 text-[12px] rounded border border-border bg-background min-w-0"
                  />
                  <button onClick={handleSaveRename} title="Save" className="p-0.5 rounded hover:bg-secondary text-green-400"><Check className="h-3 w-3" /></button>
                  <button onClick={() => setRenamingId(null)} title="Cancel" className="p-0.5 rounded hover:bg-secondary text-muted-foreground"><X className="h-3 w-3" /></button>
                </div>
              ) : (
                <>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] truncate">{s.title || "Untitled"}</p>
                    <p className="text-[10px] text-muted-foreground/60">
                      {new Date(s.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
                    <button onClick={e => { e.stopPropagation(); handleStartRename(s) }} title="Rename" className="p-1 rounded hover:bg-secondary text-muted-foreground"><Pencil className="h-3 w-3" /></button>
                    <button onClick={e => { e.stopPropagation(); onDelete(s.id) }} title="Delete" className="p-1 rounded hover:bg-destructive/20 hover:text-red-400 text-muted-foreground"><Trash2 className="h-3 w-3" /></button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ── AgentChat Main ─────────────────────────────────────────

interface AgentChatProps {
  agentId: string
  selectedSessionId?: string | null
  onSessionChange?: (sessionId: string | null) => void
}

export function AgentChat({ agentId, selectedSessionId, onSessionChange }: AgentChatProps) {
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [showSessions, setShowSessions] = useState(false)

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const activeSessionIdRef = useRef<string | null>(null)
  const selectedSessionIdRef = useRef<string | null | undefined>(selectedSessionId)

  // Panel state
  const [skillPanelMsg, setSkillPanelMsg] = useState<PilotMessage | null>(null)
  const [schedulePanelMsg, setSchedulePanelMsg] = useState<PilotMessage | null>(null)
  const [showPlan, setShowPlan] = useState(true)
  const [subagentDrill, setSubagentDrill] = useState<{ childSessionId: string; status?: string; label?: string; full?: boolean } | null>(null)

  // Auto-title: track whether we already titled this session
  const titledSessionRef = useRef<string | null>(null)

  const selectSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId
    setActiveSessionId(sessionId)
    onSessionChange?.(sessionId)
  }, [onSessionChange])

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId
  }, [activeSessionId])

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId
  }, [selectedSessionId])

  // Pilot-style chat hook
  const pilot = usePilotChat({ agentId, sessionId: activeSessionId })

  // Plan panel visibility. The backend auto-clears a fully-completed plan ~5s
  // after completion and emits a `reset` task_event — but that reset fires after
  // the turn's SSE stream has already closed, so the live client only picks it up
  // on reload (hence "only disappears on refresh"). Mirror the 5s auto-hide on the
  // client so the panel goes away live; the persisted reset keeps it hidden after
  // a refresh, and a new (incomplete) plan reveals it again.
  const plan = useMemo(() => foldPlan(pilot.messages), [pilot.messages])
  const planExists = plan.length > 0
  const planDone = planExists && plan.every((t) => t.group === "completed")
  const [planAutoHidden, setPlanAutoHidden] = useState(false)
  useEffect(() => {
    if (!planDone) {
      setPlanAutoHidden(false) // no plan, or a fresh/incomplete one → keep it visible
      return
    }
    const timer = window.setTimeout(() => setPlanAutoHidden(true), 5000)
    return () => window.clearTimeout(timer)
  }, [planDone])
  const planActive = planExists && !planAutoHidden

  // Fetch sessions
  useEffect(() => {
    let cancelled = false
    async function fetchSessions() {
      try {
        setLoading(true)
        const res = await api<{ data: ChatSession[] }>(`/siclaw/agents/${agentId}/chat/sessions`)
        const items: ChatSession[] = Array.isArray(res.data)
          ? res.data
          : Array.isArray(res)
            ? (res as ChatSession[])
            : []
        if (!cancelled) {
          setSessions(items)
          const hasSession = (sessionId: string | null | undefined) => (
            Boolean(sessionId) && items.some((item) => item.id === sessionId)
          )
          const requestedSessionId = selectedSessionIdRef.current
          const currentSessionId = activeSessionIdRef.current
          const nextSessionId = hasSession(requestedSessionId)
            ? requestedSessionId!
            : hasSession(currentSessionId)
              ? currentSessionId!
              : items[0]?.id || null
          selectSession(nextSessionId)
        }
      } catch (err: any) {
        if (!cancelled) toast.error(err.message || "Failed to load sessions")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchSessions()
    return () => {
      cancelled = true
    }
  }, [agentId, selectSession, toast])

  useEffect(() => {
    if (selectedSessionId === undefined) return

    const hasSession = (sessionId: string | null | undefined) => (
      Boolean(sessionId) && sessions.some((item) => item.id === sessionId)
    )

    if (selectedSessionId && hasSession(selectedSessionId)) {
      if (activeSessionId !== selectedSessionId) {
        selectSession(selectedSessionId)
      }
      return
    }

    if (selectedSessionId && sessions.length > 0) {
      const fallbackSessionId = hasSession(activeSessionId)
        ? activeSessionId
        : sessions[0].id
      selectSession(fallbackSessionId)
      return
    }

    if (!selectedSessionId && sessions.length === 0 && activeSessionId) {
      selectSession(null)
    }
  }, [activeSessionId, selectedSessionId, selectSession, sessions])

  // Auto-generate title from first user message (only if still default name)
  useEffect(() => {
    if (!activeSessionId) return
    if (titledSessionRef.current === activeSessionId) return
    // Guard against the stale-messages race: on a session switch `activeSessionId`
    // updates synchronously, but `pilot.messages` still holds the PREVIOUS session's
    // messages until usePilotChat's async history load resolves. Without this check we
    // would derive a title from the previous session's first message and PUT it onto the
    // newly-active (often empty) session — producing a session whose title belongs to a
    // different conversation. Only proceed once the loaded messages match the active session.
    if (pilot.messagesSessionId !== activeSessionId) return
    const userMsg = pilot.messages.find((m) => m.role === "user")
    const assistantMsg = pilot.messages.find((m) => m.role === "assistant")
    if (!userMsg || !assistantMsg) return

    // Only rename if current title looks like a default ("Session ...")
    const currentSession = sessions.find((s) => s.id === activeSessionId)
    if (currentSession?.title && currentSession.title !== "New Session") return

    titledSessionRef.current = activeSessionId
    const title = userMsg.content.slice(0, 40).trim() || "Chat"
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSessionId ? { ...s, title } : s)),
    )
    // Persist to DB
    api(`/siclaw/agents/${agentId}/chat/sessions/${activeSessionId}`, {
      method: "PUT", body: { title },
    }).catch(() => {})
  }, [activeSessionId, pilot.messages, pilot.messagesSessionId, sessions, agentId])

  // Close panels on session switch
  useEffect(() => {
    setSkillPanelMsg(null)
    setSchedulePanelMsg(null)
  }, [activeSessionId])

  // Keep the open peer-session drawer's liveness in sync with the delegate card's
  // CURRENT status. `subagentDrill.status` is a snapshot captured when the drawer
  // opened, so without this the drawer's "Live" badge + forced polling would stay on
  // after the delegate card reaches a terminal state. A CONTINUED delegation reuses
  // the same child_session_id, so the timeline can hold several cards for one peer
  // session — search from the END for the LATEST matching card, so a freshly-opened
  // running continuation isn't overwritten by an earlier card's terminal status.
  useEffect(() => {
    if (!subagentDrill?.full) return
    const current = latestDelegateCardStatus(pilot.messages, subagentDrill.childSessionId)
    if (current && current !== subagentDrill.status) {
      setSubagentDrill((prev) => (prev ? { ...prev, status: current } : prev))
    }
  }, [pilot.messages, subagentDrill?.full, subagentDrill?.childSessionId, subagentDrill?.status])

  const handleNewSession = useCallback(async () => {
    try {
      const session = await api<ChatSession>(`/siclaw/agents/${agentId}/chat/sessions`, { method: "POST" })
      setSessions((prev) => [session, ...prev])
      selectSession(session.id)
    } catch (err: any) {
      toast.error(err.message || "Failed to create session")
    }
  }, [agentId, selectSession, toast])

  const handleDeleteSession = useCallback(
    async (sid: string) => {
      const ok = await confirmDialog({
        title: "Delete Session",
        message: "Are you sure you want to delete this session? All messages will be lost.",
        destructive: true,
        confirmLabel: "Delete",
      })
      if (!ok) return
      try {
        await api(`/siclaw/agents/${agentId}/chat/sessions/${sid}`, { method: "DELETE" })
        const nextSessions = sessions.filter((s) => s.id !== sid)
        setSessions(nextSessions)
        if (activeSessionId === sid) {
          selectSession(nextSessions[0]?.id || null)
        }
        toast.success("Session deleted")
      } catch (err: any) {
        toast.error(err.message || "Failed to delete session")
      }
    },
    [agentId, activeSessionId, confirmDialog, selectSession, sessions, toast],
  )

  // Wrap send to also handle first-message session creation
  const handleSend = useCallback(
    (text: string, attachments?: ChatAttachment[]) => {
      if (!activeSessionId) {
        // Create a new session first, then send
        api<ChatSession>(`/siclaw/agents/${agentId}/chat/sessions`, { method: "POST" })
          .then((session) => {
            setSessions((prev) => [session, ...prev])
            selectSession(session.id)
            // Short delay to let state propagate
            setTimeout(() => pilot.send(text, attachments), 50)
          })
          .catch((err: any) => {
            toast.error(err.message || "Failed to create session")
          })
        return
      }
      pilot.send(text, attachments)
    },
    [activeSessionId, agentId, pilot, selectSession, toast],
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="relative flex flex-col h-full overflow-hidden">
      {/* Session drawer — slides in from left */}
      {showSessions && (
        <>
          <div className="absolute inset-0 z-50 bg-background/60 backdrop-blur-sm" onClick={() => setShowSessions(false)} />
          <div className="absolute top-0 left-0 bottom-0 z-50 w-[280px] bg-card border-r border-border shadow-lg shadow-black/20 flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="text-sm font-medium">Recent Sessions</span>
              <button onClick={() => setShowSessions(false)} className="p-1 rounded-md text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <SessionSidebar
              sessions={sessions}
              activeSessionId={activeSessionId}
              agentId={agentId}
              onSelect={(id) => { selectSession(id); setShowSessions(false) }}
              onNew={() => { handleNewSession(); setShowSessions(false) }}
              onDelete={handleDeleteSession}
              onRenamed={(sid, title) => setSessions(prev => prev.map(s => s.id === sid ? { ...s, title } : s))}
            />
          </div>
        </>
      )}

      {/* Top bar — session title (clickable) + action buttons */}
      <div className="flex items-center px-3 py-2 shrink-0">
        <button
          onClick={() => setShowSessions(!showSessions)}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
          title="Session history"
        >
          <History className="h-4 w-4" />
        </button>
        <div className="ml-auto flex items-center gap-1">
          {activeSessionId && planActive && (
            <button
              onClick={() => setShowPlan((v) => !v)}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              title={showPlan ? "Hide plan" : "Show plan"}
            >
              <Info className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={handleNewSession}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title="New session"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Chat content */}
      <div className="relative flex flex-1 overflow-hidden">
        {activeSessionId ? (
          <>
            <div className="relative flex flex-1 min-w-0">
              <PilotArea
                agentId={agentId}
                messages={pilot.messages}
                isLoading={pilot.streaming}
                hasBackgroundWork={pilot.hasBackgroundWork}
                hasMore={pilot.hasMore}
                loadingMore={pilot.loadingMore}
                onLoadMore={pilot.loadMore}
                sendMessage={handleSend}
                abortResponse={pilot.abort}
                contextUsage={pilot.contextUsage}
                pendingMessages={pilot.pendingMessages}
                onRemovePending={pilot.removePending}
                dpActive={pilot.dpActive}
                onSetDpActive={pilot.setDpActive}
                sessionKey={activeSessionId}
                onOpenSkillPanel={(msg) => {
                  setSchedulePanelMsg(null)
                  setSkillPanelMsg(msg)
                }}
                onOpenSchedulePanel={(msg) => {
                  setSkillPanelMsg(null)
                  setSchedulePanelMsg(msg)
                }}
                onOpenSubagent={(childSessionId, status, label, opts) => setSubagentDrill({ childSessionId, status, label, full: opts?.full })}
              />
              {/* Plan: a floating overlay panel, toggled from the top bar's plan button. */}
              {showPlan && planActive && (
                <PlanPanel messages={pilot.messages} onClose={() => setShowPlan(false)} />
              )}
            </div>
            {skillPanelMsg && (
              <SkillPanel message={skillPanelMsg} onClose={() => setSkillPanelMsg(null)} />
            )}
            {schedulePanelMsg && (
              <SchedulePanel message={schedulePanelMsg} onClose={() => setSchedulePanelMsg(null)} />
            )}
            {subagentDrill && agentId && (
              subagentDrill.full ? (
                <PeerSessionView
                  agentId={agentId}
                  sessionId={subagentDrill.childSessionId}
                  status={subagentDrill.status}
                  label={subagentDrill.label}
                  onClose={() => setSubagentDrill(null)}
                  onOpenSubagent={(childSessionId, status, label, opts) => setSubagentDrill({ childSessionId, status, label, full: opts?.full })}
                />
              ) : (
                <SubagentTranscript
                  agentId={agentId}
                  childSessionId={subagentDrill.childSessionId}
                  status={subagentDrill.status}
                  label={subagentDrill.label}
                  onClose={() => setSubagentDrill(null)}
                />
              )
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center flex-1">
            <MessageSquare className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-[13px] text-muted-foreground">Select or create a session to begin</p>
          </div>
        )}
      </div>

      {activeSessionId && (
        <JobsBar
          messages={pilot.messages}
          onOpenSubagent={(childSessionId, status, label) => setSubagentDrill({ childSessionId, status, label })}
        />
      )}
    </div>
  )
}
