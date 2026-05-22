import { useState, useEffect, useCallback, useRef } from "react"
import { Plus, Trash2, Loader2, MessageSquare, Search, Pencil, Check, X, History, Pin } from "lucide-react"
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
  last_active_at?: string
  last_viewed_at?: string | null
  pinned_at?: string | null
  message_count?: number
}

// ── Session Sidebar ────────────────────────────────────────

const DEFAULT_VISIBLE_SESSIONS = 5

function parsePortalTimestamp(value?: string | null): Date | null {
  if (!value) return null
  const isoish = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value
  const ms = Date.parse(isoish)
  return Number.isFinite(ms) ? new Date(ms) : null
}

function sessionActivityDate(session: ChatSession): Date | null {
  return parsePortalTimestamp(session.last_active_at ?? session.updated_at ?? session.created_at)
}

function formatSessionAge(session: ChatSession, now = new Date()): string {
  const activity = sessionActivityDate(session)
  if (!activity) return ""
  const diffMs = Math.max(0, now.getTime() - activity.getTime())
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diffMs < minute) return "now"
  if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))}m`
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h`
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d`
  const sameYear = activity.getFullYear() === now.getFullYear()
  return activity.toLocaleDateString(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" })
}

function formatSessionTooltip(session: ChatSession): string {
  const activity = sessionActivityDate(session)
  if (!activity) return ""
  return activity.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function sortSessions(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => {
    const aPinned = a.pinned_at ? 0 : 1
    const bPinned = b.pinned_at ? 0 : 1
    if (aPinned !== bPinned) return aPinned - bPinned
    const aPinnedAt = parsePortalTimestamp(a.pinned_at)?.getTime() ?? 0
    const bPinnedAt = parsePortalTimestamp(b.pinned_at)?.getTime() ?? 0
    if (aPinnedAt !== bPinnedAt) return bPinnedAt - aPinnedAt
    const aActive = sessionActivityDate(a)?.getTime() ?? 0
    const bActive = sessionActivityDate(b)?.getTime() ?? 0
    if (aActive !== bActive) return bActive - aActive
    return (parsePortalTimestamp(b.created_at)?.getTime() ?? 0) - (parsePortalTimestamp(a.created_at)?.getTime() ?? 0)
  })
}

function hasUnseenActivity(session: ChatSession, activeSessionId: string | null): boolean {
  if (session.id === activeSessionId) return false
  const activeAt = sessionActivityDate(session)?.getTime()
  if (!activeAt) return false
  const viewedAt = parsePortalTimestamp(session.last_viewed_at)?.getTime()
  return viewedAt == null ? Boolean(session.message_count && session.message_count > 0) : activeAt > viewedAt
}

function SessionSidebar({
  sessions, activeSessionId, agentId, onSelect, onNew, onDelete, onRenamed, onTogglePinned,
}: {
  sessions: ChatSession[]
  activeSessionId: string | null
  agentId: string
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRenamed: (id: string, title: string) => void
  onTogglePinned: (session: ChatSession) => void
}) {
  const toast = useToast()
  const [search, setSearch] = useState("")
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [showMore, setShowMore] = useState(false)
  const now = new Date()

  const filtered = search
    ? sessions.filter(s => (s.title || "").toLowerCase().includes(search.toLowerCase()))
    : sortSessions(sessions)
  const pinned = search ? [] : filtered.filter((s) => s.pinned_at)
  const normal = search ? filtered : filtered.filter((s) => !s.pinned_at)
  const visibleNormal = search || showMore ? normal : normal.slice(0, DEFAULT_VISIBLE_SESSIONS)
  const extraCount = search ? 0 : Math.max(0, normal.length - DEFAULT_VISIBLE_SESSIONS)
  const visibleSessions = search ? filtered : [...pinned, ...visibleNormal]

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

  const handleCancelRename = () => {
    setRenamingId(null)
    setRenameValue("")
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
          <>
            {visibleSessions.map(s => (
              <div
                key={s.id}
                onClick={() => { if (renamingId !== s.id) onSelect(s.id) }}
                className={`group mx-2 my-0.5 flex h-10 items-center gap-2 rounded-md px-3 cursor-pointer transition-colors ${
                  activeSessionId === s.id
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}
              >
                {renamingId === s.id ? (
                  <div className="flex items-center gap-1 flex-1 min-w-0" onClick={e => e.stopPropagation()}>
                    <input
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") handleSaveRename(); if (e.key === "Escape") handleCancelRename(); }}
                      autoFocus
                      className="flex-1 h-7 px-2 text-[13px] rounded-md border border-border bg-background min-w-0"
                    />
                    <button onClick={handleSaveRename} title="Save" className="p-1 rounded-md hover:bg-secondary text-green-400"><Check className="h-3.5 w-3.5" /></button>
                    <button onClick={handleCancelRename} title="Cancel" className="p-1 rounded-md hover:bg-secondary text-muted-foreground"><X className="h-3.5 w-3.5" /></button>
                  </div>
                ) : (
                  <>
                    <span className={`flex-1 min-w-0 truncate text-[13px] ${activeSessionId === s.id ? "font-semibold" : "font-medium"}`}>
                      {s.title || "Untitled"}
                    </span>
                    {hasUnseenActivity(s, activeSessionId) && (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" title="Updated" />
                    )}
                    <span
                      className={`shrink-0 text-[12px] text-muted-foreground/70 ${activeSessionId === s.id ? "hidden" : "group-hover:hidden"}`}
                      title={formatSessionTooltip(s)}
                    >
                      {formatSessionAge(s, now)}
                    </span>
                    <div className={`shrink-0 items-center gap-0.5 ${activeSessionId === s.id ? "flex" : "hidden group-hover:flex"}`}>
                      <button
                        onClick={e => { e.stopPropagation(); onTogglePinned(s) }}
                        title={s.pinned_at ? "Unpin session" : "Pin session"}
                        className={`p-1 rounded-md hover:bg-background/60 ${s.pinned_at ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        <Pin className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={e => { e.stopPropagation(); handleStartRename(s) }} title="Rename" className="p-1 rounded-md hover:bg-background/60 text-muted-foreground hover:text-foreground">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={e => { e.stopPropagation(); onDelete(s.id) }} title="Delete session" className="p-1 rounded-md hover:bg-background/60 text-muted-foreground hover:text-red-400">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
            {!search && extraCount > 0 && !showMore && (
              <button
                type="button"
                onClick={() => setShowMore(true)}
                className="mx-3 mt-2 px-2 py-1 text-[13px] text-muted-foreground/80 hover:text-foreground transition-colors"
              >
                Show more
              </button>
            )}
            {!search && showMore && extraCount > 0 && (
              <button
                type="button"
                onClick={() => setShowMore(false)}
                className="mx-3 mt-2 px-2 py-1 text-[13px] text-muted-foreground/80 hover:text-foreground transition-colors"
              >
                Show less
              </button>
            )}
          </>
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
          const sorted = sortSessions(items)
          setSessions(sorted)
          if (sorted.length > 0 && !activeSessionId) {
            setActiveSessionId(sorted[0].id)
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
      sortSessions(prev.map((s) => (s.id === activeSessionId ? { ...s, title } : s))),
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
      setSessions((prev) => sortSessions([session, ...prev]))
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

  const acknowledgeSession = useCallback(async (sid: string) => {
    const viewedAt = new Date().toISOString()
    setSessions((prev) => sortSessions(prev.map((s) => s.id === sid ? { ...s, last_viewed_at: viewedAt } : s)))
    try {
      const updated = await api<ChatSession>(`/siclaw/agents/${agentId}/chat/sessions/${sid}`, {
        method: "PUT",
        body: { viewed: true },
      })
      setSessions((prev) => sortSessions(prev.map((s) => s.id === sid ? updated : s)))
    } catch (err: any) {
      toast.error(err.message || "Failed to update session")
    }
  }, [agentId, toast])

  const handleSelectSession = useCallback((sid: string) => {
    setActiveSessionId(sid)
    void acknowledgeSession(sid)
  }, [acknowledgeSession])

  useEffect(() => {
    if (!activeSessionId) return
    const current = sessions.find((s) => s.id === activeSessionId)
    if (!current || !hasUnseenActivity(current, null)) return
    void acknowledgeSession(activeSessionId)
  }, [activeSessionId, acknowledgeSession, sessions])

  // Wrap send to also handle first-message session creation
  const handleSend = useCallback(
    (text: string) => {
      if (!activeSessionId) {
        // Create a new session first, then send
        api<ChatSession>(`/siclaw/agents/${agentId}/chat/sessions`, { method: "POST" })
          .then((session) => {
            setSessions((prev) => sortSessions([session, ...prev]))
            setActiveSessionId(session.id)
            // Short delay to let state propagate
            setTimeout(() => pilot.send(text), 50)
          })
          .catch((err: any) => {
            toast.error(err.message || "Failed to create session")
          })
        return
      }
      const now = new Date().toISOString()
      setSessions((prev) => sortSessions(prev.map((s) =>
        s.id === activeSessionId ? { ...s, last_active_at: now, last_viewed_at: now } : s,
      )))
      pilot.send(text)
    },
    [activeSessionId, agentId, pilot, toast],
  )

  const handleTogglePinned = useCallback(async (session: ChatSession) => {
    const pinned = !session.pinned_at
    const pinnedAt = pinned ? new Date().toISOString() : null
    const previous = sessions
    setSessions((prev) => sortSessions(prev.map((s) =>
      s.id === session.id ? { ...s, pinned_at: pinnedAt } : s,
    )))
    try {
      const updated = await api<ChatSession>(`/siclaw/agents/${agentId}/chat/sessions/${session.id}`, {
        method: "PUT",
        body: { pinned },
      })
      setSessions((prev) => sortSessions(prev.map((s) => s.id === session.id ? updated : s)))
    } catch (err: any) {
      setSessions(previous)
      toast.error(err.message || "Failed to update session")
    }
  }, [agentId, sessions, toast])

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
              onSelect={(id) => { handleSelectSession(id); setShowSessions(false) }}
              onNew={() => { handleNewSession(); setShowSessions(false) }}
              onDelete={handleDeleteSession}
              onRenamed={(sid, title) => setSessions(prev => sortSessions(prev.map(s => s.id === sid ? { ...s, title } : s)))}
              onTogglePinned={handleTogglePinned}
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
              agentId={agentId}
              messages={pilot.messages}
              isLoading={pilot.streaming}
              hasMore={pilot.hasMore}
              loadingMore={pilot.loadingMore}
              onLoadMore={pilot.loadMore}
              sendMessage={handleSend}
              abortResponse={pilot.abort}
              contextUsage={pilot.contextUsage}
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
