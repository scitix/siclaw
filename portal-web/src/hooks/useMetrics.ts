import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api"
import type { ChatMessage } from "./usePilotChat"

// ── Entry-form axis ──────────────────────────────────────
//
// Every metrics/audit query scopes to one entry form (or the combined
// overview). Mirrors `chat_sessions.origin` and the backend's metrics-entry.ts:
//
//   all (overview) — web+api+a2a+channel (the interactive family)
//   web            — origin IS NULL (Portal Web UI)
//   api            — origin = 'api'  (external API key, /api/v1/run)
//   a2a            — origin = 'a2a'  (agent-to-agent)
//   channel        — origin = 'channel' (IM: Feishu / DingTalk)
//   scheduled      — origin = 'task' (cron / scheduled runs)
//
// "all" (overview) is the combined interactive family; the other modes isolate
// a single entry form, and "scheduled" covers cron runs.
export type EntryMode = "all" | "web" | "api" | "a2a" | "channel" | "scheduled"

export const ENTRY_MODES: readonly EntryMode[] = ["all", "web", "api", "a2a", "channel", "scheduled"]

export const ENTRY_LABELS: Record<EntryMode, string> = {
  all: "Overview",
  web: "Web",
  api: "API",
  a2a: "A2A",
  channel: "Channel",
  scheduled: "Scheduled",
}

/** Label for a raw `chat_sessions.origin` value (audit-row badge). */
export function originLabel(origin: string | null): string {
  switch (origin) {
    case null:
    case "":
    case "web": return "Web"
    case "api": return "API"
    case "a2a": return "A2A"
    case "channel": return "Channel"
    case "task": return "Scheduled"
    case "delegation": return "Delegation"
    default: return origin
  }
}

// ── Types ────────────────────────────────────────────────

export interface SummaryData {
  totalSessions: number
  totalPrompts: number
  // —— 对外展示新增,随时间窗 ——
  distinctUsers: number
  toolCalls: number
  skillsUsed: number
  skillsUsedApprox?: boolean
  // —— 当前快照,不随时间窗 ——
  inventory: { clusters: number; hosts: number; skills: number; knowledgeRepos: number; agents: number; mcpServers: number }
  // —— 日级趋势(随时间窗)——
  dailySeries: Array<{ date: string; prompts: number; toolCalls: number }>
}

export interface AuditLog {
  id: string
  sessionId: string
  userId: string | null
  agentId: string | null
  agentName: string | null
  toolName: string | null
  toolInput: string | null
  outcome: string | null
  durationMs: number | null
  // Session entry-form for categorization: null/"web" → Web, "api", "a2a",
  // "channel" (IM: Feishu/DingTalk), "task" → Scheduled, "delegation".
  origin: string | null
  timestamp: string
}

// ── Timing (TTFT / thinking / per-tool latency) ──────────

export interface LatencyStats {
  count: number
  avg: number
  min: number
  max: number
  p90: number
}

export interface ToolLatencyStats extends LatencyStats {
  toolName: string
}

export interface TimingStats {
  ttft: LatencyStats
  thinking: LatencyStats
  tools: ToolLatencyStats[]
  truncated?: boolean
}

// ── Session audit (per-session counts, grouped by agent) ──

export interface SessionListItem {
  sessionId: string
  userId: string | null
  agentId: string
  agentName: string | null
  agentGroupName: string | null  // siclaw has no agent groups → always null
  title: string | null
  preview: string | null
  origin: string | null
  source: "interactive" | "scheduled"
  messageCount: number
  toolCallCount: number
  errorToolCallCount: number
  createdAt: string
  lastActiveAt: string | null
  activityAt: string
}

export interface SessionListResponse {
  sessions: SessionListItem[]
  hasMore: boolean
}

// ── Read-only session snapshot (admin audit view) ────────
//
// Returns RAW chat_messages rows (same shape the chat endpoint returns) so the
// snapshot view can map them through the same buildPilotMessages pipeline and
// render identically to the live chat.

