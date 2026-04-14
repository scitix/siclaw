import { useEffect, useState } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import { ArrowLeft, Clock, Loader2, AlertCircle, CheckCircle2, Activity, ChevronDown, ChevronRight, ChevronLeft } from "lucide-react"
import { api } from "../api"
import { Markdown } from "../components/chat/Markdown"
import { TraceView, type TraceMessage } from "../components/TraceView"

interface RunDetail {
  id: string
  task_id: string
  status: string
  result_text: string | null
  error: string | null
  duration_ms: number | null
  session_id: string | null
  created_at: string
}

interface TaskSummary {
  id: string
  agent_id: string
  name: string
  description: string | null
  schedule: string
  prompt: string
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m ${secs}s`
}

function StatusPill({ status }: { status: string }) {
  const base = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium"
  if (status === "success")
    return <span className={`${base} bg-green-500/15 text-green-400 border border-green-500/20`}><CheckCircle2 className="h-3 w-3" />Success</span>
  if (status === "error" || status === "failed")
    return <span className={`${base} bg-red-500/15 text-red-400 border border-red-500/20`}><AlertCircle className="h-3 w-3" />{status}</span>
  if (status === "running")
    return <span className={`${base} bg-blue-500/15 text-blue-400 border border-blue-500/20`}><Loader2 className="h-3 w-3 animate-spin" />Running</span>
  return <span className={`${base} bg-muted text-muted-foreground border border-border`}>{status}</span>
}

/**
 * Dedicated report page for a single cron-task run.
 *
 * Default view is a clean report (status + timing + final result). The full
 * message trace is loaded lazily only when the user expands "View trace" —
 * keeps the initial render fast and the report uncluttered.
 *
 * URL shape: /agents/:agentId/tasks/:taskId/runs/:runId
 * This is the target of notification deep-links and of row clicks from the
 * AgentTasks / My Schedules lists.
 */
export function TaskRunDetail() {
  const { agentId, taskId, runId } = useParams<{ agentId: string; taskId: string; runId: string }>()
  const navigate = useNavigate()

  const [run, setRun] = useState<RunDetail | null>(null)
  const [task, setTask] = useState<TaskSummary | null>(null)
  const [neighbors, setNeighbors] = useState<{ older_run_id: string | null; newer_run_id: string | null }>({
    older_run_id: null,
    newer_run_id: null,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [traceOpen, setTraceOpen] = useState(false)
  const [traceLoaded, setTraceLoaded] = useState(false)
  const [traceLoading, setTraceLoading] = useState(false)
  const [traceError, setTraceError] = useState<string | null>(null)
  const [traceMessages, setTraceMessages] = useState<TraceMessage[]>([])
  const [traceTruncated, setTraceTruncated] = useState(false)

  useEffect(() => {
    if (!agentId || !taskId || !runId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    // Also reset trace state so a prev/next navigation on the same mount
    // doesn't carry over the previous run's messages.
    setTraceOpen(false)
    setTraceLoaded(false)
    setTraceMessages([])
    setTraceTruncated(false)
    setTraceError(null)
    api<{
      run: RunDetail
      task: TaskSummary
      neighbors?: { older_run_id: string | null; newer_run_id: string | null }
    }>(
      `/siclaw/agents/${agentId}/tasks/${taskId}/runs/${runId}`,
    )
      .then((res) => {
        if (cancelled) return
        setRun(res.run)
        setTask(res.task)
        setNeighbors(res.neighbors ?? { older_run_id: null, newer_run_id: null })
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || "Failed to load run")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [agentId, taskId, runId])

  const handleToggleTrace = async () => {
    const next = !traceOpen
    setTraceOpen(next)
    if (next && !traceLoaded && run?.session_id) {
      setTraceLoading(true)
      setTraceError(null)
      try {
        const res = await api<{ messages: TraceMessage[]; truncated?: boolean }>(
          `/siclaw/agents/${agentId}/tasks/${taskId}/runs/${runId}/messages`,
        )
        setTraceMessages(res.messages ?? [])
        setTraceTruncated(Boolean(res.truncated))
        setTraceLoaded(true)
      } catch (err: any) {
        setTraceError(err?.message || "Failed to load trace")
      } finally {
        setTraceLoading(false)
      }
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
            {task && (
              <Link
                to={`/agents/${task.agent_id}/tasks/${task.id}`}
                className="hover:text-foreground transition-colors"
              >
                {task.name}
              </Link>
            )}
            <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
            <span className="text-muted-foreground/70">Run</span>
          </div>
          <div className="text-[15px] font-semibold mt-0.5 truncate">
            {task?.name ?? "Run detail"}
          </div>
        </div>
        {/* Prev/next across the task's runs. "Older" = earlier fire,
            "Newer" = later fire. Disabled at the edges. */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() =>
              neighbors.older_run_id &&
              navigate(`/agents/${agentId}/tasks/${taskId}/runs/${neighbors.older_run_id}`)
            }
            disabled={!neighbors.older_run_id}
            className="flex items-center gap-1 h-7 px-2.5 text-[11px] rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/50 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Older run"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Older
          </button>
          <button
            onClick={() =>
              neighbors.newer_run_id &&
              navigate(`/agents/${agentId}/tasks/${taskId}/runs/${neighbors.newer_run_id}`)
            }
            disabled={!neighbors.newer_run_id}
            className="flex items-center gap-1 h-7 px-2.5 text-[11px] rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/50 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Newer run"
          >
            Newer
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="rounded-md border border-red-500/20 bg-red-500/5 p-4 text-[13px] text-red-400">
              {error}
            </div>
          ) : run && task ? (
            <>
              {/* Summary card */}
              <div className="rounded-lg border border-border bg-card p-5 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <StatusPill status={run.status} />
                      {run.duration_ms != null && (
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {formatDuration(run.duration_ms)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                      <Clock className="h-3.5 w-3.5 shrink-0" />
                      <span className="tabular-nums">
                        {new Date(run.created_at).toLocaleString()}
                      </span>
                      <span className="text-muted-foreground/60">·</span>
                      <span className="font-mono text-muted-foreground/80">{task.schedule}</span>
                    </div>
                  </div>
                </div>
                {task.description && (
                  <p className="text-[12px] text-muted-foreground/80 pt-1 border-t border-border/40">
                    {task.description}
                  </p>
                )}
              </div>

              {/* Report */}
              {run.error ? (
                <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
                  <div className="flex items-center gap-1.5 mb-2">
                    <AlertCircle className="h-3.5 w-3.5 text-red-400" />
                    <span className="text-[11px] font-medium text-red-400 uppercase tracking-wider">
                      Error
                    </span>
                  </div>
                  <pre className="text-[12px] text-red-300/90 whitespace-pre-wrap break-words font-mono leading-relaxed">
                    {run.error}
                  </pre>
                </div>
              ) : run.result_text ? (
                <div className="rounded-lg border border-border bg-card p-5">
                  <div className="flex items-center gap-1.5 mb-3">
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
                    <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Report
                    </span>
                  </div>
                  <div className="prose prose-invert prose-sm max-w-none">
                    <Markdown>{run.result_text}</Markdown>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-border bg-card p-5 text-[12px] text-muted-foreground/70 italic">
                  No report recorded for this run.
                </div>
              )}

              {/* Trace (collapsible, lazy-loaded) */}
              {run.session_id && (
                <div className="rounded-lg border border-border bg-card">
                  <button
                    onClick={handleToggleTrace}
                    className="w-full flex items-center gap-2 px-5 py-3 text-left hover:bg-muted/30 transition-colors"
                  >
                    {traceOpen
                      ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                    <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-[12px] font-medium text-foreground/90">
                      View trace
                    </span>
                    <span className="text-[11px] text-muted-foreground/60 ml-1">
                      — full message timeline
                    </span>
                  </button>
                  {traceOpen && (
                    <div className="px-5 pb-4 pt-1">
                      <TraceView
                        loading={traceLoading}
                        error={traceError}
                        messages={traceMessages}
                        truncated={traceTruncated}
                      />
                    </div>
                  )}
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
