import { useState, useEffect, useMemo, useRef } from "react"
import { Plus, Trash2, Loader2, Plug, Pencil, Power, Search, X, Download, Upload, Check, ChevronRight } from "lucide-react"
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

interface McpConfigEntry {
  name?: string
  transport?: string
  url?: string | null
  command?: string | null
  args?: string[] | null
  env?: Record<string, string> | null
  headers?: Record<string, string> | null
  description?: string | null
  enabled?: boolean
}

interface McpConfigBundle { mcpServer?: McpConfigEntry }

interface McpImportFieldDiff { field: string; before: unknown; after: unknown }

interface McpImportPreview {
  action: "create" | "update" | "unchanged" | "invalid"
  name?: string
  id?: string
  transport?: string
  bound_agents?: number
  diffs: McpImportFieldDiff[]
  errors: string[]
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

// ── Helpers ────────────────────────────────────────────────────────

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function formatDiffValue(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
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

      <div className="flex gap-2">
        <button onClick={handleSave} disabled={saving || !canSave} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">
          {saving ? "..." : isEditing ? "Save" : "Create"}
        </button>
        <button onClick={onCancel} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground">Cancel</button>
      </div>
    </div>
  )
}

// ── Export Dialog ──────────────────────────────────────────────────

function ExportMcpConfigDialog({ server, onClose }: { server: McpServer | null; onClose: () => void }) {
  const [downloading, setDownloading] = useState(false)
  const toast = useToast()

  if (!server) return null

  const handleDownload = async () => {
    setDownloading(true)
    try {
      const res = await api<{ data: McpConfigBundle }>("/siclaw/mcp/export", {
        method: "POST",
        body: { mcp_server_id: server.id },
      })
      downloadJson(`${server.name}-mcp-config.json`, res.data)
    } catch (err: any) {
      toast.error(err.message || "Export failed")
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Export Config — {server.name}</h2>
          <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div className="rounded-md bg-secondary/40 border border-border px-3 py-2.5 text-xs text-muted-foreground leading-relaxed">
            Downloads this MCP server as a reusable config file. Plain values are included; re-enter any sensitive credentials after import.
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground">Cancel</button>
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="flex items-center gap-1.5 h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50"
            >
              {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Download
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Import Preview Panel ───────────────────────────────────────────

const ACTION_STYLES: Record<string, string> = {
  create: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  update: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  unchanged: "bg-secondary text-muted-foreground",
  invalid: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
}

function ImportPreviewPanel({ preview }: { preview: McpImportPreview }) {
  return (
    <div className="rounded-md border border-border bg-secondary/20 p-3 space-y-2.5 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`px-2 py-0.5 text-[11px] font-medium rounded ${ACTION_STYLES[preview.action]}`}>
          {preview.action.toUpperCase()}
        </span>
        {preview.name && <span className="font-mono text-sm font-medium">{preview.name}</span>}
        {preview.transport && (
          <span className="px-2 py-0.5 text-[10px] font-mono rounded border border-border text-muted-foreground">
            {TRANSPORT_LABELS[preview.transport as McpTransport] || preview.transport}
          </span>
        )}
        {(preview.bound_agents ?? 0) > 0 && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            {preview.bound_agents} agent{preview.bound_agents! > 1 ? "s" : ""} affected
          </span>
        )}
      </div>

      {preview.errors.length > 0 && (
        <div className="space-y-1">
          {preview.errors.map((e, i) => (
            <p key={i} className="text-xs text-red-600 dark:text-red-400 flex items-start gap-1">
              <X className="h-3 w-3 mt-0.5 shrink-0" />{e}
            </p>
          ))}
        </div>
      )}

      {preview.diffs.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Changes</p>
          <div className="rounded border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-secondary/60">
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground w-28">Field</th>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground">Before</th>
                  <th className="px-2 py-1 text-center font-medium text-muted-foreground w-4">
                    <ChevronRight className="h-3 w-3 mx-auto" />
                  </th>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground">After</th>
                </tr>
              </thead>
              <tbody>
                {preview.diffs.map((d) => (
                  <tr key={d.field} className="border-t border-border/50">
                    <td className="px-2 py-1 font-mono text-muted-foreground">{d.field}</td>
                    <td className="px-2 py-1 font-mono text-red-600 dark:text-red-400 max-w-[140px] truncate" title={formatDiffValue(d.before)}>
                      {formatDiffValue(d.before)}
                    </td>
                    <td className="px-1 py-1 text-muted-foreground/40 text-center">→</td>
                    <td className="px-2 py-1 font-mono text-emerald-600 dark:text-emerald-400 max-w-[140px] truncate" title={formatDiffValue(d.after)}>
                      {formatDiffValue(d.after)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {preview.action === "unchanged" && preview.errors.length === 0 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Check className="h-3 w-3 text-emerald-500" /> No changes — server config is already up to date.
        </p>
      )}
    </div>
  )
}

// ── Import Dialog ──────────────────────────────────────────────────

function ImportMcpConfigDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [configText, setConfigText] = useState("")
  const [fileName, setFileName] = useState("")
  const [preview, setPreview] = useState<McpImportPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const toast = useToast()

  const parseBundle = (): { ok: boolean; bundle?: McpConfigBundle; error?: string } => {
    if (!configText.trim()) return { ok: false, error: "Paste or upload a config file" }
    try {
      const parsed = JSON.parse(configText)
      return { ok: true, bundle: parsed }
    } catch {
      return { ok: false, error: "Invalid JSON" }
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    file.text().then(setConfigText).catch(() => toast.error("Failed to read file"))
  }

  const handlePreview = async () => {
    const { ok, bundle, error } = parseBundle()
    if (!ok) { toast.error(error!); return }
    setPreviewing(true); setPreview(null)
    try {
      const res = await api<{ data: McpImportPreview }>("/siclaw/mcp/import/preview", {
        method: "POST",
        body: { bundle },
      })
      setPreview(res.data)
    } catch (err: any) {
      toast.error(err.message || "Preview failed")
    } finally {
      setPreviewing(false)
    }
  }

  const handleApply = async () => {
    const { ok, bundle, error } = parseBundle()
    if (!ok) { toast.error(error!); return }
    setApplying(true)
    try {
      const res = await api<{ data: { created: number; updated: number; unchanged: number } }>("/siclaw/mcp/import", {
        method: "POST",
        body: { bundle },
      })
      const { created, updated, unchanged } = res.data
      const parts = [created && `${created} created`, updated && `${updated} updated`, unchanged && `${unchanged} unchanged`].filter(Boolean)
      toast.success(`Import complete: ${parts.join(", ")}`)
      onImported(); onClose()
    } catch (err: any) {
      toast.error(err.message || "Import failed")
    } finally {
      setApplying(false)
    }
  }

  const canApply = preview !== null && preview.errors.length === 0 && preview.action !== "invalid" && preview.action !== "unchanged"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Import MCP Config</h2>
          <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-muted-foreground">Config JSON</label>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-border text-muted-foreground hover:text-foreground"
              >
                <Upload className="h-3 w-3" /> {fileName || "Upload file"}
              </button>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={handleFileChange} />
            </div>
            <textarea
              value={configText}
              onChange={(e) => { setConfigText(e.target.value); setPreview(null) }}
              placeholder='{"mcpServer": {"name": "...", "transport": "stdio", ...}}'
              rows={6}
              className="w-full px-3 py-2 text-xs font-mono rounded-md border border-border bg-background resize-none"
            />
          </div>

          {preview && <ImportPreviewPanel preview={preview} />}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground">Cancel</button>
            <button
              onClick={handlePreview}
              disabled={previewing || !configText.trim()}
              className="h-8 px-4 text-sm rounded-md border border-border text-foreground disabled:opacity-50"
            >
              {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1" /> : null}Preview
            </button>
            <button
              onClick={handleApply}
              disabled={applying || !canApply}
              className="flex items-center gap-1.5 h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50"
            >
              {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Apply
            </button>
          </div>
        </div>
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
  const [isAdmin, setIsAdmin] = useState(false)
  const toast = useToast()
  const confirmDialog = useConfirm()

  const [showCreate, setShowCreate] = useState(false)
  const [editingServer, setEditingServer] = useState<McpServer | null>(null)
  const [exportTarget, setExportTarget] = useState<McpServer | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)

  const fetchServers = async () => {
    try {
      const res = await api<{ data: McpServer[] }>("/siclaw/mcp")
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
      await api("/siclaw/mcp", { method: "POST", body: data })
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
      await api(`/siclaw/mcp/${editingServer.id}`, { method: "PUT", body: data })
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
      await api(`/siclaw/mcp/${server.id}/toggle`, {
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

  const handleDelete = async (server: McpServer) => {
    if (!(await confirmDialog({
      title: "Delete MCP Server",
      message: `Delete "${server.name}"? This cannot be undone.`,
      destructive: true,
      confirmLabel: "Delete",
    }))) return
    try {
      await api(`/siclaw/mcp/${server.id}`, { method: "DELETE" })
      setServers((prev) => prev.filter((s) => s.id !== server.id))
      if (editingServer?.id === server.id) setEditingServer(null)
      toast.success("MCP server deleted — open chats will stop using it on the next message")
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
          <p className="text-sm text-muted-foreground">
            Manage Model Context Protocol server connections · changes apply to the next message in any open chat
          </p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowImport(true)}
              className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md border border-border text-foreground hover:bg-secondary"
            >
              <Upload className="h-3.5 w-3.5" /> Import Config
            </button>
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
                      {server.url || server.command || "—"}
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
                          onClick={() => setExportTarget(server)}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                          title="Export config"
                        >
                          <Download className="h-3.5 w-3.5" />
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

      {exportTarget && (
        <ExportMcpConfigDialog server={exportTarget} onClose={() => setExportTarget(null)} />
      )}
      {showImport && (
        <ImportMcpConfigDialog onClose={() => setShowImport(false)} onImported={fetchServers} />
      )}
    </div>
  )
}
