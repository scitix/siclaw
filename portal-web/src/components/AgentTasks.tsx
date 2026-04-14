import { useState, useEffect, useCallback, useRef } from "react"
import { Plus, Trash2, Play, Pause, ClipboardList, Loader2, X, ChevronRight, Clock, AlertCircle, CheckCircle2 } from "lucide-react"
import { api } from "../api"
import { useToast } from "./toast"
import { useConfirm } from "./confirm-dialog"

interface AgentTask {
  id: string
  agent_id: string
  name: string
  description?: string
  schedule: string
  prompt: string
  status: "active" | "paused"
  last_run_at?: string
  last_result?: string
  created_at: string
}

interface TaskRun {
  id: string
  task_id: string
  status: string
  result_text?: string
  error?: string
  duration_ms?: number
  created_at: string
}

interface AgentTasksProps {
  agentId: string
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m ${secs}s`
}

function formatRelativeTime(dateStr: string): string {
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
      ? "bg-green-500/20 text-green-400"
      : status === "running"
        ? "bg-blue-500/20 text-blue-400"
        : status === "error" || status === "failed"
          ? "bg-red-500/20 text-red-400"
          : "bg-gray-500/20 text-gray-400"

  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${styles}`}>
      {status}
    </span>
  )
}

function ScheduleBadge({ schedule }: { schedule: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[12px] text-muted-foreground font-mono">{schedule}</span>
      <span className="px-1 py-[1px] rounded text-[9px] font-medium bg-muted text-muted-foreground/70 uppercase tracking-wider leading-none">
        UTC
      </span>
    </span>
  )
}

// -- Run History Panel --

