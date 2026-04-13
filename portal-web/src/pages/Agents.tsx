import { useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { Plus, Bot, Trash2, Loader2, MessageSquare, Settings } from "lucide-react"
import { api } from "../api"

interface Agent {
  id: string; name: string; description: string; group_name: string; status: string
  model_provider: string; model_id: string; brain_type: string; created_at: string
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
  const [form, setForm] = useState({ name: "", description: "", model_provider: "", model_id: "", brain_type: "pi-agent" })
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    Promise.all([
      api<{ data: Agent[] }>("/agents").then((r) => setAgents(r.data)),
      api<{ data: Provider[] }>("/siclaw/admin/models/providers").then((r) => setProviders(r.data || [])).catch(() => {}),
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
      setForm({ name: "", description: "", model_provider: "", model_id: "", brain_type: "pi-agent" })
    } catch (err: any) { alert(err.message) } finally { setCreating(false) }
  }

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this agent?")) return
    await api(`/agents/${id}`, { method: "DELETE" })
    setAgents((prev) => prev.filter((a) => a.id !== id))
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
        <div className="mx-6 my-4 p-4 rounded-lg border border-border bg-card space-y-3">
          <input placeholder="Agent Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
          <input placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
          <div className="grid grid-cols-2 gap-3">
            {/* Provider dropdown */}
            <select
              value={form.model_provider}
              onChange={(e) => setForm({ ...form, model_provider: e.target.value, model_id: "" })}
              className="h-8 px-3 text-sm rounded-md border border-border bg-background"
            >
              <option value="">Select Provider</option>
              {providers.map((p) => (
                <option key={p.id} value={p.name}>{p.name}</option>
              ))}
            </select>
            {/* Model dropdown */}
            <select
              value={form.model_id}
              onChange={(e) => setForm({ ...form, model_id: e.target.value })}
              disabled={!form.model_provider}
              className="h-8 px-3 text-sm rounded-md border border-border bg-background disabled:opacity-50"
            >
              <option value="">Select Model</option>
              {availableModels.map((m) => (
                <option key={m.id} value={m.model_id}>{m.name || m.model_id}</option>
              ))}
            </select>
          </div>
          {providers.length === 0 && (
            <p className="text-xs text-muted-foreground">No providers configured. <button onClick={() => navigate("/models")} className="underline hover:text-foreground">Add one first</button></p>
          )}
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
              <div key={a.id} className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:bg-secondary/30 cursor-pointer" onClick={() => navigate(`/agents/${a.id}`)}>
                <div className="flex items-center gap-3">
                  <Bot className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium font-mono">{a.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {getModelDisplay(a)}
                      {a.model_provider && ` · ${a.model_provider}`}
                      {a.description ? ` · ${a.description}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <span className={`h-2 w-2 rounded-full ${a.status === "active" ? "bg-green-500" : "bg-gray-500"}`} />
                  <button onClick={(e) => { e.stopPropagation(); navigate(`/chat?agent=${a.id}`) }} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground"><MessageSquare className="h-4 w-4" /></button>
                  <button onClick={(e) => { e.stopPropagation(); navigate(`/agents/${a.id}?tab=settings`) }} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground"><Settings className="h-4 w-4" /></button>
                  <button onClick={(e) => { e.stopPropagation(); handleDelete(a.id) }} className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
