import { useState, useEffect, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { Plus, Trash2, Play, Pause, Pencil, X, ClipboardList, Loader2, Clock } from "lucide-react"
import { api } from "../api"
import { useToast } from "./toast"
import { useConfirm } from "./confirm-dialog"
import { nextFireHint } from "../lib/taskSchedule"

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

interface AgentTasksProps {
  agentId: string
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

function ScheduleBadge({ schedule }: { schedule: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Clock className="h-3 w-3 text-muted-foreground/60" />
      <span className="text-[12px] text-muted-foreground font-mono">{schedule}</span>
      <span className="px-1 py-[1px] rounded text-[9px] font-medium bg-muted text-muted-foreground/70 uppercase tracking-wider leading-none">
        UTC
      </span>
    </span>
  )
}

interface TaskFormState {
  name: string
  schedule: string
  prompt: string
  description: string
}

const emptyForm: TaskFormState = { name: "", schedule: "", prompt: "", description: "" }

/**
 * L1: the management surface for an agent's scheduled tasks.
 *
 * All CRUD lives here — create (header "+ New Task"), edit (pencil, expands
 * form inline under the row), pause/resume, delete. Row click navigates to
 * L2 for the read-only run history + run-detail drill-down.
 *
 * Edit uses inline expansion rather than a modal to match the Users / Hosts
 * / Clusters pattern already in this project, and to keep the user in the
 * context of the surrounding list.
 */
export function AgentTasks({ agentId }: AgentTasksProps) {
  const toast = useToast()
  const confirmDialog = useConfirm()
  const navigate = useNavigate()

  const [tasks, setTasks] = useState<AgentTask[]>([])
  const [loading, setLoading] = useState(true)

  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState<TaskFormState>(emptyForm)
  const [creating, setCreating] = useState(false)

  // Inline edit: at most one row expanded at a time.
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<TaskFormState>(emptyForm)
  const [savingEdit, setSavingEdit] = useState(false)

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true)
      const res = await api<{ data: AgentTask[] }>(`/siclaw/agents/${agentId}/tasks`)
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
    if (!createForm.name.trim() || !createForm.schedule.trim() || !createForm.prompt.trim()) return
    try {
      setCreating(true)
      const body: Record<string, string> = {
        name: createForm.name.trim(),
        schedule: createForm.schedule.trim(),
        prompt: createForm.prompt.trim(),
      }
      if (createForm.description.trim()) body.description = createForm.description.trim()

      const task = await api<AgentTask>(`/siclaw/agents/${agentId}/tasks`, {
        method: "POST",
        body,
      })
      setTasks((prev) => [...prev, task])
      setCreateForm(emptyForm)
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
      await api(`/siclaw/agents/${agentId}/tasks/${id}`, { method: "DELETE" })
      setTasks((prev) => prev.filter((t) => t.id !== id))
      if (editingTaskId === id) setEditingTaskId(null)
      toast.success("Task deleted")
    } catch (err: any) {
      toast.error(err.message || "Failed to delete task")
    }
  }

  const handleToggleStatus = async (e: React.MouseEvent, task: AgentTask) => {
    e.stopPropagation()
    const newStatus = task.status === "active" ? "paused" : "active"
    try {
      await api(`/siclaw/agents/${agentId}/tasks/${task.id}`, {
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

  const startEdit = (e: React.MouseEvent, task: AgentTask) => {
    e.stopPropagation()
    setEditingTaskId(task.id)
    setEditForm({
      name: task.name,
      schedule: task.schedule,
      prompt: task.prompt,
      description: task.description ?? "",
    })
  }

  const cancelEdit = () => {
    setEditingTaskId(null)
  }

  const saveEdit = async () => {
    if (!editingTaskId) return
    const name = editForm.name.trim()
    const schedule = editForm.schedule.trim()
    const prompt = editForm.prompt.trim()
    if (!name || !schedule || !prompt) {
      toast.error("Name, schedule, and prompt are required")
      return
    }
    setSavingEdit(true)
    try {
      const updated = await api<AgentTask>(`/siclaw/agents/${agentId}/tasks/${editingTaskId}`, {
        method: "PUT",
        body: {
          name,
          schedule,
          prompt,
          description: editForm.description.trim(),
        },
      })
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
      setEditingTaskId(null)
      toast.success("Task updated")
    } catch (err: any) {
      toast.error(err.message || "Failed to update task")
    } finally {
      setSavingEdit(false)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
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

      {showCreate && (
        <div className="mx-6 mt-4 p-4 rounded-lg border border-border bg-card space-y-3">
          <input
            placeholder="Task Name *"
            value={createForm.name}
            onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
            className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <input
            placeholder="Description (optional)"
            value={createForm.description}
            onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
            className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <input
            placeholder="Schedule (e.g. 0 */6 * * *) *"
            value={createForm.schedule}
            onChange={(e) => setCreateForm({ ...createForm, schedule: e.target.value })}
            className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <textarea
            placeholder="Prompt text *"
            value={createForm.prompt}
            onChange={(e) => setCreateForm({ ...createForm, prompt: e.target.value })}
            rows={3}
            className="w-full px-3 py-2 text-[13px] rounded-md border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={creating || !createForm.name.trim() || !createForm.schedule.trim() || !createForm.prompt.trim()}
              className="h-8 px-4 text-[13px] rounded-md bg-primary text-primary-foreground disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create"}
            </button>
            <button
              onClick={() => {
                setShowCreate(false)
                setCreateForm(emptyForm)
              }}
              className="h-8 px-4 text-[13px] rounded-md border border-border text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : tasks.length > 0 ? (
          <div className="min-w-[700px]">
            <div className="sticky top-0 z-10 flex items-center border-b border-border/40 bg-card px-4 py-2.5 text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
              <div className="w-[25%] px-2">Name</div>
              <div className="w-[18%] px-2">Schedule</div>
              <div className="w-[12%] px-2">Status</div>
              <div className="w-[22%] px-2">Last Run</div>
              <div className="flex-1 px-2">Actions</div>
            </div>

            {tasks.map((task) => {
              const isEditing = editingTaskId === task.id
              return (
                <div key={task.id} className="border-b border-border/20">
                  <div
                    onClick={() => { if (!isEditing) navigate(`/agents/${agentId}/tasks/${task.id}`) }}
                    className={`flex items-center px-4 py-2.5 transition-colors ${
                      isEditing ? "bg-muted/20" : "hover:bg-muted/30 cursor-pointer"
                    }`}
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
                      {task.status === "active" && (() => {
                        const hint = nextFireHint(task.schedule)
                        return hint ? (
                          <div className="text-[10px] text-muted-foreground/60 mt-0.5 pl-[18px] tabular-nums">
                            next {hint}
                          </div>
                        ) : null
                      })()}
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
                        onClick={(e) => isEditing ? (e.stopPropagation(), cancelEdit()) : startEdit(e, task)}
                        className={`p-1.5 rounded-md ${
                          isEditing
                            ? "bg-secondary text-foreground"
                            : "hover:bg-secondary text-muted-foreground hover:text-foreground"
                        }`}
                        title={isEditing ? "Close editor" : "Edit"}
                      >
                        {isEditing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                      </button>
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

                  {isEditing && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="px-6 pt-3 pb-5 bg-muted/10 border-t border-border/30 space-y-3"
                    >
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                            Name
                          </label>
                          <input
                            value={editForm.name}
                            onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                            className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                            Schedule (cron)
                          </label>
                          <input
                            value={editForm.schedule}
                            onChange={(e) => setEditForm({ ...editForm, schedule: e.target.value })}
                            className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                          Description
                        </label>
                        <input
                          value={editForm.description}
                          onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                          className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                          Prompt
                        </label>
                        <textarea
                          value={editForm.prompt}
                          onChange={(e) => setEditForm({ ...editForm, prompt: e.target.value })}
                          rows={4}
                          className="w-full px-3 py-2 text-[12px] rounded-md border border-border bg-background font-mono resize-y focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={saveEdit}
                          disabled={savingEdit || !editForm.name.trim() || !editForm.schedule.trim() || !editForm.prompt.trim()}
                          className="h-8 px-4 text-[12px] rounded-md bg-primary text-primary-foreground disabled:opacity-50"
                        >
                          {savingEdit ? "Saving..." : "Save"}
                        </button>
                        <button
                          onClick={cancelEdit}
                          disabled={savingEdit}
                          className="h-8 px-4 text-[12px] rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
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
    </div>
  )
}
