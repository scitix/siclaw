import { useState, useEffect, useMemo } from "react"
import { Plus, Trash2, Loader2, Bot, Pencil, Power, Search, X } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { useConfirm } from "../components/confirm-dialog"

// ── Types ──────────────────────────────────────────────────────────

interface A2AServer {
  id: string
  org_id: string
  name: string
  base_url: string
  description: string | null
  enabled: number
  created_by: string
  created_at: string
  updated_at: string
  // api_key is never returned by the API — only this flag indicates presence.
  has_api_key: boolean
}

// ── A2A Form (inline) ──────────────────────────────────────────────

function A2AForm({ server, onSave, onCancel }: {
  server?: A2AServer | null
  onSave: (data: Record<string, unknown>) => Promise<void>
  onCancel: () => void
}) {
  const isEditing = !!server
  const [name, setName] = useState(server?.name || "")
  const [baseUrl, setBaseUrl] = useState(server?.base_url || "")
  const [apiKey, setApiKey] = useState("")
  const [description, setDescription] = useState(server?.description || "")
  const [saving, setSaving] = useState(false)

  const canSave = name.trim() && baseUrl.trim()

  const handleSave = async () => {
    if (saving || !canSave) return
    setSaving(true)
    try {
      const data: Record<string, unknown> = {
        name: name.trim(),
        base_url: baseUrl.trim(),
        description: description.trim() || undefined,
      }
      // Only send api_key when the admin typed one. On edit, leaving it blank
      // keeps the stored key unchanged (the server never echoes it back).
      if (apiKey.trim()) data.api_key = apiKey.trim()
      await onSave(data)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 rounded-lg border border-border bg-card space-y-3">
      <p className="text-sm font-medium">{isEditing ? "Edit A2A Server" : "New A2A Server"}</p>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. research-agent" className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Base URL *</label>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://agent.example.com" className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background font-mono" />
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">API Key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={isEditing && server?.has_api_key ? "API Key is set — leave blank to keep unchanged" : "Optional"}
          autoComplete="new-password"
          className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background font-mono"
        />
        {isEditing && server?.has_api_key && (
          <p className="text-[11px] text-muted-foreground/70">An API Key is already set. Leave this blank to keep it, or type a new value to replace it.</p>
        )}
      </div>

      <div className="flex gap-2">
        <button onClick={handleSave} disabled={saving || !canSave} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">
          {saving ? "..." : isEditing ? "Save" : "Create"}
        </button>
        <button onClick={onCancel} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground">Cancel</button>
      </div>
    </div>
  )
}

// ── A2A Page ───────────────────────────────────────────────────────

export function A2A() {
  const [servers, setServers] = useState<A2AServer[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [isAdmin, setIsAdmin] = useState(false)
  const toast = useToast()
  const confirmDialog = useConfirm()

  const [showCreate, setShowCreate] = useState(false)
  const [editingServer, setEditingServer] = useState<A2AServer | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)

  const fetchServers = async () => {
    try {
      const res = await api<{ data: A2AServer[] }>("/siclaw/a2a")
      setServers(Array.isArray(res.data) ? res.data : [])
    } catch {
      setServers([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchServers()
    api<{ role: string }>("/auth/me").then((u) => setIsAdmin(u.role === "admin")).catch(() => {})
  }, [])

  const filtered = useMemo(() => {
    let list = servers
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q) ||
        s.base_url.toLowerCase().includes(q),
      )
    }
    return list
  }, [servers, search])

  const handleCreate = async (data: Record<string, unknown>) => {
    try {
      await api("/siclaw/a2a", { method: "POST", body: data })
      setShowCreate(false)
      await fetchServers()
      toast.success("A2A server created")
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  const handleUpdate = async (data: Record<string, unknown>) => {
    if (!editingServer) return
    try {
      await api(`/siclaw/a2a/${editingServer.id}`, { method: "PUT", body: data })
      setEditingServer(null)
      await fetchServers()
      toast.success("A2A server updated")
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  const handleToggle = async (server: A2AServer) => {
    if (toggling) return
    setToggling(server.id)
    try {
      await api(`/siclaw/a2a/${server.id}/toggle`, {
        method: "PUT",
        body: { enabled: !server.enabled },
      })
      setServers((prev) =>
        prev.map((s) => (s.id === server.id ? { ...s, enabled: s.enabled ? 0 : 1 } : s)),
      )
      toast.success(
        server.enabled
          ? "Server disabled — open chats will stop using it on the next message"
          : "Server enabled — open chats will pick it up on the next message",
      )
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setToggling(null)
    }
  }

  const handleDelete = async (server: A2AServer) => {
    if (!(await confirmDialog({
      title: "Delete A2A Server",
      message: `Delete "${server.name}"? This cannot be undone.`,
      destructive: true,
      confirmLabel: "Delete",
    }))) return
    try {
      await api(`/siclaw/a2a/${server.id}`, { method: "DELETE" })
      setServers((prev) => prev.filter((s) => s.id !== server.id))
      if (editingServer?.id === server.id) setEditingServer(null)
      toast.success("A2A server deleted — open chats will stop using it on the next message")
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-lg font-semibold">A2A Servers</h1>
          <p className="text-sm text-muted-foreground">
            Manage Agent-to-Agent server connections · changes apply to the next message in any open chat
          </p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setShowCreate(true); setEditingServer(null) }}
              className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" /> New Server
            </button>
          </div>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="mx-6 my-4">
          <A2AForm onSave={handleCreate} onCancel={() => setShowCreate(false)} />
        </div>
      )}

      {/* Filters */}
      {servers.length > 0 && (
        <div className="flex items-center gap-3 px-6 pt-4">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search servers..."
              className="w-full h-8 pl-8 pr-3 text-sm rounded-md border border-border bg-background"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Server list */}
      <div className="flex-1 overflow-auto">
        {servers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Bot className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No A2A servers configured</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Add a server to connect external agents to your agents</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Search className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No matching servers</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Try adjusting your search</p>
          </div>
        ) : (
          <div className="px-6 py-4 space-y-2">
            {filtered.map((server) => (
              <div key={server.id} className="rounded-lg border border-border/50">
                <div className="flex items-center justify-between p-3 hover:bg-secondary/30 transition-colors">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${server.enabled ? "bg-green-500" : "bg-muted-foreground/40"}`} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium font-mono truncate">{server.name}</p>
                      {server.description && (
                        <p className="text-xs text-muted-foreground truncate">{server.description}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {server.has_api_key && (
                      <span className="px-2 py-0.5 text-[10px] font-mono rounded border border-border text-muted-foreground">
                        API Key
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground font-mono max-w-[200px] truncate hidden sm:block">
                      {server.base_url || "—"}
                    </span>
                    {isAdmin && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleToggle(server)}
                          disabled={toggling === server.id}
                          className={`p-1.5 rounded-md transition-colors ${
                            server.enabled
                              ? "text-green-500 hover:text-orange-400 hover:bg-secondary"
                              : "text-muted-foreground hover:text-green-500 hover:bg-secondary"
                          } disabled:opacity-50`}
                          title={server.enabled ? "Disable" : "Enable"}
                        >
                          {toggling === server.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          onClick={() => { setEditingServer(server); setShowCreate(false) }}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                          title="Edit"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(server)}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-red-400 hover:bg-destructive/20 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {editingServer?.id === server.id && (
                  <div className="border-t border-border/50 p-3 bg-secondary/10">
                    <A2AForm
                      server={server}
                      onSave={handleUpdate}
                      onCancel={() => setEditingServer(null)}
                    />
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
