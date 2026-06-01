import { useState, useEffect } from "react"
import { Plus, Monitor, Trash2, Loader2, Settings, Zap } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { useConfirm } from "../components/confirm-dialog"

interface Host {
  id: string; name: string; ip: string; port: number; username: string; auth_type: string; description: string; is_production: boolean; jump_host_id?: string | null; created_at: string
}

const emptyForm = { name: "", ip: "", port: "22", username: "root", auth_type: "password", password: "", private_key: "", passphrase: "", description: "", is_production: true, jump_host_id: "" }

export function Hosts() {
  const [hosts, setHosts] = useState<Host[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ ...emptyForm })
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ ...emptyForm })
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testingHostId, setTestingHostId] = useState<string | null>(null)
  const toast = useToast()
  const confirmDialog = useConfirm()

  // Test connectivity of an already-saved host (dials its full jump chain).
  const handleTestHost = async (id: string) => {
    setTestingHostId(id)
    try {
      const r = await api<{ ok: boolean; message: string }>(`/hosts/${id}/test`, { method: "POST", body: {} })
      if (r.ok) toast.success(r.message || "SSH connection OK")
      else toast.error(r.message || "Connection failed")
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setTestingHostId(null)
    }
  }

  // Test a connection using the (possibly unsaved) form values, so the operator
  // can validate what they typed before saving. The jump chain is resolved
  // server-side from saved hosts; the target hop uses these inline credentials.
  const handleTestConnection = async (f: typeof emptyForm) => {
    setTesting(true)
    try {
      const body: Record<string, unknown> = {
        ip: f.ip, port: parseInt(f.port), username: f.username,
        auth_type: f.auth_type, jump_host_id: f.jump_host_id || null,
      }
      if (f.auth_type === "password" && f.password) body.password = f.password
      if (f.auth_type === "key" && f.private_key) body.private_key = f.private_key
      if ((f.auth_type === "key" || f.auth_type === "managed") && f.passphrase) body.passphrase = f.passphrase
      const r = await api<{ ok: boolean; message: string }>("/hosts/test-connection", { method: "POST", body })
      if (r.ok) toast.success(r.message || "SSH connection OK")
      else toast.error(r.message || "Connection failed")
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setTesting(false)
    }
  }

  useEffect(() => {
    api<{ data: Host[] }>("/hosts").then((r) => setHosts(Array.isArray(r.data) ? r.data : Array.isArray(r) ? r as any : [])).catch(() => setHosts([])).finally(() => setLoading(false))
  }, [])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const body: Record<string, unknown> = {
        name: form.name, ip: form.ip, port: parseInt(form.port), username: form.username,
        auth_type: form.auth_type, description: form.description, is_production: form.is_production,
        jump_host_id: form.jump_host_id || null,
      }
      if (form.auth_type === "password" && form.password) body.password = form.password
      if (form.auth_type === "key" && form.private_key) body.private_key = form.private_key
      if ((form.auth_type === "key" || form.auth_type === "managed") && form.passphrase) body.passphrase = form.passphrase
      const h = await api<Host>("/hosts", { method: "POST", body })
      setHosts((prev) => [...prev, h])
      setShowCreate(false)
      setForm({ ...emptyForm })
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
    setEditForm({ name: h.name, ip: h.ip, port: String(h.port), username: h.username, auth_type: h.auth_type || "password", password: "", private_key: "", passphrase: "", description: h.description || "", is_production: h.is_production, jump_host_id: h.jump_host_id || "" })
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
        jump_host_id: editForm.jump_host_id || null,
      }
      if (editForm.auth_type === "password" && editForm.password) body.password = editForm.password
      if (editForm.auth_type === "key" && editForm.private_key) body.private_key = editForm.private_key
      if ((editForm.auth_type === "key" || editForm.auth_type === "managed") && editForm.passphrase) body.passphrase = editForm.passphrase
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
        <div className="mx-6 my-4 p-4 rounded-lg border border-border bg-card space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Host Name</label>
              <input placeholder="e.g. gpu-01" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">IP Address</label>
              <input placeholder="e.g. 10.0.1.5" value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Port</label>
              <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Username</label>
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Authentication</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <input type="radio" name="auth" checked={form.auth_type === "password"} onChange={() => setForm({ ...form, auth_type: "password" })} /> Password
              </label>
              <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <input type="radio" name="auth" checked={form.auth_type === "key"} onChange={() => setForm({ ...form, auth_type: "key" })} /> SSH Key
              </label>
              <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <input type="radio" name="auth" checked={form.auth_type === "managed"} onChange={() => setForm({ ...form, auth_type: "managed" })} /> Managed (key on jump host)
              </label>
            </div>
          </div>
          {form.auth_type === "password" && (
            <div>
              <label className="block text-sm font-medium mb-1">Password</label>
              <input type="password" placeholder="SSH password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
            </div>
          )}
          {form.auth_type === "key" && (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">Private Key</label>
                <textarea placeholder="Paste SSH private key (PEM format)" value={form.private_key} onChange={(e) => setForm({ ...form, private_key: e.target.value })} rows={4} className="w-full px-3 py-2 text-xs font-mono rounded-md border border-border bg-background resize-none" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Key Passphrase</label>
                <input type="password" placeholder="Optional — only if the key is encrypted" value={form.passphrase} onChange={(e) => setForm({ ...form, passphrase: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
              </div>
            </>
          )}
          {form.auth_type === "managed" && (
            <div className="rounded-md border border-border bg-secondary/20 p-3 space-y-2">
              <p className="text-xs text-muted-foreground">Authenticates with a private key found on the selected jump host (<span className="font-mono">~/.ssh/id_*</span>). No credential is stored for this host — <span className="font-medium">a Jump Host is required</span>.</p>
              <div>
                <label className="block text-sm font-medium mb-1">Key Passphrase</label>
                <input type="password" placeholder="Optional — only if the jump host's key is encrypted" value={form.passphrase} onChange={(e) => setForm({ ...form, passphrase: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
              </div>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1">Jump Host <span className="text-muted-foreground font-normal">{form.auth_type === "managed" ? "(required — bastion holding the key)" : "(ProxyJump bastion, optional)"}</span></label>
            <select value={form.jump_host_id} onChange={(e) => setForm({ ...form, jump_host_id: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background">
              <option value="">None (direct connection)</option>
              {hosts.map((j) => <option key={j.id} value={j.id}>{j.name} ({j.ip})</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <input placeholder="Optional description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
          </div>
          <div className="flex items-start gap-3">
            <button type="button" role="switch" aria-checked={form.is_production} onClick={() => setForm({ ...form, is_production: !form.is_production })} className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors mt-0.5 ${form.is_production ? "bg-primary" : "bg-muted"}`}>
              <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${form.is_production ? "translate-x-4" : "translate-x-0"}`} />
            </button>
            <div>
              <label className="block text-sm font-medium">Production Environment</label>
              <p className="text-xs text-muted-foreground">Production hosts are only accessible by production agents.</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={creating || !form.name || !form.ip || (form.auth_type === "managed" && !form.jump_host_id)} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">{creating ? "Creating..." : "Create"}</button>
            <button onClick={() => handleTestConnection(form)} disabled={testing || !form.ip || (form.auth_type === "managed" && !form.jump_host_id)} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-50">{testing ? "Testing..." : "Test Connection"}</button>
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
                    <p className="text-xs text-muted-foreground">{h.username}@{h.ip}:{h.port} · {h.auth_type}{h.jump_host_id ? ` · via ${hosts.find((j) => j.id === h.jump_host_id)?.name ?? "jump"}` : ""}{h.description ? ` · ${h.description}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={(e) => { e.stopPropagation(); handleTestHost(h.id) }} disabled={testingHostId === h.id} title="Test connection" className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-50">
                      {testingHostId === h.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); startEditHost(h) }} title="Settings" className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground">
                      <Settings className="h-4 w-4" />
                    </button>
                    <button onClick={() => handleDelete(h.id)} title="Delete" className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                {editingId === h.id && (
                  <div className="ml-4 mt-2 mb-2 p-4 rounded-lg border border-border bg-card space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium mb-1">Host Name</label>
                        <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-1">IP Address</label>
                        <input value={editForm.ip} onChange={(e) => setEditForm({ ...editForm, ip: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-1">Port</label>
                        <input value={editForm.port} onChange={(e) => setEditForm({ ...editForm, port: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-1">Username</label>
                        <input value={editForm.username} onChange={(e) => setEditForm({ ...editForm, username: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Authentication</label>
                      <div className="flex gap-4">
                        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                          <input type="radio" name="edit-auth" checked={editForm.auth_type === "password"} onChange={() => setEditForm({ ...editForm, auth_type: "password" })} /> Password
                        </label>
                        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                          <input type="radio" name="edit-auth" checked={editForm.auth_type === "key"} onChange={() => setEditForm({ ...editForm, auth_type: "key" })} /> SSH Key
                        </label>
                        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                          <input type="radio" name="edit-auth" checked={editForm.auth_type === "managed"} onChange={() => setEditForm({ ...editForm, auth_type: "managed" })} /> Managed (key on jump host)
                        </label>
                      </div>
                    </div>
                    {editForm.auth_type === "password" && (
                      <div>
                        <label className="block text-sm font-medium mb-1">Password</label>
                        <input type="password" placeholder="Leave blank to keep current — type only to overwrite" value={editForm.password} onChange={(e) => setEditForm({ ...editForm, password: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
                      </div>
                    )}
                    {editForm.auth_type === "key" && (
                      <>
                        <div>
                          <label className="block text-sm font-medium mb-1">Private Key</label>
                          <textarea placeholder="Leave blank to keep current — type only to overwrite" value={editForm.private_key} onChange={(e) => setEditForm({ ...editForm, private_key: e.target.value })} rows={4} className="w-full px-3 py-2 text-xs font-mono rounded-md border border-border bg-background resize-none" />
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">Key Passphrase</label>
                          <input type="password" placeholder="Leave blank to keep current — type only to overwrite" value={editForm.passphrase} onChange={(e) => setEditForm({ ...editForm, passphrase: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
                        </div>
                      </>
                    )}
                    {editForm.auth_type === "managed" && (
                      <div className="rounded-md border border-border bg-secondary/20 p-3 space-y-2">
                        <p className="text-xs text-muted-foreground">Authenticates with a private key found on the selected jump host (<span className="font-mono">~/.ssh/id_*</span>). No credential is stored for this host — <span className="font-medium">a Jump Host is required</span>.</p>
                        <div>
                          <label className="block text-sm font-medium mb-1">Key Passphrase</label>
                          <input type="password" placeholder="Leave blank to keep current — type only to overwrite" value={editForm.passphrase} onChange={(e) => setEditForm({ ...editForm, passphrase: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
                        </div>
                      </div>
                    )}
                    <div>
                      <label className="block text-sm font-medium mb-1">Jump Host <span className="text-muted-foreground font-normal">{editForm.auth_type === "managed" ? "(required — bastion holding the key)" : "(ProxyJump bastion, optional)"}</span></label>
                      <select value={editForm.jump_host_id} onChange={(e) => setEditForm({ ...editForm, jump_host_id: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background">
                        <option value="">None (direct connection)</option>
                        {hosts.filter((j) => j.id !== h.id).map((j) => <option key={j.id} value={j.id}>{j.name} ({j.ip})</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Description</label>
                      <input value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
                    </div>
                    <div className="flex items-start gap-3">
                      <button type="button" role="switch" aria-checked={editForm.is_production} onClick={() => setEditForm({ ...editForm, is_production: !editForm.is_production })} className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors mt-0.5 ${editForm.is_production ? "bg-primary" : "bg-muted"}`}>
                        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${editForm.is_production ? "translate-x-4" : "translate-x-0"}`} />
                      </button>
                      <div>
                        <label className="block text-sm font-medium">Production Environment</label>
                        <p className="text-xs text-muted-foreground">Production hosts are only accessible by production agents.</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={handleSaveEdit} disabled={saving || !editForm.name || !editForm.ip || (editForm.auth_type === "managed" && !editForm.jump_host_id)} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">{saving ? "Saving..." : "Save"}</button>
                      <button onClick={() => handleTestConnection(editForm)} disabled={testing || !editForm.ip || (editForm.auth_type === "managed" && !editForm.jump_host_id)} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-50">{testing ? "Testing..." : "Test Connection"}</button>
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
