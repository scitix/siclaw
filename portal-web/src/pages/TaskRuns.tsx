import { useEffect, useState } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import { ArrowLeft, Clock, Loader2, AlertCircle, CheckCircle2, ChevronRight, ClipboardList, Play } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { nextFireFull } from "../lib/taskSchedule"

interface AgentTask {
  id: string
  agent_id: string
  name: string
  description: string | null
  schedule: string
  prompt: string
  status: "active" | "paused"
  last_run_at: string | null
  last_result: string | null
  created_at: string
}

interface TaskRun {
  id: string
  task_id: string
  status: string
  result_text: string | null
  error: string | null
  duration_ms: number | null
  session_id: string | null
  created_at: string
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m ${secs}s`
}

function formatRelative(dateStr: string): string {
  const now = Date.now()
  const date = new Date(dateStr).getTime()
  const diff = now - date
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(dateStr).toLocaleString()
}

function RunStatusBadge({ status }: { status: string }) {
  const styles =
    status === "success"
      ? "bg-green-500/15 text-green-400 border-green-500/20"
      : status === "running"
        ? "bg-blue-500/15 text-blue-400 border-blue-500/20"
        : status === "error" || status === "failed"
          ? "bg-red-500/15 text-red-400 border-red-500/20"
          : "bg-muted text-muted-foreground border-border"
  const icon =
    status === "success" ? <CheckCircle2 className="h-3 w-3" />
    : status === "running" ? <Loader2 className="h-3 w-3 animate-spin" />
    : status === "error" || status === "failed" ? <AlertCircle className="h-3 w-3" />
    : null
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${styles}`}>
      {icon}
      {status}
    </span>
  )
}

/**
 * L2: show every run of a single scheduled task. Read-only history view —
 * editing / deleting / pausing all live on L1 (the agent's Tasks tab) where
 * task management belongs. Row click navigates to L3 for the per-run report.
 *
 * URL: /agents/:agentId/tasks/:taskId
 */
