import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight, CheckCircle, XCircle, Ban, Loader2 } from "lucide-react"
import { useAudit, useUsers, type AuditLog } from "../../hooks/useMetrics"
import { AuditDetailPanel } from "./AuditDetailPanel"

const TOOL_OPTIONS = ["All", "restricted_bash", "local_script", "pod_exec", "kubectl", "cluster_probe", "cluster_list"]
const STATUS_OPTIONS = ["All", "success", "error", "blocked"]
const RANGE_OPTIONS = [
  { label: "Last 1h", value: 3_600_000 },
  { label: "Last 6h", value: 21_600_000 },
  { label: "Last 24h", value: 86_400_000 },
  { label: "Last 7d", value: 7 * 86_400_000 },
  { label: "Last 30d", value: 30 * 86_400_000 },
]

function formatDuration(ms: number | null): string {
  if (ms == null) return "—"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTime(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function formatDate(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function parseCommand(toolName: string | null, toolInput: string | null): string {
  if (!toolInput) return "—"
  try {
    const p = JSON.parse(toolInput) as Record<string, unknown>
    if (toolName === "restricted_bash" || toolName === "bash" || toolName === "pod_exec") {
      return String(p.command ?? toolInput)
    }
    if (toolName === "local_script") {
      return `${p.skill ?? ""}/${p.script ?? ""}`
    }
    return toolInput.length > 100 ? toolInput.slice(0, 100) + "…" : toolInput
  } catch {
    return toolInput.length > 100 ? toolInput.slice(0, 100) + "…" : toolInput
  }
}

function OutcomeIcon({ outcome }: { outcome: string | null }) {
  switch (outcome) {
    case "success": return <CheckCircle className="w-4 h-4 text-green-400" />
    case "error":   return <XCircle className="w-4 h-4 text-red-400" />
    case "blocked": return <Ban className="w-4 h-4 text-amber-400" />
    default:        return <span className="text-muted-foreground text-[11px]">—</span>
  }
}

export function AuditTable({ userFilterId, usernameHint }: { userFilterId: string | null; usernameHint: string | null }) {
  const [tool, setTool] = useState("All")
  const [status, setStatus] = useState("All")
  const [rangeMs, setRangeMs] = useState(86_400_000)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const { users } = useUsers()
  const userMap = useMemo(() => {
    const m = new Map<string, string>()
    users.forEach((u) => m.set(u.id, u.username))
    return m
  }, [users])

  const params = useMemo(() => {
    const now = Date.now()
    return {
      userId: userFilterId ?? undefined,
      toolName: tool === "All" ? undefined : tool,
      outcome: status === "All" ? undefined : status,
      startDate: new Date(now - rangeMs).toISOString(),
      endDate: new Date(now).toISOString(),
    }
  }, [tool, status, rangeMs, userFilterId])

  const { logs, hasMore, loading, loadMore } = useAudit(params)

  const toggleExpand = (id: string) => setExpandedId(expandedId === id ? null : id)

  return (
    <section className="px-6 py-6 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {usernameHint && (
          <span className="text-[11px] px-2 py-1 rounded bg-secondary border border-border text-muted-foreground">
            user: <span className="text-foreground font-mono">{usernameHint}</span>
          </span>
        )}
        <select
          value={tool}
          onChange={(e) => setTool(e.target.value)}
          className="h-8 px-2 pr-6 text-[12px] rounded-md bg-secondary border border-border text-foreground focus:outline-none focus:border-blue-500"
        >
          {TOOL_OPTIONS.map((t) => <option key={t} value={t}>{t === "All" ? "All Tools" : t}</option>)}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-8 px-2 pr-6 text-[12px] rounded-md bg-secondary border border-border text-foreground focus:outline-none focus:border-blue-500"
        >
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s === "All" ? "All Status" : s}</option>)}
        </select>
        <select
          value={rangeMs}
          onChange={(e) => setRangeMs(parseInt(e.target.value, 10))}
          className="h-8 px-2 pr-6 text-[12px] rounded-md bg-secondary border border-border text-foreground focus:outline-none focus:border-blue-500"
        >
          {RANGE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        <div className="flex-1"></div>
        <div className="text-[11px] text-muted-foreground font-mono">{logs.length} entries{hasMore ? "+" : ""}</div>
      </div>

      <div className="border border-border rounded-lg bg-card overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-secondary/40">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="w-8"></th>
              <th className="text-left px-3 py-2.5 font-medium">Time</th>
              <th className="text-left px-3 py-2.5 font-medium">User</th>
              <th className="text-left px-3 py-2.5 font-medium">Agent</th>
              <th className="text-left px-3 py-2.5 font-medium">Tool</th>
              <th className="text-left px-3 py-2.5 font-medium">Command</th>
              <th className="text-center px-3 py-2.5 font-medium w-16">Status</th>
              <th className="text-right px-4 py-2.5 font-medium w-20">Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {logs.length === 0 && !loading ? (
              <tr><td colSpan={8} className="text-center py-12 text-muted-foreground text-[12px]">No entries found</td></tr>
            ) : logs.map((log: AuditLog) => (
              <AuditRow
                key={log.id}
                log={log}
                username={log.userId ? (userMap.get(log.userId) ?? log.userId) : "—"}
                expanded={expandedId === log.id}
                onToggle={() => toggleExpand(log.id)}
              />
            ))}
          </tbody>
        </table>
        <div className="flex items-center justify-between px-4 py-3 border-t border-border text-[11px] text-muted-foreground">
          <span>{loading ? "Loading…" : `Showing ${logs.length}`}</span>
          {hasMore && (
            <button
              onClick={loadMore}
              disabled={loading}
              className="px-3 py-1 rounded border border-border hover:bg-secondary text-foreground disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Load More ↓"}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

function AuditRow({ log, username, expanded, onToggle }: { log: AuditLog; username: string; expanded: boolean; onToggle: () => void }) {
  const cmd = parseCommand(log.toolName, log.toolInput)
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer hover:bg-secondary/30 ${expanded ? "bg-secondary/20" : ""}`}
      >
        <td className="pl-3 text-muted-foreground">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </td>
        <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
          <span className="mr-1">{formatDate(log.timestamp)}</span>{formatTime(log.timestamp)}
        </td>
        <td className="px-3 py-2.5">{username}</td>
        <td className="px-3 py-2.5 text-muted-foreground">{log.agentId ?? "—"}</td>
        <td className="px-3 py-2.5">
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-secondary text-muted-foreground">{log.toolName ?? "—"}</span>
        </td>
        <td className="px-3 py-2.5 text-muted-foreground max-w-xs truncate font-mono text-[11px]" title={cmd}>{cmd}</td>
        <td className="px-3 text-center"><OutcomeIcon outcome={log.outcome} /></td>
        <td className="px-4 text-right font-mono text-muted-foreground">{formatDuration(log.durationMs)}</td>
      </tr>
      {expanded && (
        <tr className="bg-secondary/20">
          <td colSpan={8} className="px-6 py-4"><AuditDetailPanel log={log} /></td>
        </tr>
      )}
    </>
  )
}
