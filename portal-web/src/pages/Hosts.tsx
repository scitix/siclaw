import { useState, useEffect } from "react"
import { Plus, Monitor, Trash2, Loader2 } from "lucide-react"
import { api } from "../api"

interface Host {
  id: string; name: string; ip: string; port: number; username: string; auth_type: string; description: string; created_at: string
}

export function Hosts() {
  const [hosts, setHosts] = useState<Host[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: "", ip: "", port: "22", username: "root", auth_type: "password", password: "", private_key: "", description: "" })
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    api<Host[]>("/hosts").then(setHosts).finally(() => setLoading(false))
  }, [])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const h = await api<Host>("/hosts", { method: "POST", body: { ...form, port: parseInt(form.port) } })
      setHosts((prev) => [...prev, h])
      setShowCreate(false)
      setForm({ name: "", ip: "", port: "22", username: "root", auth_type: "password", password: "", private_key: "", description: "" })
    } catch (err: any) {
      alert(err.message)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this host?")) return
    await api(`/hosts/${id}`, { method: "DELETE" })
    setHosts((prev) => prev.filter((h) => h.id !== id))
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
              <div key={h.id} className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:bg-secondary/30">
                <div>
                  <p className="text-sm font-medium font-mono">{h.name}</p>
                  <p className="text-xs text-muted-foreground">{h.username}@{h.ip}:{h.port} · {h.auth_type}{h.description ? ` · ${h.description}` : ""}</p>
                </div>
                <button onClick={() => handleDelete(h.id)} className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400">
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
