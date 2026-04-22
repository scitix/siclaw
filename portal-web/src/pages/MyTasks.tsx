import { useEffect, useMemo, useState } from "react"
import { useNavigate, Link } from "react-router-dom"
import { Clock, ClipboardList, Loader2, ChevronRight, Bot, Play, Pause, ArrowRight } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { nextFireHint } from "../lib/taskSchedule"

interface MyTask {
  id: string
  agent_id: string
  agent_name: string | null
  name: string
  description?: string | null
  schedule: string
  prompt: string
  status: "active" | "paused"
  last_run_at: string | null
  last_result: string | null
  created_at: string
}

interface AgentGroup {
  agentId: string
  agentName: string
  tasks: MyTask[]
  latestActivityMs: number
}

function formatRelative(iso: string | null): string {
  if (!iso) return "\u2014"
  const now = Date.now()
  const t = new Date(iso).getTime()
  const diff = now - t
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(iso).toLocaleString()
}

function groupByAgent(tasks: MyTask[]): AgentGroup[] {
  const map = new Map<string, AgentGroup>()
  for (const t of tasks) {
    const key = t.agent_id
    const name = t.agent_name ?? t.agent_id.slice(0, 8)
    const activity = Math.max(
      t.last_run_at ? new Date(t.last_run_at).getTime() : 0,
      t.created_at ? new Date(t.created_at).getTime() : 0,
    )
    const group = map.get(key)
    if (group) {
      group.tasks.push(t)
      group.latestActivityMs = Math.max(group.latestActivityMs, activity)
    } else {
      map.set(key, { agentId: key, agentName: name, tasks: [t], latestActivityMs: activity })
    }
  }
  const groups = [...map.values()]
  groups.sort((a, b) => b.latestActivityMs - a.latestActivityMs)
  for (const g of groups) {
    g.tasks.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }
  return groups
}

/**
 * Cross-agent overview. Tasks are grouped by owning agent to reinforce the
 * "agent = unit of execution" mental model — each group's header is a
 * shortcut to that agent's management surface (L1). Row click still drills
 * into the task's read-only run history (L2). Inline pause/resume is the one
 * mutation kept at this level (common ops reflex); edit/delete live on L1
 * where the full task context is present.
 */
export function MyTasks() {
  const [tasks, setTasks] = useState<MyTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toggling, setToggling] = useState<Set<string>>(new Set())
  const navigate = useNavigate()
  const toast = useToast()

  useEffect(() => {
    let cancelled = false
    api<{ data: MyTask[] }>("/siclaw/my-tasks")
      .then((res) => {
        if (cancelled) return
        setTasks(Array.isArray(res.data) ? res.data : [])
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || "Failed to load")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const groups = useMemo(() => groupByAgent(tasks), [tasks])

  const openDetail = (t: MyTask) => {
    navigate(`/agents/${t.agent_id}/tasks/${t.id}`)
  }

  const handleToggleStatus = async (e: React.MouseEvent, t: MyTask) => {
    e.stopPropagation()
    if (toggling.has(t.id)) return
    const newStatus: "active" | "paused" = t.status === "active" ? "paused" : "active"
    setToggling((prev) => new Set(prev).add(t.id))
    setTasks((prev) => prev.map((x) => x.id === t.id ? { ...x, status: newStatus } : x))
    try {
      await api(`/siclaw/agents/${t.agent_id}/tasks/${t.id}`, {
        method: "PUT",
        body: { status: newStatus },
      })
      toast.success(`Task ${newStatus === "active" ? "activated" : "paused"}`)
    } catch (err: any) {
      setTasks((prev) => prev.map((x) => x.id === t.id ? { ...x, status: t.status } : x))
      toast.error(err?.message || "Failed to update task")
    } finally {
      setToggling((prev) => {
        const next = new Set(prev)
        next.delete(t.id)
        return next
      })
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-[15px] font-semibold">My Schedules</h1>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Tasks grouped by their owning agent. Pause/resume inline; click a row for run history; use <span className="font-medium text-foreground/80">Manage</span> to create / edit / delete.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="py-16 text-center text-[13px] text-red-400">{error}</div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <ClipboardList className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-[13px] font-medium">No scheduled tasks yet</p>
            <p className="text-[12px] text-muted-foreground/70 mt-1">
              Open an agent's Tasks tab to create one.
            </p>
          </div>
        ) : (
          <div className="px-6 py-5 space-y-4">
            {groups.map((group) => (
              <div
                key={group.agentId}
                className="rounded-lg border border-border bg-card overflow-hidden"
              >
                <div className="flex items-center justify-between px-5 py-3 border-b border-border/60 bg-muted/20">
                  <div className="flex items-center gap-2 min-w-0">
                    <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-[13px] font-medium text-foreground truncate">
                      {group.agentName}
                    </span>
                    <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                      · {group.tasks.length} {group.tasks.length === 1 ? "task" : "tasks"}
                    </span>
                  </div>
                  <Link
                    to={`/agents/${group.agentId}?tab=tasks`}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  >
                    Manage
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>

                <div className="divide-y divide-border/30">
                  {group.tasks.map((t) => {
                    const isToggling = toggling.has(t.id)
                    return (
                      <div
                        key={t.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => openDetail(t)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(t) } }}
                        className="flex items-center px-5 py-3 hover:bg-muted/30 transition-colors text-left cursor-pointer"
                      >
                        <div className="w-[36%] px-2 min-w-0">
                          <div className="text-[13px] font-medium text-foreground truncate">{t.name}</div>
                          {t.description && (
                            <div className="text-[11px] text-muted-foreground truncate mt-0.5">{t.description}</div>
                          )}
                        </div>
                        <div className="w-[22%] px-2">
                          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground font-mono">
                            <Clock className="h-3.5 w-3.5 shrink-0" />
                            {t.schedule}
                          </div>
                          {t.status === "active" && (() => {
                            const hint = nextFireHint(t.schedule)
                            return hint ? (
                              <div className="text-[10px] text-muted-foreground/60 mt-0.5 pl-[22px] tabular-nums">
                                next {hint}
                              </div>
                            ) : null
                          })()}
                        </div>
                        <div className="w-[18%] px-2">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                t.status === "active"
                                  ? "bg-green-500/20 text-green-400"
                                  : "bg-gray-500/20 text-gray-400"
                              }`}
                            >
                              {t.status}
                            </span>
                            <button
                              onClick={(e) => handleToggleStatus(e, t)}
                              disabled={isToggling}
                              className="p-1 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed"
                              title={t.status === "active" ? "Pause" : "Activate"}
                            >
                              {isToggling ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : t.status === "active" ? (
                                <Pause className="h-3 w-3" />
                              ) : (
                                <Play className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                        </div>
                        <div className="w-[18%] px-2">
                          {t.last_run_at ? (
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                                  t.last_result === "success" ? "bg-green-500" : "bg-red-500"
                                }`}
                              />
                              <span className="text-[12px] text-muted-foreground tabular-nums">
                                {formatRelative(t.last_run_at)}
                              </span>
                            </div>
                          ) : (
                            <span className="text-[12px] text-muted-foreground">{"\u2014"}</span>
                          )}
                        </div>
                        <div className="flex-1 px-2 flex items-center justify-end">
                          <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