export function TaskRuns() {
  const { agentId, taskId } = useParams<{ agentId: string; taskId: string }>()
  const navigate = useNavigate()
  const toast = useToast()

  const [task, setTask] = useState<AgentTask | null>(null)
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [triggering, setTriggering] = useState(false)
  const [cooldownUntil, setCooldownUntil] = useState<number>(0)
  const [cooldownSec, setCooldownSec] = useState<number>(0)

  const PAGE_SIZE = 30
  const hasRunningRun = runs.some((r) => r.status === "running")

  useEffect(() => {
    if (!agentId || !taskId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      api<AgentTask>(`/siclaw/agents/${agentId}/tasks/${taskId}`),
      api<{ data: TaskRun[]; hasMore: boolean }>(
        `/siclaw/agents/${agentId}/tasks/${taskId}/runs?limit=${PAGE_SIZE}`,
      ),
    ])
      .then(([t, r]) => {
        if (cancelled) return
        setTask(t)
        setRuns(Array.isArray(r.data) ? r.data : [])
        setHasMore(Boolean(r.hasMore))
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || "Failed to load")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [agentId, taskId])

  const loadMore = async () => {
    if (!agentId || !taskId) return
    if (loadingMore || !hasMore) return
    const oldest = runs[runs.length - 1]
    if (!oldest) return
    setLoadingMore(true)
    try {
      const res = await api<{ data: TaskRun[]; hasMore: boolean }>(
        `/siclaw/agents/${agentId}/tasks/${taskId}/runs?limit=${PAGE_SIZE}&before=${encodeURIComponent(oldest.created_at)}`,
      )
      setRuns((prev) => [...prev, ...(res.data ?? [])])
      setHasMore(Boolean(res.hasMore))
    } catch (err: any) {
      setError(err?.message || "Failed to load more")
    } finally {
      setLoadingMore(false)
    }
  }

  // While any run is 'running', poll the first page every 5s so the user
  // sees the status transition + final result without a manual refresh.
  useEffect(() => {
    if (!hasRunningRun || !agentId || !taskId) return
    const tick = setInterval(async () => {
      try {
        const res = await api<{ data: TaskRun[]; hasMore: boolean }>(
          `/siclaw/agents/${agentId}/tasks/${taskId}/runs?limit=${PAGE_SIZE}`,
        )
        setRuns((prev) => {
          // Merge: keep any rows older than the newest page's oldest row to
          // preserve user's loaded-more history; replace the rest.
          const fresh = Array.isArray(res.data) ? res.data : []
          if (fresh.length === 0) return prev
          const cutoff = new Date(fresh[fresh.length - 1].created_at).getTime()
          const older = prev.filter((r) => new Date(r.created_at).getTime() < cutoff)
          return [...fresh, ...older]
        })
      } catch {
        // Transient error — keep polling; the next tick will retry.
      }
    }, 5_000)
    return () => clearInterval(tick)
  }, [hasRunningRun, agentId, taskId])

  // Cooldown countdown (1s tick, refreshes the button label).
  useEffect(() => {
    if (cooldownUntil <= Date.now()) {
      if (cooldownSec !== 0) setCooldownSec(0)
      return
    }
    const tick = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000))
      setCooldownSec(remaining)
      if (remaining === 0) clearInterval(tick)
    }, 500)
    setCooldownSec(Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)))
    return () => clearInterval(tick)
  }, [cooldownUntil, cooldownSec])

  const handleRunNow = async () => {
    if (!agentId || !taskId) return
    if (triggering || hasRunningRun || cooldownSec > 0) return
    setTriggering(true)
    try {
      await api<{ ok: true }>(`/siclaw/agents/${agentId}/tasks/${taskId}/runs`, {
        method: "POST",
      })
      // Optimistic: refetch the first page so the new running row appears
      // immediately. Polling kicks in from hasRunningRun.
      const res = await api<{ data: TaskRun[]; hasMore: boolean }>(
        `/siclaw/agents/${agentId}/tasks/${taskId}/runs?limit=${PAGE_SIZE}`,
      )
      setRuns(Array.isArray(res.data) ? res.data : [])
      setHasMore(Boolean(res.hasMore))
      toast.success("Run triggered")
    } catch (err: any) {
      const msg: string = err?.message || "Failed to trigger run"
      // Server sends retry_after_sec on 429 (cooldown). Attach it to the
      // local countdown so the button shows "Wait Ns" until the window
      // expires, without a second network round-trip.
      const retry = err?.body?.retry_after_sec
      if (typeof retry === "number" && retry > 0) {
        setCooldownUntil(Date.now() + retry * 1000)
      }
      toast.error(msg)
    } finally {
      setTriggering(false)
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border shrink-0">
        <button
          onClick={() => navigate(-1)}
          className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"
          title="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Link
              to={`/agents/${agentId}?tab=tasks`}
              className="hover:text-foreground transition-colors"
            >
              Tasks
            </Link>
            <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
            <span className="text-muted-foreground/70">Run history</span>
          </div>
          <div className="text-[15px] font-semibold mt-0.5 truncate">
            {task?.name ?? "Task runs"}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="px-6 py-6 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="rounded-md border border-red-500/20 bg-red-500/5 p-4 text-[13px] text-red-400">
              {error}
            </div>
          ) : task ? (
            <>
              {/* Task summary — read-only; edit on L1 */}
              <div className="rounded-lg border border-border bg-card p-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 flex-wrap min-w-0">
                    <span
                      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        task.status === "active"
                          ? "bg-green-500/20 text-green-400"
                          : "bg-gray-500/20 text-gray-400"
                      }`}
                    >
                      {task.status}
                    </span>
                    <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground font-mono">
                      <Clock className="h-3.5 w-3.5 shrink-0" />
                      {task.schedule}
                      <span className="px-1 py-[1px] rounded text-[9px] font-medium bg-muted text-muted-foreground/70 uppercase tracking-wider leading-none">
                        UTC
                      </span>
                    </div>
                    {task.status === "active" && (() => {
                      const hint = nextFireFull(task.schedule)
                      return hint ? (
                        <div className="text-[11px] text-muted-foreground/70 tabular-nums">
                          Next fire: {hint}
                        </div>
                      ) : null
                    })()}
                  </div>
                  <button
                    onClick={handleRunNow}
                    disabled={triggering || hasRunningRun || cooldownSec > 0}
                    className="flex items-center gap-1.5 h-8 px-3 text-[12px] rounded-md bg-primary text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 shrink-0"
                    title={
                      hasRunningRun
                        ? "A run is already in progress"
                        : cooldownSec > 0
                          ? `Cooldown: wait ${cooldownSec}s`
                          : "Fire this task now, outside the cron schedule"
                    }
                  >
                    {triggering || hasRunningRun ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    {triggering
                      ? "Triggering…"
                      : hasRunningRun
                        ? "Running…"
                        : cooldownSec > 0
                          ? `Wait ${cooldownSec}s`
                          : "Run now"}
                  </button>
                </div>
                {task.description && (
                  <p className="text-[12px] text-muted-foreground/80 pt-1 border-t border-border/40">
                    {task.description}
                  </p>
                )}
                <div className="pt-1 border-t border-border/40">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                    Prompt
                  </div>
                  <pre className="text-[11px] text-foreground/80 font-mono whitespace-pre-wrap break-words leading-relaxed">
                    {task.prompt}
                  </pre>
                </div>
              </div>

              {/* Runs list */}
              <div className="rounded-lg border border-border bg-card overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-border/60">
                  <span className="text-[12px] font-medium text-foreground/90">
                    Runs
                  </span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {runs.length}{hasMore ? "+" : ""} shown
                  </span>
                </div>
                {runs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <ClipboardList className="h-10 w-10 text-muted-foreground/30 mb-2" />
                    <p className="text-[12px]">No runs yet</p>
                    <p className="text-[11px] text-muted-foreground/70 mt-1">
                      Runs will appear here after the task executes
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-border/30">
                    {runs.map((run) => (
                      <button
                        key={run.id}
                        onClick={() => navigate(`/agents/${agentId}/tasks/${taskId}/runs/${run.id}`)}
                        className="w-full flex items-center gap-3 px-5 py-3 hover:bg-muted/30 transition-colors text-left"
                      >
                        <div className="shrink-0">
                          <RunStatusBadge status={run.status} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] text-foreground/90 tabular-nums">
                            {formatRelative(run.created_at)}
                          </div>
                          <div className="text-[11px] text-muted-foreground/70 mt-0.5 tabular-nums">
                            {new Date(run.created_at).toLocaleString()}
                          </div>
                        </div>
                        {run.duration_ms != null && (
                          <span className="text-[11px] text-muted-foreground/70 tabular-nums shrink-0">
                            {formatDuration(run.duration_ms)}
                          </span>
                        )}
                        <ChevronRight className="h-4 w-4 text-muted-foreground/50 shrink-0" />
                      </button>
                    ))}
                    {hasMore && (
                      <button
                        onClick={loadMore}
                        disabled={loadingMore}
                        className="w-full flex items-center justify-center gap-2 px-5 py-3 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors disabled:opacity-50"
                      >
                        {loadingMore ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading...
                          </>
                        ) : (
                          <>Load older runs</>
                        )}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
