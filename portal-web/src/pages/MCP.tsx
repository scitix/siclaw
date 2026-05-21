import { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { Plus, Trash2, Loader2, Plug, Pencil, Power, Search, X, Download, Upload, Check } from "lucide-react"
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

function formatFieldValue(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "object") return JSON.stringify(v, null, 2)
  if (typeof v === "boolean") return v ? "true" : "false"
  return String(v)
}

type DiffLine = { type: "same" | "add" | "remove"; content: string }

function computeLineDiff(before: unknown, after: unknown): DiffLine[] {
  const bStr = formatFieldValue(before)
  const aStr = formatFieldValue(after)
  const bLines = bStr === "" ? [] : bStr.split("\n")
  const aLines = aStr === "" ? [] : aStr.split("\n")
  const m = bLines.length, n = aLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = bLines[i - 1] === aLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
  const result: DiffLine[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && bLines[i - 1] === aLines[j - 1]) {
      result.unshift({ type: "same", content: bLines[i - 1] })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "add", content: aLines[j - 1] })
      j--
    } else {
      result.unshift({ type: "remove", content: bLines[i - 1] })
      i--
    }
  }
  return result
}

const TRUNCATE_CHARS = 100

function DiffLineRow({ dl }: { dl: DiffLine }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = dl.content.length > TRUNCATE_CHARS
  const bg = dl.type === "add" ? "bg-emerald-50 dark:bg-emerald-950/25"
    : dl.type === "remove" ? "bg-red-50 dark:bg-red-950/25" : ""
  const textColor = dl.type === "add" ? "text-emerald-700 dark:text-emerald-400"
    : dl.type === "remove" ? "text-red-600 dark:text-red-400" : "text-foreground/60"
  const marker = dl.type === "add" ? "+" : dl.type === "remove" ? "-" : " "
  return (
    <div className={`flex items-baseline ${bg} min-w-0`}>
      <span className={`select-none px-2 py-0.5 shrink-0 font-bold ${textColor}`}>{marker}</span>
      <div
        className={`flex-1 py-0.5 min-w-0 font-mono text-xs ${expanded ? "whitespace-pre-wrap break-all" : "overflow-hidden"}`}
        style={!expanded ? {
          whiteSpace: "nowrap",
          WebkitMaskImage: isLong ? "linear-gradient(to right, black 82%, transparent 100%)" : undefined,
          maskImage: isLong ? "linear-gradient(to right, black 82%, transparent 100%)" : undefined,
        } : undefined}
      >
        <span className={textColor}>{dl.content || " "}</span>
      </div>
      {isLong && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="shrink-0 px-2 py-0.5 text-[10px] text-blue-500 hover:text-blue-700 hover:underline whitespace-nowrap"
        >
          view details
        </button>
      )}
    </div>
  )
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
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Changes</p>
          <div className="rounded border border-border overflow-hidden">
            {preview.diffs.map((d, di) => {
              const diffLines = computeLineDiff(d.before, d.after)
              const hasChanges = diffLines.some((l) => l.type !== "same")
              if (!hasChanges) return null
              const onlyRemoves = diffLines.every((l) => l.type !== "add")
              return (
                <div key={d.field} className={di > 0 ? "border-t border-border/50" : undefined}>
                  <div className="bg-secondary/60 px-2 py-1 text-[11px] font-mono text-muted-foreground select-none">
                    @@ <span className="text-foreground/80 font-semibold">{d.field}</span> @@
                  </div>
                  {diffLines.map((dl, li) => <DiffLineRow key={li} dl={dl} />)}
                  {onlyRemoves && (
                    <div className="flex items-baseline bg-secondary/10 font-mono text-xs text-muted-foreground/50">
                      <span className="select-none px-2 py-0.5">+</span>
                      <span className="py-0.5 italic">(will be unset)</span>
                    </div>
                  )}
                </div>
              )
            })}
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

const RESIZE_EDGE_PX = 6

// Collapse consecutive blank lines to at most one, and remove all trailing blank lines.
function compactJson(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  let blankRun = 0
  for (const line of lines) {
    if (line.trim() === "") {
      blankRun++
      if (blankRun === 1) out.push("")  // keep at most one blank line
    } else {
      blankRun = 0
      out.push(line)
    }
  }
  // Strip trailing blank lines
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop()
  return out.join("\n")
}

function mergeUploadedFiles(files: { name: string; text: string }[]): string {
  if (files.length === 0) return ""
  const all: unknown[] = []
  for (const f of files) {
    try {
      const parsed = JSON.parse(f.text)
      if (Array.isArray(parsed)) {
        all.push(...parsed.filter((x) => x && typeof x === "object"))
      } else if (parsed && typeof parsed === "object") {
        all.push(parsed)
      }
    } catch {
      // fall back to raw text so the user can see the problematic content
      return f.text
    }
  }
  if (all.length === 0) return ""
  if (all.length === 1) return JSON.stringify(all[0], null, 2)
  return JSON.stringify(all, null, 2)
}

function ImportMcpConfigDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [configText, setConfigText] = useState("")
  const [uploadedFiles, setUploadedFiles] = useState<{ name: string; text: string }[]>([])
  const [previews, setPreviews] = useState<McpImportPreview[]>([])
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const toast = useToast()

  // Width is always explicit; height starts as auto (content-driven) and only
  // becomes fixed once the user drags a resize handle.
  const [dialogWidth, setDialogWidth] = useState(() => Math.min(700, Math.round(window.innerWidth * 0.85)))
  const [fixedHeight, setFixedHeight] = useState<number | null>(null)
  const resizeDrag = useRef<{
    edge: string; startX: number; startY: number; startW: number; startH: number
  } | null>(null)
  // Tracks whether a resize drag moved the mouse; swallows the spurious backdrop
  // click that fires when mouseup lands outside the dialog.
  const didResizeDrag = useRef(false)

  const startResize = (e: React.MouseEvent, edge: string) => {
    e.preventDefault()
    e.stopPropagation()
    // Read actual rendered dimensions so the starting size is always correct,
    // regardless of whether height is auto or fixed.
    const el = dialogRef.current!
    resizeDrag.current = { edge, startX: e.clientX, startY: e.clientY, startW: el.offsetWidth, startH: el.offsetHeight }

    const onMove = (me: MouseEvent) => {
      const d = resizeDrag.current
      if (!d) return
      didResizeDrag.current = true
      const dx = me.clientX - d.startX
      const dy = me.clientY - d.startY
      if (d.edge.includes("e")) setDialogWidth(Math.max(480, d.startW + dx))
      else if (d.edge.includes("w")) setDialogWidth(Math.max(480, d.startW - dx))
      if (d.edge.includes("s")) setFixedHeight(Math.max(320, d.startH + dy))
      else if (d.edge.includes("n")) setFixedHeight(Math.max(320, d.startH - dy))
    }
    const onUp = () => {
      resizeDrag.current = null
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  const parseBundles = (): { ok: boolean; bundles?: McpConfigBundle[]; error?: string } => {
    if (!configText.trim()) return { ok: false, error: "Paste or upload a config file" }
    try {
      const parsed = JSON.parse(configText)
      if (Array.isArray(parsed)) {
        const bundles = parsed.filter((x) => x && typeof x === "object") as McpConfigBundle[]
        if (bundles.length === 0) return { ok: false, error: "Array contains no valid entries" }
        return { ok: true, bundles }
      }
      if (parsed && typeof parsed === "object") return { ok: true, bundles: [parsed] }
      return { ok: false, error: "Expected a JSON object or array" }
    } catch {
      return { ok: false, error: "Invalid JSON" }
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    e.target.value = ""
    Promise.all(files.map((f) => f.text().then((t) => ({ name: f.name, text: t }))))
      .then((newFiles) => {
        setUploadedFiles((prev) => {
          const updated = [...prev, ...newFiles]
          setConfigText(compactJson(mergeUploadedFiles(updated)))
          setPreviews([])
          return updated
        })
      })
      .catch(() => toast.error("Failed to read file"))
  }

  const removeFile = (idx: number) => {
    setUploadedFiles((prev) => {
      const updated = prev.filter((_, i) => i !== idx)
      setConfigText(updated.length === 0 ? "" : compactJson(mergeUploadedFiles(updated)))
      setPreviews([])
      return updated
    })
  }

  const handlePreview = async () => {
    const { ok, bundles, error } = parseBundles()
    if (!ok) { toast.error(error!); return }
    setPreviewing(true); setPreviews([])
    try {
      const res = await api<{ data: McpImportPreview[] }>("/siclaw/mcp/import/preview", {
        method: "POST",
        body: { bundles },
      })
      setPreviews(res.data)
    } catch (err: any) {
      toast.error(err.message || "Preview failed")
    } finally {
      setPreviewing(false)
    }
  }

  const handleApply = async () => {
    const { ok, bundles, error } = parseBundles()
    if (!ok) { toast.error(error!); return }
    setApplying(true)
    try {
      const res = await api<{ data: { created: number; updated: number; unchanged: number } }>("/siclaw/mcp/import", {
        method: "POST",
        body: { bundles },
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

  const canApply = previews.length > 0 &&
    previews.every((p) => p.errors.length === 0) &&
    previews.some((p) => p.action === "create" || p.action === "update")

  // Grow textarea to fit content; cap at 55 vh so the dialog doesn't overflow.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.55))}px`
  }, [configText])

  // Auto-scroll to preview panel once it appears in the DOM.
  useLayoutEffect(() => {
    if (previews.length > 0) previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [previews])

  const e = RESIZE_EDGE_PX

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => { if (didResizeDrag.current) { didResizeDrag.current = false; return } onClose() }}>
      <div
        ref={dialogRef}
        className="relative flex flex-col rounded-lg border border-border bg-card shadow-xl overflow-hidden"
        style={{
          width: dialogWidth,
          ...(fixedHeight !== null ? { height: fixedHeight } : {}),
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 32px)",
        }}
        onClick={(ev) => ev.stopPropagation()}
      >
        {/* ── Resize handles ── */}
        {/* edges */}
        <div style={{ position: "absolute", inset: `0 ${e}px auto ${e}px`, height: e, cursor: "ns-resize", zIndex: 10 }} onMouseDown={(ev) => startResize(ev, "n")} />
        <div style={{ position: "absolute", inset: `auto ${e}px 0 ${e}px`, height: e, cursor: "ns-resize", zIndex: 10 }} onMouseDown={(ev) => startResize(ev, "s")} />
        <div style={{ position: "absolute", inset: `${e}px auto ${e}px 0`, width: e, cursor: "ew-resize", zIndex: 10 }} onMouseDown={(ev) => startResize(ev, "w")} />
        <div style={{ position: "absolute", inset: `${e}px 0 ${e}px auto`, width: e, cursor: "ew-resize", zIndex: 10 }} onMouseDown={(ev) => startResize(ev, "e")} />
        {/* corners */}
        <div style={{ position: "absolute", top: 0, left: 0, width: e * 2, height: e * 2, cursor: "nwse-resize", zIndex: 11 }} onMouseDown={(ev) => startResize(ev, "nw")} />
        <div style={{ position: "absolute", top: 0, right: 0, width: e * 2, height: e * 2, cursor: "nesw-resize", zIndex: 11 }} onMouseDown={(ev) => startResize(ev, "ne")} />
        <div style={{ position: "absolute", bottom: 0, left: 0, width: e * 2, height: e * 2, cursor: "nesw-resize", zIndex: 11 }} onMouseDown={(ev) => startResize(ev, "sw")} />
        <div style={{ position: "absolute", bottom: 0, right: 0, width: e * 2, height: e * 2, cursor: "nwse-resize", zIndex: 11 }} onMouseDown={(ev) => startResize(ev, "se")} />

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold">Import MCP Config</h2>
          <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Scrollable body ──
            When height is auto (no user resize yet): give body an explicit max-height
            so content can scroll instead of overflowing the viewport.
            When height is fixed (user has resized): use flex-1 to fill remaining space. */}
        <div
          ref={bodyRef}
          className={`overflow-y-auto p-4 space-y-3 ${fixedHeight !== null ? "flex-1 min-h-0" : ""}`}
          style={fixedHeight === null ? { maxHeight: "calc(100vh - 180px)" } : undefined}
        >
          <div className="space-y-1.5">
            <div className="flex items-center flex-wrap gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Config JSON</label>
              {uploadedFiles.map((f, i) => (
                <span key={i} className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-border bg-secondary text-muted-foreground">
                  <Upload className="h-3 w-3 shrink-0" />
                  <span className="max-w-[200px] truncate">{f.name}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    className="ml-0.5 rounded hover:text-foreground"
                    aria-label={`Remove ${f.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-border text-muted-foreground hover:text-foreground"
              >
                <Upload className="h-3 w-3" />
                {uploadedFiles.length === 0 ? "Upload file" : "Add more files"}
              </button>
              <input ref={fileRef} type="file" accept=".json,application/json" multiple className="hidden" onChange={handleFileChange} />
            </div>
            <textarea
              ref={textareaRef}
              value={configText}
              onChange={(e) => { setConfigText(compactJson(e.target.value)); setPreviews([]) }}
              placeholder='{"mcpServer": {"name": "...", "transport": "stdio", ...}}  or  [{...}, {...}]'
              rows={1}
              className="w-full px-3 py-2 text-xs font-mono rounded-md border border-border bg-background resize-none overflow-hidden"
              style={{ minHeight: "2rem" }}
            />
          </div>

          {previews.length > 0 && (
            <div ref={previewRef} className="space-y-2">
              {previews.map((p, i) => <ImportPreviewPanel key={i} preview={p} />)}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button onClick={onClose} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground">Cancel</button>
          <button
            onClick={handlePreview}
            disabled={previewing || !configText.trim() || applying}
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
