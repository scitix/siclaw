import { useState, useEffect, useMemo } from "react"
import { Plus, Trash2, Loader2, Plug, Pencil, Power, Search, X } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { useConfirm } from "../components/confirm-dialog"

// ── Types ──────────────────────────────────────────────────────────

type McpTransport = "stdio" | "sse" | "streamable-http"

interface McpServer {
  id: string
  org_id: string
  name: string
  transport: McpTransport
  url: string | null
  command: string | null
  args: string[] | null
  env: Record<string, string> | null
  headers: Record<string, string> | null
  enabled: number
  description: string | null
  created_by: string
  created_at: string
  updated_at: string
}

const TRANSPORT_OPTIONS: { value: McpTransport; label: string }[] = [
  { value: "streamable-http", label: "Streamable HTTP" },
  { value: "sse", label: "SSE" },
  { value: "stdio", label: "Stdio" },
]

const TRANSPORT_LABELS: Record<McpTransport, string> = {
  "streamable-http": "Streamable HTTP",
  sse: "SSE",
  stdio: "Stdio",
}

// ── KV Editor ──────────────────────────────────────────────────────

interface KVPair { key: string; value: string }

function kvToRecord(pairs: KVPair[]): Record<string, string> | undefined {
  const filtered = pairs.filter((p) => p.key.trim())
  if (filtered.length === 0) return undefined
  const obj: Record<string, string> = {}
  for (const p of filtered) obj[p.key.trim()] = p.value
  return obj
}

function recordToKv(rec?: Record<string, string> | null): KVPair[] {
  if (!rec || Object.keys(rec).length === 0) return [{ key: "", value: "" }]
  return [...Object.entries(rec).map(([key, value]) => ({ key, value })), { key: "", value: "" }]
}

