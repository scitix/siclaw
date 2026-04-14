import { useState, useEffect } from "react"
import { Plus, Monitor, Trash2, Loader2, Settings } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { useConfirm } from "../components/confirm-dialog"

interface Host {
  id: string; name: string; ip: string; port: number; username: string; auth_type: string; description: string; is_production: boolean; created_at: string
}

export function Hosts() {
  const [hosts, setHosts] = useState<Host[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: "", ip: "", port: "22", username: "root", auth_type: "password", password: "", private_key: "", description: "", is_production: true })
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: "", ip: "", port: "22", username: "root", auth_type: "password", password: "", private_key: "", description: "", is_production: true })
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const confirmDialog = useConfirm()

  useEffect(() => {
    api<{ data: Host[] }>("/hosts").then((r) => setHosts(Array.isArray(r.data) ? r.data : Array.isArray(r) ? r as any : [])).catch(() => setHosts([])).finally(() => setLoading(false))
  }, [])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const h = await api<Host>("/hosts", { method: "POST", body: { ...form, port: parseInt(form.port) } })
      setHosts((prev) => [...prev, h])
      setShowCreate(false)
      setForm({ name: "", ip: "", port: "22", username: "root", auth_type: "password", password: "", private_key: "", description: "", is_production: true })
      toast.success("Host created")
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog({ title: "Delete Host", message: "Delete this host? Agents using it will lose access.", destructive: true, confirmLabel: "Delete" }))) return
    await api(`/hosts/${id}`, { method: "DELETE" })
    setHosts((prev) => prev.filter((h) => h.id !== id))
  }

  const startEditHost = (h: Host) => {
    setEditingId(h.id)
    setEditForm({ name: h.name, ip: h.ip, port: String(h.port), username: h.username, auth_type: h.auth_type || "password", password: "", private_key: "", description: h.description || "", is_production: h.is_production })
  }

  const handleSaveEdit = async () => {
    if (!editingId) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        name: editForm.name,
        ip: editForm.ip,
        port: parseInt(editForm.port),
        username: editForm.username,
        auth_type: editForm.auth_type,
        description: editForm.description,
        is_production: editForm.is_production,
      }
      if (editForm.auth_type === "password" && editForm.password) body.password = editForm.password
      if (editForm.auth_type === "key" && editForm.private_key) body.private_key = editForm.private_key
      const updated = await api<Host>(`/hosts/${editingId}`, { method: "PUT", body })
      setHosts((prev) => prev.map((h) => h.id === editingId ? updated : h))
      setEditingId(null)
      toast.success("Host updated")
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
          <h1 className="text-lg font-semibold">Hosts</h1>
          <p className="text-sm text-muted-foreground">Manage SSH hosts for your agents</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90">
          <Plus className="h-3.5 w-3.5" /> Add Host
        </button>
      </div>

      {showCreate && (
        <div className="mx-6 my-4 p-4 rounded-lg border border-border bg-card space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Host Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="h-8 px-3 text-sm rounded-md border border-border bg-background" />
            <input placeholder="IP Address" value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} className="h-8 px-3 text-sm rounded-md border border-border bg-background" />
            <input placeholder="Port" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} className="h-8 px-3 text-sm rounded-md border border-border bg-background" />
            <input placeholder="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className="h-8 px-3 text-sm rounded-md border border-border bg-background" />
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <input type="radio" name="auth" checked={form.auth_type === "password"} onChange={() => setForm({ ...form, auth_type: "password" })} /> Password
            </label>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <input type="radio" name="auth" checked={form.auth_type === "key"} onChange={() => setForm({ ...form, auth_type: "key" })} /> SSH Key
            </label>
          </div>
          {form.auth_type === "password" ? (
            <input type="password" placeholder="Password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
          ) : (
            <textarea placeholder="Paste SSH private key (PEM)" value={form.private_key} onChange={(e) => setForm({ ...form, private_key: e.target.value })} rows={4} className="w-full px-3 py-2 text-xs font-mono rounded-md border border-border bg-background resize-none" />
          )}
          <input placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={form.is_production} onChange={(e) => setForm({ ...form, is_production: e.target.checked })} />
            Production environment
          </label>
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={creating || !form.name || !form.ip} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">{creating ? "Creating..." : "Create"}</button>
            <button onClick={() => setShowCreate(false)} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {hosts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Monitor className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No hosts configured</p>
          </div>
        ) : (
          <div className="px-6 py-4 space-y-2">
            {hosts.map((h) => (
              <div key={h.id}>
                <div className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:bg-secondary/30">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium font-mono">{h.name}</p>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${h.is_production ? "bg-red-500/20 text-red-400" : "bg-blue-500/20 text-blue-400"}`}>
                        {h.is_production ? "PROD" : "DEV"}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{h.username}@{h.ip}:{h.port} · {h.auth_type}{h.description ? ` · ${h.description}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={(e) => { e.stopPropagation(); startEditHost(h) }} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground">
                      <Settings className="h-4 w-4" />
                    </button>
                    <button onClick={() => handleDelete(h.id)} className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                {editingId === h.id && (
                  <div className="ml-4 mt-2 mb-2 p-4 rounded-lg border border-border bg-card space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <input placeholder="Host Name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="h-8 px-3 text-sm rounded-md border border-border bg-background" />
                      <input placeholder="IP Address" value={editForm.ip} onChange={(e) => setEditForm({ ...editForm, ip: e.target.value })} className="h-8 px-3 text-sm rounded-md border border-border bg-background" />
                      <input placeholder="Port" value={editForm.port} onChange={(e) => setEditForm({ ...editForm, port: e.target.value })} className="h-8 px-3 text-sm rounded-md border border-border bg-background" />
                      <input placeholder="Username" value={editForm.username} onChange={(e) => setEditForm({ ...editForm, username: e.target.value })} className="h-8 px-3 text-sm rounded-md border border-border bg-background" />
                    </div>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <input type="radio" name="edit-auth" checked={editForm.auth_type === "password"} onChange={() => setEditForm({ ...editForm, auth_type: "password" })} /> Password
                      </label>
                      <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <input type="radio" name="edit-auth" checked={editForm.auth_type === "key"} onChange={() => setEditForm({ ...editForm, auth_type: "key" })} /> SSH Key
                      </label>
                    </div>
                    {editForm.auth_type === "password" ? (
                      <input type="password" placeholder="Leave empty to keep current" value={editForm.password} onChange={(e) => setEditForm({ ...editForm, password: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
                    ) : (
                      <textarea placeholder="Leave empty to keep current" value={editForm.private_key} onChange={(e) => setEditForm({ ...editForm, private_key: e.target.value })} rows={4} className="w-full px-3 py-2 text-xs font-mono rounded-md border border-border bg-background resize-none" />
                    )}
                    <input placeholder="Description (optional)" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      <input type="checkbox" checked={editForm.is_production} onChange={(e) => setEditForm({ ...editForm, is_production: e.target.checked })} />
                      Production environment
                    </label>
                    <div className="flex gap-2">
                      <button onClick={handleSaveEdit} disabled={saving || !editForm.name || !editForm.ip} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">{saving ? "Saving..." : "Save"}</button>
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