export interface SessionSnapshotHeader {
  sessionId: string
  userId: string | null
  agentId: string
  agentName: string | null
  title: string | null
  preview: string | null
  origin: string | null
  messageCount: number
  createdAt: string
  lastActiveAt: string | null
}

export interface SessionSnapshot {
  session: SessionSnapshotHeader
  data: ChatMessage[]
  truncated: boolean
}

export interface AuditDetail extends AuditLog {
  content: string | null
}

export interface AuditResponse {
  logs: AuditLog[]
  hasMore: boolean
}

// ── Time range model ─────────────────────────────────────
//
// A TimeRange's `from`/`to` are each either a relative expression ("now",
// "now-30m") or an absolute ISO/local string. resolveRange() converts to
// absolute ms at fetch time, so the backend only ever sees absolute windows.
// Relative ranges therefore "slide" (re-resolve to the current now on each
// fetch); absolute ranges are fixed. This mirrors Grafana's model and the
// downstream sicore dashboard.

export interface TimeRange {
  from: string
  to: string
}

export const QUICK_RANGES: Array<{ key: string; label: string; from: string }> = [
  { key: "30m", label: "Last 30 minutes", from: "now-30m" },
  { key: "1h", label: "Last 1 hour", from: "now-1h" },
  { key: "3h", label: "Last 3 hours", from: "now-3h" },
  { key: "6h", label: "Last 6 hours", from: "now-6h" },
  { key: "12h", label: "Last 12 hours", from: "now-12h" },
  { key: "24h", label: "Last 24 hours", from: "now-24h" },
  { key: "2d", label: "Last 2 days", from: "now-2d" },
  { key: "7d", label: "Last 7 days", from: "now-7d" },
  { key: "30d", label: "Last 30 days", from: "now-30d" },
  { key: "90d", label: "Last 90 days", from: "now-90d" },
]

export const DEFAULT_RANGE: TimeRange = { from: "now-7d", to: "now" }

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,       // minutes (Grafana 'm'); months are intentionally unsupported
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

const RELATIVE_RE = /^now-(\d+)([smhdw])$/

export function isRelativeExpr(v: string): boolean {
  const s = v.trim()
  return s === "now" || RELATIVE_RE.test(s)
}

/** Resolve one side of a range to absolute ms, or null if unparseable.
 *  Absolute strings are parsed in the browser's local timezone. */
