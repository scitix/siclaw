import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api"

// ── Types ────────────────────────────────────────────────

export interface ToolStats {
  toolName: string
  userId: string
  agentId: string | null
  success: number
  error: number
  total: number
}

export interface SkillStats {
  skillName: string
  scope: "builtin" | "global"
  userId: string
  agentId: string | null
  success: number
  error: number
  total: number
  avgDurationMs: number
}

export interface LiveData {
  snapshot: { activeSessions: number; wsConnections: number }
  topTools: ToolStats[]
  topSkills: SkillStats[]
}

export interface SummaryData {
  totalSessions: number
  totalPrompts: number
  byUser: Array<{ userId: string; sessions: number; messages: number }>
}

export interface AuditLog {
  id: string
  sessionId: string
  userId: string | null
  agentId: string | null
  toolName: string | null
  toolInput: string | null
  outcome: string | null
  durationMs: number | null
  timestamp: string
}

export interface AuditDetail extends AuditLog {
  content: string | null
}

export interface AuditResponse {
  logs: AuditLog[]
  hasMore: boolean
}

// ── Hooks ────────────────────────────────────────────────

export function useLive(userId: string | null): { data: LiveData | null; loading: boolean; error: Error | null; refresh: () => void } {
  const [data, setData] = useState<LiveData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const userIdRef = useRef(userId)
  userIdRef.current = userId

  const fetchOnce = useCallback(() => {
    const uid = userIdRef.current
    const q = uid ? `?userId=${encodeURIComponent(uid)}` : ""
    return api<LiveData>(`/metrics/live${q}`)
      .then((d) => { setData(d); setError(null); setLoading(false) })
      .catch((e: Error) => { setError(e); setLoading(false) })
  }, [])

  useEffect(() => {
    fetchOnce()
    const interval = setInterval(fetchOnce, 30_000)
    return () => { clearInterval(interval) }
  }, [userId, fetchOnce])

  return { data, loading, error, refresh: fetchOnce }
}

export function useSummary(period: string, userId: string | null): { data: SummaryData | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<SummaryData | null>(null)
  const [loading, setLoading] = useState(true)
  const paramsRef = useRef({ period, userId })
  paramsRef.current = { period, userId }

  const fetchOnce = useCallback(() => {
    setLoading(true)
    const { period: p, userId: uid } = paramsRef.current
    const q = new URLSearchParams({ period: p })
    if (uid) q.set("userId", uid)
    return api<SummaryData>(`/metrics/summary?${q.toString()}`)
      .then((d) => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { fetchOnce() }, [period, userId, fetchOnce])

  return { data, loading, refresh: fetchOnce }
}

interface AuditParams {
  userId?: string
  toolName?: string
  outcome?: string
  startDate?: string
  endDate?: string
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
    if (p.startDate) q.set("startDate", p.startDate)
    if (p.endDate) q.set("endDate", p.endDate)
    q.set("limit", "50")

    if (append && logsRef.current.length > 0) {
      const last = logsRef.current[logsRef.current.length - 1]
      // millisecond precision cursor — server expects ms timestamp
      const tsMs = new Date(last.timestamp).getTime()
      q.set("cursorTs", String(tsMs))
      q.set("cursorId", last.id)
    }

    api<AuditResponse>(`/metrics/audit?${q.toString()}`)
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
  }, [params.userId, params.toolName, params.outcome, params.startDate, params.endDate])

  return { logs, hasMore, loading, loadMore: () => doFetch(true), refresh: () => doFetch(false) }
}

export function useAuditDetail(id: string | null): { detail: AuditDetail | null; loading: boolean } {
  const [detail, setDetail] = useState<AuditDetail | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!id) { setDetail(null); return }
    let cancelled = false
    setLoading(true)
    api<AuditDetail>(`/metrics/audit/${id}`)
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
    api<SystemConfig>("/system/config")
      .then((r) => { setConfig(r.config); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { reload() }, [reload])

  const save = useCallback(async (key: string, value: string) => {
    await api("/system/config", { method: "PUT", body: { values: { [key]: value } } })
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
