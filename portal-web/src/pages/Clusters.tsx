import { useState, useEffect } from "react"
import { Plus, Server, Trash2, Loader2 } from "lucide-react"
import { api } from "../api"

interface Cluster {
  id: string; name: string; description: string; api_server: string; created_at: string
}

export function Clusters() {
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: "", description: "", kubeconfig: "" })
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    api<Cluster[]>("/clusters").then(setClusters).finally(() => setLoading(false))
  }, [])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const c = await api<Cluster>("/clusters", { method: "POST", body: form })
      setClusters((prev) => [...prev, c])
      setShowCreate(false)
      setForm({ name: "", description: "", kubeconfig: "" })
    } catch (err: any) {
      alert(err.message)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this cluster?")) return
    await api(`/clusters/${id}`, { method: "DELETE" })
    setClusters((prev) => prev.filter((c) => c.id !== id))
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-lg font-semibold">Clusters</h1>
          <p className="text-sm text-muted-foreground">Manage Kubernetes clusters for your agents</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90">
          <Plus className="h-3.5 w-3.5" /> Add Cluster
        </button>
      </div>

      {showCreate && (
        <div className="mx-6 my-4 p-4 rounded-lg border border-border bg-card space-y-3">
          <input placeholder="Cluster Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
          <input placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
          <textarea placeholder="Paste kubeconfig YAML here..." value={form.kubeconfig} onChange={(e) => setForm({ ...form, kubeconfig: e.target.value })} rows={6} className="w-full px-3 py-2 text-xs font-mono rounded-md border border-border bg-background resize-none" />
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={creating || !form.name || !form.kubeconfig} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">{creating ? "Creating..." : "Create"}</button>
            <button onClick={() => setShowCreate(false)} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {clusters.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Server className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No clusters configured</p>
          </div>
        ) : (
          <div className="px-6 py-4 space-y-2">
            {clusters.map((c) => (
              <div key={c.id} className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:bg-secondary/30">
                <div>
                  <p className="text-sm font-medium font-mono">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{c.api_server || "No API server"}{c.description ? ` · ${c.description}` : ""}</p>
                </div>
                <button onClick={() => handleDelete(c.id)} className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