function resolveExpr(v: string, now: number): number | null {
  const s = v.trim()
  if (s === "now") return now
  const m = RELATIVE_RE.exec(s)
  if (m) return now - Number(m[1]) * UNIT_MS[m[2]]
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/** Convert a TimeRange to absolute ms. Unparseable input falls back to a
 *  trailing 7d window rather than emitting NaN params; the picker independently
 *  gates Apply on isValidRange, and the backend 400s on a bad window. */
export function resolveRange(r: TimeRange): { fromMs: number; toMs: number } {
  const now = Date.now()
  const fromMs = resolveExpr(r.from, now)
  const toMs = resolveExpr(r.to, now)
  if (fromMs == null || toMs == null) return { fromMs: now - 7 * UNIT_MS.d, toMs: now }
  return { fromMs, toMs }
}

/** True when both sides parse and from < to. Gates the picker's Apply button. */
export function isValidRange(r: TimeRange): boolean {
  const now = Date.now()
  const fromMs = resolveExpr(r.from, now)
  const toMs = resolveExpr(r.to, now)
  return fromMs != null && toMs != null && fromMs < toMs
}

/** Human label for the trigger button: a quick range shows its canned label,
 *  an absolute range a compact "from → to". */
export function rangeLabel(r: TimeRange): string {
  if (r.to === "now") {
    const q = QUICK_RANGES.find((x) => x.from === r.from)
    if (q) return q.label
  }
  const fmt = (v: string): string => {
    if (isRelativeExpr(v)) return v
    const t = Date.parse(v)
    if (Number.isNaN(t)) return v
    const d = new Date(t)
    const p = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  return `${fmt(r.from)} → ${fmt(r.to)}`
}

// ── Hooks ────────────────────────────────────────────────

export function useSummary(range: TimeRange, userId: string | null, entry: EntryMode = "all"): { data: SummaryData | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<SummaryData | null>(null)
  const [loading, setLoading] = useState(true)
  const paramsRef = useRef({ range, userId, entry })
  paramsRef.current = { range, userId, entry }

  const fetchOnce = useCallback(() => {
    setLoading(true)
    const { range: r, userId: uid, entry: e } = paramsRef.current
    const { fromMs, toMs } = resolveRange(r)
    const q = new URLSearchParams({ from: String(fromMs), to: String(toMs), entry: e })
    if (uid) q.set("userId", uid)
    return api<SummaryData>(`/siclaw/metrics/summary?${q.toString()}`)
      .then((d) => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { fetchOnce() }, [range.from, range.to, userId, entry, fetchOnce])

  return { data, loading, refresh: fetchOnce }
}

// ── Timing hook ──────────────────────────────────────────

export function useTiming(range: TimeRange, userId: string | null, entry: EntryMode = "all"): { data: TimingStats | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<TimingStats | null>(null)
  const [loading, setLoading] = useState(true)
  const paramsRef = useRef({ range, userId, entry })
  paramsRef.current = { range, userId, entry }

  const fetchOnce = useCallback(() => {
    setLoading(true)
    const { range: r, userId: uid, entry: e } = paramsRef.current
    const { fromMs, toMs } = resolveRange(r)
    const q = new URLSearchParams({ from: String(fromMs), to: String(toMs), entry: e })
    if (uid) q.set("userId", uid)
    return api<TimingStats>(`/siclaw/metrics/timing?${q.toString()}`)
      .then((d) => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { fetchOnce() }, [range.from, range.to, userId, entry, fetchOnce])

  return { data, loading, refresh: fetchOnce }
}

interface AuditParams {
  userId?: string
  toolName?: string
  outcome?: string
  /** Entry-form axis (overview / web / api / a2a / channel / scheduled). */
  entry?: EntryMode
  /** Absolute window bounds (unix ms as strings), already resolved + frozen by
   *  the caller so pagination cursors don't drift on a sliding relative range. */
  from?: string
  to?: string
}

export function useAudit(params: AuditParams): {
  logs: AuditLog[]
  hasMore: boolean
  loading: boolean
  loadMore: () => void
  refresh: () => void
} {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const paramsRef = useRef(params)
  paramsRef.current = params

  const logsRef = useRef<AuditLog[]>([])
  logsRef.current = logs

  const doFetch = useCallback((append: boolean) => {
    setLoading(true)
    const q = new URLSearchParams()
    const p = paramsRef.current
    if (p.userId) q.set("userId", p.userId)
    if (p.toolName) q.set("toolName", p.toolName)
    if (p.outcome) q.set("outcome", p.outcome)
    if (p.entry) q.set("entry", p.entry)
    if (p.from) q.set("from", p.from)
    if (p.to) q.set("to", p.to)
    q.set("limit", "50")

    if (append && logsRef.current.length > 0) {
      const last = logsRef.current[logsRef.current.length - 1]
      // millisecond precision cursor — server expects ms timestamp
      const tsMs = new Date(last.timestamp).getTime()
      q.set("cursorTs", String(tsMs))
      q.set("cursorId", last.id)
    }

    api<AuditResponse>(`/siclaw/metrics/audit?${q.toString()}`)
      .then((r) => {
        if (append) setLogs((prev) => [...prev, ...r.logs])
        else setLogs(r.logs)
        setHasMore(r.hasMore)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  // Initial + reload on filter change
  useEffect(() => {
    setLogs([])
    doFetch(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.userId, params.toolName, params.outcome, params.entry, params.from, params.to])

  return { logs, hasMore, loading, loadMore: () => doFetch(true), refresh: () => doFetch(false) }
}

// ── Session audit hook (per-session counts, cursor-paginated) ──

export interface SessionParams {
  userId?: string
  agentId?: string
  entry?: EntryMode
  /** Resolved epoch-ms (as string), frozen by the caller for cursor pagination. */
  from?: string
  to?: string
}

export function useSessions(params: SessionParams): {
  sessions: SessionListItem[]
  hasMore: boolean
  loading: boolean
  loadMore: () => void
  refresh: () => void
} {
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const paramsRef = useRef(params)
  paramsRef.current = params
  const sessionsRef = useRef<SessionListItem[]>([])
  sessionsRef.current = sessions

  const doFetch = useCallback((append: boolean) => {
    setLoading(true)
    const q = new URLSearchParams()
    const p = paramsRef.current
    if (p.userId) q.set("userId", p.userId)
    if (p.agentId) q.set("agentId", p.agentId)
    if (p.entry) q.set("entry", p.entry)
    if (p.from) q.set("from", p.from)
    if (p.to) q.set("to", p.to)
    q.set("limit", "50")

    if (append && sessionsRef.current.length > 0) {
      const last = sessionsRef.current[sessionsRef.current.length - 1]
      const tsMs = new Date(last.activityAt).getTime()
      q.set("cursorTs", String(tsMs))
      q.set("cursorId", last.sessionId)
    }

    api<SessionListResponse>(`/siclaw/audit/sessions?${q.toString()}`)
      .then((r) => {
        if (append) setSessions((prev) => [...prev, ...r.sessions])
        else setSessions(r.sessions)
        setHasMore(r.hasMore)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    setSessions([])
    doFetch(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.userId, params.agentId, params.entry, params.from, params.to])

  return { sessions, hasMore, loading, loadMore: () => doFetch(true), refresh: () => doFetch(false) }
}

/** Read-only transcript of ANY session (admin audit). null id closes/clears. */
export function useSessionSnapshot(sessionId: string | null): { data: SessionSnapshot | null; loading: boolean; error: boolean } {
  const [data, setData] = useState<SessionSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!sessionId) { setData(null); setError(false); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setError(false)
    setData(null)
    api<SessionSnapshot>(`/siclaw/audit/sessions/${sessionId}/messages`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false) } })
    return () => { cancelled = true }
  }, [sessionId])

  return { data, loading, error }
}

export function useAuditDetail(id: string | null): { detail: AuditDetail | null; loading: boolean } {
  const [detail, setDetail] = useState<AuditDetail | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!id) { setDetail(null); return }
    let cancelled = false
    setLoading(true)
    api<AuditDetail>(`/siclaw/metrics/audit/${id}`)
      .then((d) => { if (!cancelled) { setDetail(d); setLoading(false) } })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  return { detail, loading }
}

export interface SystemConfig {
  config: Record<string, string>
}

export function useSystemConfig(): { config: Record<string, string>; loading: boolean; save: (key: string, value: string) => Promise<void>; reload: () => void } {
  const [config, setConfig] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    setLoading(true)
    api<SystemConfig>("/siclaw/system/config")
      .then((r) => { setConfig(r.config); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { reload() }, [reload])

  const save = useCallback(async (key: string, value: string) => {
    await api("/siclaw/system/config", { method: "PUT", body: { values: { [key]: value } } })
    setConfig((c) => ({ ...c, [key]: value }))
  }, [])

  return { config, loading, save, reload }
}

// ── Users list (fetched via existing portal user list endpoint) ──

export interface UserListEntry { id: string; username: string; role?: string }

export function useUsers(): { users: UserListEntry[]; loading: boolean } {
  const [users, setUsers] = useState<UserListEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    api<{ data: UserListEntry[] }>("/users")
      .then((r) => {
        if (cancelled) return
        setUsers(Array.isArray(r.data) ? r.data : [])
        setLoading(false)
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return { users, loading }
}
