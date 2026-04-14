import { useState, useEffect, useCallback, useRef } from "react"
import { Plus, Trash2, Loader2, MessageSquare, Search, Pencil, Check, X, History } from "lucide-react"
import { api } from "../api"
import { useToast } from "./toast"
import { useConfirm } from "./confirm-dialog"
import { usePilotChat } from "../hooks/usePilotChat"
import { PilotArea } from "./chat/PilotArea"
import { SkillPanel } from "./chat/SkillPanel"
import { SchedulePanel } from "./chat/SchedulePanel"
import type { PilotMessage } from "./chat/types"

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
}

export function AgentChat({ agentId }: AgentChatProps) {
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [showSessions, setShowSessions] = useState(false)

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Panel state
  const [skillPanelMsg, setSkillPanelMsg] = useState<PilotMessage | null>(null)
  const [schedulePanelMsg, setSchedulePanelMsg] = useState<PilotMessage | null>(null)

  // Auto-title: track whether we already titled this session
  const titledSessionRef = useRef<string | null>(null)

  // Pilot-style chat hook
  const pilot = usePilotChat({ agentId, sessionId: activeSessionId })

  // Fetch sessions
  useEffect(() => {
    let cancelled = false
    async function fetchSessions() {
      try {
        setLoading(true)
        const res = await api<{ data: ChatSession[] }>(`/siclaw/agents/${agentId}/chat/sessions`)
        const items = Array.isArray(res.data) ? res.data : Array.isArray(res) ? (res as any) : []
        if (!cancelled) {
          setSessions(items)
          if (items.length > 0 && !activeSessionId) {
            setActiveSessionId(items[0].id)
          }
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
  }, [agentId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-generate title from first user message (only if still default name)
  useEffect(() => {
    if (!activeSessionId) return
    if (titledSessionRef.current === activeSessionId) return
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
  }, [activeSessionId, pilot.messages, sessions, agentId])

  // Close panels on session switch
  useEffect(() => {
    setSkillPanelMsg(null)
    setSchedulePanelMsg(null)
  }, [activeSessionId])

  const handleNewSession = useCallback(async () => {
    try {
      const session = await api<ChatSession>(`/siclaw/agents/${agentId}/chat/sessions`, { method: "POST" })
      setSessions((prev) => [session, ...prev])
      setActiveSessionId(session.id)
    } catch (err: any) {
      toast.error(err.message || "Failed to create session")
    }
  }, [agentId, toast])

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
        setSessions((prev) => prev.filter((s) => s.id !== sid))
        if (activeSessionId === sid) {
          setActiveSessionId(null)
        }
        toast.success("Session deleted")
      } catch (err: any) {
        toast.error(err.message || "Failed to delete session")
      }
    },
    [agentId, activeSessionId, toast, confirmDialog],
  )

  // Wrap send to also handle first-message session creation
  const handleSend = useCallback(
    (text: string) => {
      if (!activeSessionId) {
        // Create a new session first, then send
        api<ChatSession>(`/siclaw/agents/${agentId}/chat/sessions`, { method: "POST" })
          .then((session) => {
            setSessions((prev) => [session, ...prev])
            setActiveSessionId(session.id)
            // Short delay to let state propagate
            setTimeout(() => pilot.send(text), 50)
          })
          .catch((err: any) => {
            toast.error(err.message || "Failed to create session")
          })
        return
      }
      pilot.send(text)
    },
    [activeSessionId, agentId, pilot, toast],
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
          <div className="absolute inset-0 z-10" onClick={() => setShowSessions(false)} />
          <div className="absolute top-0 left-0 bottom-0 z-20 w-[280px] bg-card border-r border-border shadow-lg shadow-black/20 flex flex-col">
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
              onSelect={(id) => { setActiveSessionId(id); setShowSessions(false) }}
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
      <div className="flex flex-1 overflow-hidden">
        {activeSessionId ? (
          <>
            <PilotArea
              messages={pilot.messages}
              isLoading={pilot.streaming}
              hasMore={pilot.hasMore}
              loadingMore={pilot.loadingMore}
              onLoadMore={pilot.loadMore}
              sendMessage={handleSend}
              abortResponse={pilot.abort}
              contextUsage={pilot.contextUsage}
              pendingMessages={pilot.pendingMessages}
              onRemovePending={pilot.removePending}
              investigationProgress={pilot.dpProgress}
              dpActive={pilot.dpActive}
              onSetDpActive={pilot.setDpActive}
              dpFocus={pilot.dpFocus}
              dpChecklist={pilot.dpChecklist}
              onHypothesesConfirmed={pilot.onHypothesesConfirmed}
              onExitDp={pilot.exitDp}
              sessionKey={activeSessionId}
              onOpenSkillPanel={(msg) => {
                setSchedulePanelMsg(null)
                setSkillPanelMsg(msg)
              }}
              onOpenSchedulePanel={(msg) => {
                setSkillPanelMsg(null)
                setSchedulePanelMsg(msg)
              }}
            />
            {skillPanelMsg && (
              <SkillPanel message={skillPanelMsg} onClose={() => setSkillPanelMsg(null)} />
            )}
            {schedulePanelMsg && (
              <SchedulePanel message={schedulePanelMsg} onClose={() => setSchedulePanelMsg(null)} />
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center flex-1">
            <MessageSquare className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-[13px] text-muted-foreground">Select or create a session to begin</p>
          </div>
        )}
      </div>
    </div>
  )
}
