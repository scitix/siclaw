import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, ChevronDown, ChevronRight, Eye, Loader2, MessageSquare, Wrench } from "lucide-react"
import {
  resolveRange,
  useSessions,
  useUsers,
  originLabel,
  type EntryMode,
  type SessionListItem,
  type TimeRange,
} from "../../hooks/useMetrics"
import { api } from "../../api"
import { SessionSnapshot } from "./SessionSnapshot"

function formatTime(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

interface AgentOption { id: string; name: string }
interface AgentGroupView { agentKey: string; label: string; sessions: SessionListItem[] }

const DEFAULT_VISIBLE_SESSIONS = 5

export function SessionTable({
  userFilterId,
  channelFilterId,
  senderFilterId,
  usernameHint,
  entry,
  timeRange,
}: {
  userFilterId: string | null
  channelFilterId: string | null
  senderFilterId: string | null
  usernameHint: string | null
  entry: EntryMode
  timeRange: TimeRange
}) {
  const [agentId, setAgentId] = useState("")
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set())
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})
  const [snapshotId, setSnapshotId] = useState<string | null>(null)  // open read-only transcript
  const { users } = useUsers()
  const userMap = useMemo(() => {
    const m = new Map<string, string>()
    users.forEach((u) => m.set(u.id, u.username))
    return m
  }, [users])

  useEffect(() => {
    let cancelled = false
    api<{ data: Array<{ id: string; name: string }> }>("/agents")
      .then((r) => {
        if (cancelled) return
        const list = Array.isArray(r.data) ? r.data : []
        setAgents(list.map((a) => ({ id: a.id, name: a.name })))
      })
      .catch(() => { /* agent names fall back to ids */ })
    return () => { cancelled = true }
  }, [])

  const params = useMemo(() => {
    const { fromMs, toMs } = resolveRange(timeRange)
    return {
      userId: userFilterId ?? undefined,
      agentId: agentId || undefined,
      channelId: channelFilterId ?? undefined,
      senderExternalId: senderFilterId ?? undefined,
      from: String(fromMs),
      to: String(toMs),
      entry,
    }
  }, [agentId, timeRange.from, timeRange.to, userFilterId, channelFilterId, senderFilterId, entry])

  const { sessions, hasMore, loading, loadMore } = useSessions(params)

  const agentOptions = useMemo(() => {
    const byId = new Map<string, AgentOption>()
    agents.forEach((a) => byId.set(a.id, a))
    sessions.forEach((s) => {
      if (!byId.has(s.agentId)) byId.set(s.agentId, { id: s.agentId, name: s.agentName ?? s.agentId })
    })
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [agents, sessions])

  const groupedAgents = useMemo<AgentGroupView[]>(() => {
    const byAgent = new Map<string, AgentGroupView>()
    sessions.forEach((session) => {
      let g = byAgent.get(session.agentId)
      if (!g) {
        g = { agentKey: session.agentId, label: session.agentName ?? session.agentId, sessions: [] }
        byAgent.set(session.agentId, g)
      }
      g.sessions.push(session)
    })
    return Array.from(byAgent.values())
      .map((g) => ({
        ...g,
        sessions: [...g.sessions].sort((a, b) => new Date(b.activityAt).getTime() - new Date(a.activityAt).getTime()),
      }))
      .sort((a, b) => new Date(b.sessions[0]?.activityAt ?? 0).getTime() - new Date(a.sessions[0]?.activityAt ?? 0).getTime())
  }, [sessions])

  // Reset expand/visible state whenever the result set's shape changes.
  const groupSignature = groupedAgents.map((g) => `${g.agentKey}:${g.sessions.length}`).join("|")
  useEffect(() => {
    setExpandedAgents(new Set(groupedAgents.map((g) => g.agentKey)))
    setVisibleCounts(Object.fromEntries(groupedAgents.map((g) => [g.agentKey, Math.min(DEFAULT_VISIBLE_SESSIONS, g.sessions.length)])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupSignature])

  const toggleAgent = (key: string) =>
    setExpandedAgents((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const expandAll = () => setExpandedAgents(new Set(groupedAgents.map((g) => g.agentKey)))
  const collapseAll = () => setExpandedAgents(new Set())
  const showMore = (key: string) =>
    setVisibleCounts((prev) => {
      const g = groupedAgents.find((x) => x.agentKey === key)
      return g ? { ...prev, [key]: g.sessions.length } : prev
    })

  const openSession = (s: SessionListItem) => setSnapshotId(s.sessionId)
  // Channel rows: the actor is the sender (open_id); other origins: the owner.
  const usernameFor = (s: SessionListItem) =>
    s.origin === "channel" ? (s.senderId ?? "—") : (s.userId ? userMap.get(s.userId) ?? s.userId : "—")

  return (
    <section className="px-6 py-6 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {usernameHint && (
          <span className="text-[11px] px-2 py-1 rounded bg-secondary border border-border text-muted-foreground">
            user: <span className="text-foreground font-mono">{usernameHint}</span>
          </span>
        )}
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="h-8 px-2 pr-6 text-[12px] rounded-md bg-secondary border border-border text-foreground focus:outline-none focus:border-blue-500"
        >
          <option value="">All Agents</option>
          {agentOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {groupedAgents.length > 0 && (
          <div className="inline-flex h-8 rounded-md border border-border bg-secondary p-0.5 text-[12px]">
            <button onClick={expandAll} className="inline-flex items-center gap-1.5 px-2.5 rounded text-muted-foreground hover:text-foreground hover:bg-background">
              <ChevronDown className="h-3.5 w-3.5" />Expand all
            </button>
            <button onClick={collapseAll} className="inline-flex items-center gap-1.5 px-2.5 rounded text-muted-foreground hover:text-foreground hover:bg-background">
              <ChevronRight className="h-3.5 w-3.5" />Collapse all
            </button>
          </div>
        )}
        <div className="flex-1" />
        <div className="text-[11px] text-muted-foreground font-mono">{sessions.length} sessions{hasMore ? "+" : ""}</div>
      </div>

      <div className="border border-border rounded-lg bg-card overflow-hidden">
        <table className="w-full text-[12px] table-fixed">
          <thead className="bg-secondary/40">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left px-4 py-2.5 font-medium w-44">Time</th>
              <th className="text-left px-3 py-2.5 font-medium">Session</th>
              <th className="text-right px-3 py-2.5 font-medium w-24">Messages</th>
              <th className="text-right px-3 py-2.5 font-medium w-20">Tools</th>
              <th className="text-right px-3 py-2.5 font-medium w-20">Errors</th>
              <th className="text-right px-4 py-2.5 font-medium w-16">Open</th>
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 && !loading ? (
              <tr><td colSpan={6} className="text-center py-12 text-muted-foreground text-[12px]">No sessions found</td></tr>
            ) : (
              groupedAgents.map((g, i) => (
                <SessionAgentGroup
                  key={g.agentKey}
                  group={g}
                  isFirst={i === 0}
                  expanded={expandedAgents.has(g.agentKey)}
                  visibleCount={visibleCounts[g.agentKey] ?? DEFAULT_VISIBLE_SESSIONS}
                  usernameFor={usernameFor}
                  onToggle={() => toggleAgent(g.agentKey)}
                  onShowMore={() => showMore(g.agentKey)}
                  onOpen={openSession}
                />
              ))
            )}
          </tbody>
        </table>
        <div className="flex items-center justify-between px-4 py-3 border-t border-border text-[11px] text-muted-foreground">
          <span>{loading ? "Loading…" : `Showing ${sessions.length}`}</span>
          {hasMore && (
            <button onClick={loadMore} disabled={loading} className="inline-flex items-center gap-1.5 px-3 py-1 rounded border border-border hover:bg-secondary text-foreground disabled:opacity-50">
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Load More ↓"}
            </button>
          )}
        </div>
      </div>

      {snapshotId && <SessionSnapshot sessionId={snapshotId} onClose={() => setSnapshotId(null)} />}
    </section>
  )
}

function SessionAgentGroup({
  group,
  isFirst,
  expanded,
  visibleCount,
  usernameFor,
  onToggle,
  onShowMore,
  onOpen,
}: {
  group: AgentGroupView
  isFirst: boolean
  expanded: boolean
  visibleCount: number
  usernameFor: (s: SessionListItem) => string
  onToggle: () => void
  onShowMore: () => void
  onOpen: (s: SessionListItem) => void
}) {
  const visible = group.sessions.slice(0, Math.min(visibleCount, group.sessions.length))
  const hidden = Math.max(group.sessions.length - visible.length, 0)
  const totals = useMemo(
    () => group.sessions.reduce(
      (acc, s) => ({ messages: acc.messages + s.messageCount, tools: acc.tools + s.toolCallCount, errors: acc.errors + s.errorToolCallCount }),
      { messages: 0, tools: 0, errors: 0 },
    ),
    [group.sessions],
  )
  return (
    <>
      {!isFirst && (
        <tr aria-hidden="true" className="h-2 bg-background"><td colSpan={6} className="border-t border-border/70 p-0" /></tr>
      )}
      <tr className="border-t border-border bg-secondary/45 hover:bg-secondary/60">
        <td colSpan={2} className="border-l-2 border-blue-500/40 px-7 py-2.5 text-[11px] text-muted-foreground">
          <button onClick={onToggle} className="inline-flex items-center gap-2 text-left" aria-expanded={expanded}>
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span className="inline-flex h-5 w-5 items-center justify-center rounded border border-border/70 bg-background text-muted-foreground">
              <MessageSquare className="h-3.5 w-3.5" />
            </span>
            <span className="font-medium text-foreground">{group.label}</span>
            <span>· {group.sessions.length} sessions</span>
          </button>
        </td>
        <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">{totals.messages}</td>
        <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">{totals.tools}</td>
        <td className={`px-3 py-2.5 text-right font-mono ${totals.errors > 0 ? "text-red-400" : "text-muted-foreground"}`}>{totals.errors}</td>
        <td className="px-4 py-2.5 text-right text-[11px] text-muted-foreground">
          {expanded ? `${visible.length}/${group.sessions.length}` : "—"}
        </td>
      </tr>
      {expanded && visible.map((s) => (
        <SessionRow key={s.sessionId} session={s} username={usernameFor(s)} onOpen={() => onOpen(s)} />
      ))}
      {expanded && hidden > 0 && (
        <tr className="border-t border-border/50 bg-background">
          <td className="px-4 py-2" />
          <td colSpan={5} className="px-6 py-2 text-[12px]">
            <button onClick={onShowMore} className="text-muted-foreground hover:text-foreground">Show {hidden} more…</button>
          </td>
        </tr>
      )}
    </>
  )
}

function SessionRow({ session, username, onOpen }: { session: SessionListItem; username: string; onOpen: () => void }) {
  const title = session.title || "Untitled session"
  return (
    <tr className="border-t border-border/50 hover:bg-secondary/20">
      <td className="py-2.5 pl-8 pr-4 font-mono text-[11px] text-muted-foreground whitespace-nowrap">{formatTime(session.activityAt)}</td>
      <td className="px-6 py-2.5 min-w-0">
        <div className="min-w-0">
          <div className="truncate text-foreground" title={title}>{title}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground min-w-0">
            <span className="font-mono shrink-0" title={session.sessionId}>{shortId(session.sessionId)}</span>
            <span className="shrink-0">{username}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-secondary shrink-0">{originLabel(session.origin)}</span>
            {session.preview && <span className="truncate" title={session.preview}>{session.preview}</span>}
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">{session.messageCount}</td>
      <td className="px-3 py-2.5 text-right">
        <span className="inline-flex items-center justify-end gap-1 font-mono text-muted-foreground"><Wrench className="h-3 w-3" />{session.toolCallCount}</span>
      </td>
      <td className="px-3 py-2.5 text-right">
        <span className={session.errorToolCallCount > 0 ? "inline-flex items-center justify-end gap-1 font-mono text-red-400" : "font-mono text-muted-foreground"}>
          {session.errorToolCallCount > 0 && <AlertTriangle className="h-3 w-3" />}{session.errorToolCallCount}
        </span>
      </td>
      <td className="px-4 py-2.5 text-right">
        <button onClick={onOpen} title="View transcript" className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-border hover:bg-secondary text-foreground">
          <Eye className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  )
}
