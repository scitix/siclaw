import { useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { Plus, Bot, Trash2, Loader2, MessageSquare, Settings, Eraser, Zap, Plug, Server, Clock, BoltIcon, BookOpen } from "lucide-react"
import { api, clearAgentMemory } from "../api"
import { useToast } from "../components/toast"
import { Tooltip } from "../components/tooltip"
import { useConfirm } from "../components/confirm-dialog"

interface Agent {
  id: string; name: string; description: string; status: string
  model_provider: string; model_id: string; is_production: boolean; created_at: string
  skills_count?: number; mcp_count?: number; clusters_count?: number; hosts_count?: number; tasks_count?: number; tasks_active_count?: number; knowledge_count?: number
}

interface ModelEntry {
  id: string; model_id: string; name: string
}

interface Provider {
  id: string; name: string; models?: ModelEntry[]
}

export function Agents() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: "", description: "", model_provider: "", model_id: "", is_production: true })
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()
  const toast = useToast()
  const confirmDialog = useConfirm()

  useEffect(() => {
    Promise.all([
      api<{ data: Agent[] }>("/agents").then((r) => setAgents(Array.isArray(r.data) ? r.data : [])).catch(() => setAgents([])),
      api<{ data: Provider[] }>("/siclaw/admin/models/providers").then((r) => setProviders(Array.isArray(r.data) ? r.data : [])).catch(() => setProviders([])),
    ]).finally(() => setLoading(false))
  }, [])

  // Models for selected provider
  const selectedProvider = providers.find((p) => p.name === form.model_provider)
  const availableModels = selectedProvider?.models || []

  const handleCreate = async () => {
    setCreating(true)
    try {
      const a = await api<Agent>("/agents", { method: "POST", body: form })
      setAgents((prev) => [...prev, a])
      setShowCreate(false)
      setForm({ name: "", description: "", model_provider: "", model_id: "", is_production: true })
    } catch (err: any) { toast.error(err.message) } finally { setCreating(false) }
  }

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog({ title: "Delete Agent", message: "Are you sure you want to delete this agent? This cannot be undone.", destructive: true, confirmLabel: "Delete" }))) return
    await api(`/agents/${id}`, { method: "DELETE" })
    setAgents((prev) => prev.filter((a) => a.id !== id))
  }

  const handleClearMemory = async (id: string) => {
    if (!(await confirmDialog({ title: "Clear Agent Memory", message: "Delete all investigation files and memory records for this agent. Session history is not affected.", destructive: true, confirmLabel: "Clear Memory" }))) return
    try {
      const result = await clearAgentMemory(id)
      toast.success(`Memory cleared (${result.deletedFiles} files removed)`)
    } catch (err: any) { toast.error(err.message) }
  }

  // Resolve model display name
  const getModelDisplay = (agent: Agent): string => {
    if (!agent.model_id) return "No model"
    const p = providers.find((pr) => pr.name === agent.model_provider)
    const m = p?.models?.find((mo) => mo.model_id === agent.model_id)
    return m?.name || agent.model_id
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-lg font-semibold">Agents</h1>
          <p className="text-sm text-muted-foreground">Manage AI agents</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90">
          <Plus className="h-3.5 w-3.5" /> New Agent
        </button>
      </div>

      {showCreate && (
        <div className="mx-6 my-4 p-4 rounded-lg border border-border bg-card space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Agent Name</label>
            <input placeholder="e.g. sre-copilot" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <input placeholder="Optional description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Provider</label>
              <select
                value={form.model_provider}
                onChange={(e) => setForm({ ...form, model_provider: e.target.value, model_id: "" })}
                className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background"
              >
                <option value="">Select Provider</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Model</label>
              <select
                value={form.model_id}
                onChange={(e) => setForm({ ...form, model_id: e.target.value })}
                disabled={!form.model_provider}
                className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background disabled:opacity-50"
              >
                <option value="">Select Model</option>
                {availableModels.map((m) => (
                  <option key={m.id} value={m.model_id}>{m.name || m.model_id}</option>
                ))}
              </select>
            </div>
          </div>
          {providers.length === 0 && (
            <p className="text-xs text-muted-foreground">No providers configured. <button onClick={() => navigate("/settings/models")} className="underline hover:text-foreground">Add one first</button></p>
          )}
          <div className="flex items-start gap-3">
            <button type="button" role="switch" aria-checked={form.is_production} onClick={() => setForm({ ...form, is_production: !form.is_production })} className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors mt-0.5 ${form.is_production ? "bg-primary" : "bg-muted"}`}>
              <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${form.is_production ? "translate-x-4" : "translate-x-0"}`} />
            </button>
            <div>
              <label className="block text-sm font-medium">Production Agent</label>
              <p className="text-xs text-muted-foreground">Production agents only receive approved skills and can only access production clusters/hosts. Dev agents see draft skills and dev resources.</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={creating || !form.name} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">{creating ? "..." : "Create"}</button>
            <button onClick={() => setShowCreate(false)} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Bot className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No agents yet</p>
          </div>
        ) : (
          <div className="px-6 py-4 space-y-2">
            {agents.map((a) => (
              <div key={a.id} className="flex items-center gap-4 p-4 rounded-lg border border-border/50 hover:bg-secondary/20 cursor-pointer transition-colors" onClick={() => navigate(`/chat?agent=${a.id}`)}>
                {/* Icon */}
                <div className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0 bg-secondary text-muted-foreground">
                  <Bot className="h-5 w-5" />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-[13px] font-semibold font-mono truncate">{a.name}</p>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] shrink-0 ${a.is_production ? "bg-red-500/20 text-red-400" : "bg-blue-500/20 text-blue-400"}`}>
                      {a.is_production ? "PROD" : "DEV"}
                    </span>
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${a.status === "active" ? "bg-green-500" : "bg-gray-500"}`} />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                    {getModelDisplay(a)}{a.model_provider && ` · ${a.model_provider}`}{a.description ? ` · ${a.description}` : ""}
                  </p>
                  {/* Resource badges */}
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <button onClick={(e) => { e.stopPropagation(); navigate(`/agents/${a.id}?tab=skills`) }} className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                      <Zap className="h-2.5 w-2.5" />{a.skills_count ?? 0} skills
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); navigate(`/agents/${a.id}?tab=mcp`) }} className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                      <Plug className="h-2.5 w-2.5" />{a.mcp_count ?? 0} mcp
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); navigate(`/agents/${a.id}?tab=resources`) }} className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                      <Server className="h-2.5 w-2.5" />{(a.clusters_count ?? 0) + (a.hosts_count ?? 0)} resources
                    </button>
                    {(a.tasks_count ?? 0) > 0 && (
                      <button onClick={(e) => { e.stopPropagation(); navigate(`/agents/${a.id}?tab=tasks`) }} className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                        <Clock className="h-2.5 w-2.5" />{a.tasks_active_count ?? 0}/{a.tasks_count} scheduled
                      </button>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); navigate(`/agents/${a.id}?tab=knowledge`) }} className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                      <BookOpen className="h-2.5 w-2.5" />{a.knowledge_count ?? 0} knowledge
                    </button>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-0.5 shrink-0">
                  <Tooltip content="Chat"><button onClick={(e) => { e.stopPropagation(); navigate(`/chat?agent=${a.id}`) }} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"><MessageSquare className="h-4 w-4" /></button></Tooltip>
                  <Tooltip content="Clear Memory"><button onClick={(e) => { e.stopPropagation(); handleClearMemory(a.id) }} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"><Eraser className="h-4 w-4" /></button></Tooltip>
                  <Tooltip content="Settings"><button onClick={(e) => { e.stopPropagation(); navigate(`/agents/${a.id}?tab=basic`) }} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"><Settings className="h-4 w-4" /></button></Tooltip>
                  <Tooltip content="Delete"><button onClick={(e) => { e.stopPropagation(); handleDelete(a.id) }} className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400"><Trash2 className="h-4 w-4" /></button></Tooltip>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
