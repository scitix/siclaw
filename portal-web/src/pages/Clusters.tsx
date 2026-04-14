import { useState, useEffect } from "react"
import { Plus, Server, Trash2, Loader2, Settings } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { useConfirm } from "../components/confirm-dialog"

interface Cluster {
  id: string; name: string; description: string; api_server: string; debug_image: string | null; is_production: boolean; created_at: string
}

export function Clusters() {
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: "", description: "", kubeconfig: "", debug_image: "", is_production: true })
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: "", description: "", kubeconfig: "", debug_image: "", is_production: true })
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const confirmDialog = useConfirm()

  useEffect(() => {
    api<{ data: Cluster[] }>("/clusters").then((r) => setClusters(Array.isArray(r.data) ? r.data : Array.isArray(r) ? r as any : [])).catch(() => setClusters([])).finally(() => setLoading(false))
  }, [])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        description: form.description,
        kubeconfig: form.kubeconfig,
        is_production: form.is_production,
      }
      if (form.debug_image) payload.debug_image = form.debug_image
      const c = await api<Cluster>("/clusters", { method: "POST", body: payload })
      setClusters((prev) => [...prev, c])
      setShowCreate(false)
      setForm({ name: "", description: "", kubeconfig: "", debug_image: "", is_production: true })
      toast.success("Cluster created")
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog({ title: "Delete Cluster", message: "Delete this cluster? Agents using it will lose access.", destructive: true, confirmLabel: "Delete" }))) return
    await api(`/clusters/${id}`, { method: "DELETE" })
    setClusters((prev) => prev.filter((c) => c.id !== id))
  }

  const startEditCluster = (c: Cluster) => {
    setEditingId(c.id)
    setEditForm({ name: c.name, description: c.description || "", kubeconfig: "", debug_image: c.debug_image || "", is_production: c.is_production })
  }

  const handleSaveEdit = async () => {
    if (!editingId) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        name: editForm.name,
        description: editForm.description,
        is_production: editForm.is_production,
        debug_image: editForm.debug_image || null,
      }
      if (editForm.kubeconfig) body.kubeconfig = editForm.kubeconfig
      const updated = await api<Cluster>(`/clusters/${editingId}`, { method: "PUT", body })
      setClusters((prev) => prev.map((c) => c.id === editingId ? updated : c))
      setEditingId(null)
      toast.success("Cluster updated")
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
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
          <input placeholder="Debug image (optional, e.g. nicolaka/netshoot:latest)" value={form.debug_image} onChange={(e) => setForm({ ...form, debug_image: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={form.is_production} onChange={(e) => setForm({ ...form, is_production: e.target.checked })} />
            Production environment
          </label>
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
              <div key={c.id}>
                <div className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:bg-secondary/30">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium font-mono">{c.name}</p>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${c.is_production ? "bg-red-500/20 text-red-400" : "bg-blue-500/20 text-blue-400"}`}>
                        {c.is_production ? "PROD" : "DEV"}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{c.api_server || "No API server"}{c.description ? ` · ${c.description}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={(e) => { e.stopPropagation(); startEditCluster(c) }} title="Settings" className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground">
                      <Settings className="h-4 w-4" />
                    </button>
                    <button onClick={() => handleDelete(c.id)} title="Delete" className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                {editingId === c.id && (
                  <div className="ml-4 mt-2 mb-2 p-4 rounded-lg border border-border bg-card space-y-3">
                    <input placeholder="Cluster Name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
                    <input placeholder="Description" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
                    <div>
                      <textarea placeholder="Paste kubeconfig YAML here..." value={editForm.kubeconfig} onChange={(e) => setEditForm({ ...editForm, kubeconfig: e.target.value })} rows={6} className="w-full px-3 py-2 text-xs font-mono rounded-md border border-border bg-background resize-none" />
                      <p className="text-xs text-muted-foreground mt-1">Leave empty to keep current</p>
                    </div>
                    <input placeholder="Debug image (optional)" value={editForm.debug_image} onChange={(e) => setEditForm({ ...editForm, debug_image: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      <input type="checkbox" checked={editForm.is_production} onChange={(e) => setEditForm({ ...editForm, is_production: e.target.checked })} />
                      Production environment
                    </label>
                    <div className="flex gap-2">
                      <button onClick={handleSaveEdit} disabled={saving || !editForm.name} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">{saving ? "Saving..." : "Save"}</button>
                      <button onClick={() => setEditingId(null)} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