function KVEditor({ label, pairs, onChange }: { label: string; pairs: KVPair[]; onChange: (p: KVPair[]) => void }) {
  const updatePair = (idx: number, field: "key" | "value", val: string) => {
    onChange(pairs.map((p, i) => (i === idx ? { ...p, [field]: val } : p)))
  }
  const removePair = (idx: number) => {
    const next = pairs.filter((_, i) => i !== idx)
    if (next.length === 0) next.push({ key: "", value: "" })
    onChange(next)
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">{label}</label>
        <button type="button" onClick={() => onChange([...pairs, { key: "", value: "" }])} className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground rounded">
          <Plus className="h-3 w-3" /> Add
        </button>
      </div>
      <div className="space-y-1.5">
        {pairs.map((pair, idx) => (
          <div key={idx} className="flex items-center gap-1.5">
            <input type="text" value={pair.key} onChange={(e) => updatePair(idx, "key", e.target.value)} placeholder="Key" className="flex-1 h-7 px-2 text-xs rounded-md border border-border bg-background font-mono" />
            <input type="text" value={pair.value} onChange={(e) => updatePair(idx, "value", e.target.value)} placeholder="Value" className="flex-1 h-7 px-2 text-xs rounded-md border border-border bg-background font-mono" />
            {pairs.length > 1 && (
              <button type="button" onClick={() => removePair(idx)} className="p-1 text-muted-foreground hover:text-red-400">
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── MCP Form (inline) ──────────────────────────────────────────────

function McpForm({ server, onSave, onCancel }: {
  server?: McpServer | null
  onSave: (data: Record<string, unknown>) => Promise<void>
  onCancel: () => void
}) {
  const isEditing = !!server
  const [transport, setTransport] = useState<McpTransport>(server?.transport || "streamable-http")
  const [name, setName] = useState(server?.name || "")
  const [description, setDescription] = useState(server?.description || "")
  const [url, setUrl] = useState(server?.url || "")
  const [command, setCommand] = useState(server?.command || "")
  const [argsStr, setArgsStr] = useState(server?.args?.join(" ") || "")
  const [envPairs, setEnvPairs] = useState<KVPair[]>(recordToKv(server?.env))
  const [headerPairs, setHeaderPairs] = useState<KVPair[]>(recordToKv(server?.headers))
  const [saving, setSaving] = useState(false)

  const canSave = name.trim() && (transport === "stdio" ? command.trim() : url.trim())

  const handleSave = async () => {
    if (saving || !canSave) return
    setSaving(true)
    try {
      const data: Record<string, unknown> = { name, transport, description: description || undefined }
      if (transport === "stdio") {
        data.command = command
        if (argsStr.trim()) data.args = argsStr.split(/\s+/).filter(Boolean)
        data.env = kvToRecord(envPairs)
      } else {
        data.url = url
        data.headers = kvToRecord(headerPairs)
      }
      await onSave(data)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 rounded-lg border border-border bg-card space-y-3">
      <p className="text-sm font-medium">{isEditing ? "Edit MCP Server" : "New MCP Server"}</p>

      {/* Transport selector */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Transport</label>
        <div className="flex gap-1.5">
          {TRANSPORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              disabled={isEditing}
              onClick={() => setTransport(opt.value)}
              className={`px-3 h-7 text-xs rounded-md border transition-colors ${
                transport === opt.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-foreground/30"
              } ${isEditing ? "opacity-60 cursor-not-allowed" : ""}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Name + Description */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. prometheus, filesystem" className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
        </div>
      </div>

      {/* Transport-specific fields */}
      {transport === "stdio" ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Command *</label>
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="e.g. npx, node, python" className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background font-mono" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Arguments</label>
              <input value={argsStr} onChange={(e) => setArgsStr(e.target.value)} placeholder="e.g. -y @modelcontextprotocol/server" className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background font-mono" />
            </div>
          </div>
          <KVEditor label="Environment Variables" pairs={envPairs} onChange={setEnvPairs} />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">URL *</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={transport === "sse" ? "http://localhost:8000/sse" : "http://localhost:8000/mcp"} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background font-mono" />
          </div>
          <KVEditor label="Headers" pairs={headerPairs} onChange={setHeaderPairs} />
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button onClick={handleSave} disabled={saving || !canSave} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">
          {saving ? "..." : isEditing ? "Save" : "Create"}
        </button>
        <button onClick={onCancel} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground">Cancel</button>
      </div>
    </div>
  )
}

// ── MCP Page ───────────────────────────────────────────────────────

export function MCP() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [transportFilter, setTransportFilter] = useState<McpTransport | "">("")
  const toast = useToast()
  const confirmDialog = useConfirm()

  // Create / Edit
  const [showCreate, setShowCreate] = useState(false)
  const [editingServer, setEditingServer] = useState<McpServer | null>(null)

  // Action loading states
  const [toggling, setToggling] = useState<string | null>(null)

  const fetchServers = async () => {
    try {
      const res = await api<{ data: McpServer[] }>("/siclaw/admin/mcp")
      setServers(Array.isArray(res.data) ? res.data : [])
    } catch {
      setServers([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchServers() }, [])

  const filtered = useMemo(() => {
    let list = servers
    if (transportFilter) list = list.filter((s) => s.transport === transportFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q) ||
        (s.url ?? "").toLowerCase().includes(q) ||
        (s.command ?? "").toLowerCase().includes(q),
      )
    }
    return list
  }, [servers, search, transportFilter])

  const handleCreate = async (data: Record<string, unknown>) => {
    try {
      await api("/siclaw/admin/mcp", { method: "POST", body: data })
      setShowCreate(false)
      await fetchServers()
      toast.success("MCP server created")
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  const handleUpdate = async (data: Record<string, unknown>) => {
    if (!editingServer) return
    try {
      await api(`/siclaw/admin/mcp/${editingServer.id}`, { method: "PUT", body: data })
      setEditingServer(null)
      await fetchServers()
      toast.success("MCP server updated")
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  const handleToggle = async (server: McpServer) => {
    if (toggling) return
    setToggling(server.id)
    try {
      await api(`/siclaw/admin/mcp/${server.id}/toggle`, {
        method: "PUT",
        body: { enabled: !server.enabled },
      })
      setServers((prev) =>
        prev.map((s) => (s.id === server.id ? { ...s, enabled: s.enabled ? 0 : 1 } : s)),
      )
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setToggling(null)
    }
  }

  const handleDelete = async (server: McpServer) => {
    if (!(await confirmDialog({
      title: "Delete MCP Server",
      message: `Delete "${server.name}"? This cannot be undone.`,
      destructive: true,
      confirmLabel: "Delete",
    }))) return
    try {
      await api(`/siclaw/admin/mcp/${server.id}`, { method: "DELETE" })
      setServers((prev) => prev.filter((s) => s.id !== server.id))
      if (editingServer?.id === server.id) setEditingServer(null)
      toast.success("MCP server deleted")
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
          <h1 className="text-lg font-semibold">MCP Servers</h1>
          <p className="text-sm text-muted-foreground">Manage Model Context Protocol server connections</p>
        </div>
        <button onClick={() => { setShowCreate(true); setEditingServer(null) }} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90">
          <Plus className="h-3.5 w-3.5" /> New Server
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="mx-6 my-4">
          <McpForm onSave={handleCreate} onCancel={() => setShowCreate(false)} />
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
          <select
            value={transportFilter}
            onChange={(e) => setTransportFilter(e.target.value as McpTransport | "")}
            className="h-8 px-3 text-sm rounded-md border border-border bg-background text-foreground"
          >
            <option value="">All Transports</option>
            {TRANSPORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      )}

      {/* Server list */}
      <div className="flex-1 overflow-auto">
        {servers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Plug className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No MCP servers configured</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Add a server to connect external tools to your agents</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Search className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No matching servers</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Try adjusting your search or filter</p>
          </div>
        ) : (
          <div className="px-6 py-4 space-y-2">
            {filtered.map((server) => (
              <div key={server.id} className="rounded-lg border border-border/50">
                {/* Server row */}
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
                    <span className="px-2 py-0.5 text-[10px] font-mono rounded border border-border text-muted-foreground">
                      {TRANSPORT_LABELS[server.transport] || server.transport}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono max-w-[200px] truncate hidden sm:block">
                      {server.url || server.command || "\u2014"}
                    </span>
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
                  </div>
                </div>

                {/* Edit form (inline below the server row) */}
                {editingServer?.id === server.id && (
                  <div className="border-t border-border/50 p-3 bg-secondary/10">
                    <McpForm
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