function RunHistoryPanel({
  agentId,
  task,
  onClose,
}: {
  agentId: string
  task: AgentTask
  onClose: () => void
}) {
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    async function fetchRuns() {
      try {
        setLoading(true)
        setError(null)
        const res = await api<{ data: TaskRun[] }>(
          `/agents/${agentId}/tasks/${task.id}/runs`,
        )
        if (!cancelled) {
          const items = Array.isArray(res.data) ? res.data : Array.isArray(res) ? (res as any) : []
          setRuns(items)
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || "Failed to load run history")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchRuns()
    return () => { cancelled = true }
  }, [agentId, task.id])

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [onClose])

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 transition-opacity duration-200"
        onClick={onClose}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        className="fixed top-0 right-0 z-50 h-full w-[480px] max-w-full bg-card border-l border-border shadow-2xl flex flex-col animate-slide-in-right"
      >
        {/* Panel header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[13px] font-semibold truncate">{task.name}</span>
            <span className="text-[11px] text-muted-foreground">Run History</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Task summary */}
        <div className="px-5 py-3 border-b border-border/40 space-y-1.5 shrink-0">
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            <ScheduleBadge schedule={task.schedule} />
          </div>
          <p className="text-[12px] text-muted-foreground/80 line-clamp-2">{task.prompt}</p>
        </div>

        {/* Runs list */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-16 px-6">
              <AlertCircle className="h-8 w-8 text-red-400/50 mb-2" />
              <p className="text-[13px] text-red-400">{error}</p>
            </div>
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Clock className="h-10 w-10 text-muted-foreground/30 mb-2" />
              <p className="text-[13px] text-muted-foreground">No runs yet</p>
              <p className="text-[11px] text-muted-foreground/70 mt-1">
                Runs will appear here after the task executes
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/20">
              {runs.map((run) => {
                const isExpanded = expandedRunId === run.id
                return (
                  <div key={run.id}>
                    <button
                      onClick={() => setExpandedRunId(isExpanded ? null : run.id)}
                      className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-muted/30 transition-colors"
                    >
                      <div className="shrink-0">
                        <RunStatusBadge status={run.status} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-[12px] text-muted-foreground tabular-nums">
                          {formatRelativeTime(run.created_at)}
                        </span>
                      </div>
                      {run.duration_ms != null && (
                        <span className="text-[11px] text-muted-foreground/60 tabular-nums shrink-0">
                          {formatDuration(run.duration_ms)}
                        </span>
                      )}
                      <ChevronRight
                        className={`h-3.5 w-3.5 text-muted-foreground/50 shrink-0 transition-transform duration-150 ${
                          isExpanded ? "rotate-90" : ""
                        }`}
                      />
                    </button>
                    {isExpanded && (
                      <div className="px-5 pb-3 space-y-2">
                        <div className="text-[11px] text-muted-foreground/70 space-y-1">
                          <div>
                            <span className="font-medium">Timestamp:</span>{" "}
                            {new Date(run.created_at).toLocaleString()}
                          </div>
                          {run.duration_ms != null && (
                            <div>
                              <span className="font-medium">Duration:</span>{" "}
                              {formatDuration(run.duration_ms)}
                            </div>
                          )}
                        </div>
                        {run.result_text && (
                          <div className="rounded-md border border-border bg-background p-3">
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <CheckCircle2 className="h-3 w-3 text-green-400" />
                              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                                Result
                              </span>
                            </div>
                            <pre className="text-[12px] text-foreground/90 whitespace-pre-wrap break-words font-mono leading-relaxed max-h-[200px] overflow-auto">
                              {run.result_text}
                            </pre>
                          </div>
                        )}
                        {run.error && (
                          <div className="rounded-md border border-red-500/20 bg-red-500/5 p-3">
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <AlertCircle className="h-3 w-3 text-red-400" />
                              <span className="text-[10px] font-medium text-red-400 uppercase tracking-wider">
                                Error
                              </span>
                            </div>
                            <pre className="text-[12px] text-red-300/90 whitespace-pre-wrap break-words font-mono leading-relaxed max-h-[200px] overflow-auto">
                              {run.error}
                            </pre>
                          </div>
                        )}
                        {!run.result_text && !run.error && (
                          <p className="text-[11px] text-muted-foreground/50 italic">
                            No output recorded
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Inline keyframes for the slide animation */}
      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in-right {
          animation: slideInRight 0.2s ease-out;
        }
      `}</style>
    </>
  )
}

// -- Main Component --

export function AgentTasks({ agentId }: AgentTasksProps) {
  const toast = useToast()
  const confirmDialog = useConfirm()

  const [tasks, setTasks] = useState<AgentTask[]>([])
  const [loading, setLoading] = useState(true)

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: "", schedule: "", prompt: "", description: "" })
  const [creating, setCreating] = useState(false)

  // Run history panel
  const [selectedTask, setSelectedTask] = useState<AgentTask | null>(null)

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true)
      const res = await api<{ data: AgentTask[] }>(`/agents/${agentId}/tasks`)
      const items = Array.isArray(res.data) ? res.data : Array.isArray(res) ? (res as any) : []
      setTasks(items)
    } catch (err: any) {
      toast.error(err.message || "Failed to load tasks")
    } finally {
      setLoading(false)
    }
  }, [agentId, toast])

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const handleCreate = async () => {
    if (!form.name.trim() || !form.schedule.trim() || !form.prompt.trim()) return
    try {
      setCreating(true)
      const body: Record<string, string> = {
        name: form.name.trim(),
        schedule: form.schedule.trim(),
        prompt: form.prompt.trim(),
      }
      if (form.description.trim()) body.description = form.description.trim()

      const task = await api<AgentTask>(`/agents/${agentId}/tasks`, {
        method: "POST",
        body,
      })
      setTasks((prev) => [...prev, task])
      setForm({ name: "", schedule: "", prompt: "", description: "" })
      setShowCreate(false)
      toast.success("Task created")
    } catch (err: any) {
      toast.error(err.message || "Failed to create task")
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const ok = await confirmDialog({
      title: "Delete Task",
      message: "Are you sure you want to delete this scheduled task? This cannot be undone.",
      destructive: true,
      confirmLabel: "Delete",
    })
    if (!ok) return
    try {
      await api(`/agents/${agentId}/tasks/${id}`, { method: "DELETE" })
      setTasks((prev) => prev.filter((t) => t.id !== id))
      if (selectedTask?.id === id) setSelectedTask(null)
      toast.success("Task deleted")
    } catch (err: any) {
      toast.error(err.message || "Failed to delete task")
    }
  }

  const handleToggleStatus = async (e: React.MouseEvent, task: AgentTask) => {
    e.stopPropagation()
    const newStatus = task.status === "active" ? "paused" : "active"
    try {
      await api(`/agents/${agentId}/tasks/${task.id}`, {
        method: "PUT",
        body: { status: newStatus },
      })
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, status: newStatus } : t)),
      )
      toast.success(`Task ${newStatus === "active" ? "activated" : "paused"}`)
    } catch (err: any) {
      toast.error(err.message || "Failed to update task")
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border">
        <span className="text-[13px] font-medium">Scheduled Tasks</span>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 h-7 px-3 text-[12px] rounded-md bg-primary text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-3.5 w-3.5" />
          New Task
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="mx-6 mt-4 p-4 rounded-lg border border-border bg-card space-y-3">
          <input
            placeholder="Task Name *"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <input
            placeholder="Description (optional)"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <input
            placeholder="Schedule (e.g. 0 */6 * * *) *"
            value={form.schedule}
            onChange={(e) => setForm({ ...form, schedule: e.target.value })}
            className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <textarea
            placeholder="Prompt text *"
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            rows={3}
            className="w-full px-3 py-2 text-[13px] rounded-md border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={creating || !form.name.trim() || !form.schedule.trim() || !form.prompt.trim()}
              className="h-8 px-4 text-[13px] rounded-md bg-primary text-primary-foreground disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create"}
            </button>
            <button
              onClick={() => {
                setShowCreate(false)
                setForm({ name: "", schedule: "", prompt: "", description: "" })
              }}
              className="h-8 px-4 text-[13px] rounded-md border border-border text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : tasks.length > 0 ? (
          <div className="min-w-[700px]">
            {/* Table header */}
            <div className="sticky top-0 z-10 flex items-center border-b border-border/40 bg-card px-4 py-2.5 text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
              <div className="w-[25%] px-2">Name</div>
              <div className="w-[18%] px-2">Schedule</div>
              <div className="w-[12%] px-2">Status</div>
              <div className="w-[22%] px-2">Last Run</div>
              <div className="flex-1 px-2">Actions</div>
            </div>

            {tasks.map((task) => (
              <div
                key={task.id}
                onClick={() => setSelectedTask(task)}
                className="flex items-center border-b border-border/20 px-4 py-2.5 transition-colors hover:bg-muted/30 cursor-pointer"
              >
                <div className="w-[25%] px-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[13px] text-foreground font-medium truncate">
                      {task.name}
                    </span>
                    {task.description && (
                      <span className="text-[11px] text-muted-foreground truncate">
                        {task.description}
                      </span>
                    )}
                  </div>
                </div>
                <div className="w-[18%] px-2">
                  <ScheduleBadge schedule={task.schedule} />
                </div>
                <div className="w-[12%] px-2">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      task.status === "active"
                        ? "bg-green-500/20 text-green-400"
                        : "bg-gray-500/20 text-gray-400"
                    }`}
                  >
                    {task.status}
                  </span>
                </div>
                <div className="w-[22%] px-2">
                  {task.last_run_at ? (
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                          task.last_result === "success" ? "bg-green-500" : "bg-red-500"
                        }`}
                      />
                      <span className="text-[12px] text-muted-foreground tabular-nums">
                        {formatRelativeTime(task.last_run_at)}
                      </span>
                    </div>
                  ) : (
                    <span className="text-[12px] text-muted-foreground">{"\u2014"}</span>
                  )}
                </div>
                <div className="flex-1 px-2 flex items-center gap-1">
                  <button
                    onClick={(e) => handleToggleStatus(e, task)}
                    className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"
                    title={task.status === "active" ? "Pause" : "Activate"}
                  >
                    {task.status === "active" ? (
                      <Pause className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    onClick={(e) => handleDelete(e, task.id)}
                    className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16">
            <ClipboardList className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-[13px] font-medium text-muted-foreground">No scheduled tasks</p>
            <p className="text-[12px] text-muted-foreground/70 mt-1">
              Create a scheduled task to automate agent actions
            </p>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 mt-4 h-8 px-3 text-[13px] rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/50"
            >
              <Plus className="h-3.5 w-3.5" />
              New Task
            </button>
          </div>
        )}
      </div>

      {/* Run history slide-out panel */}
      {selectedTask && (
        <RunHistoryPanel
          agentId={agentId}
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
        />
      )}
    </div>
  )
}
