import { useState, useEffect, useRef, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { Upload, History, RotateCcw, Loader2, AlertTriangle, ArrowLeft, FileArchive, CheckCircle, Plus, Minus, RefreshCw } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { useConfirm } from "../components/confirm-dialog"

// ── Types ────────────────────────────────────────────────────────

interface DiffEntry {
  name: string
  description?: string
  bound_agents?: string[]
}

interface PreviewResult {
  added: DiffEntry[]
  updated: DiffEntry[]
  deleted: DiffEntry[]
  unchanged: DiffEntry[]
  total_added: number
  total_updated: number
  total_deleted: number
  total_unchanged: number
}

interface ImportVersion {
  version: number
  comment: string | null
  skill_count: number
  added: number
  updated: number
  deleted: number
  created_at: string
}

type Tab = "import" | "history"

// ── Component ────────────────────────────────────────────────────

export function SkillImport() {
  const navigate = useNavigate()
  const toast = useToast()
  const confirmDialog = useConfirm()

  const [tab, setTab] = useState<Tab>("import")

  // ── Import tab state ─────────────────────────────────────────
  const [file, setFile] = useState<File | null>(null)
  const [comment, setComment] = useState("")
  const [dragOver, setDragOver] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [importing, setImporting] = useState(false)
  const [initializing, setInitializing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── History tab state ────────────────────────────────────────
  const [history, setHistory] = useState<ImportVersion[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [rollingBack, setRollingBack] = useState<number | null>(null)

  const loadHistory = useCallback(() => {
    setHistoryLoading(true)
    api<{ data: ImportVersion[] }>("/siclaw/skills/import/history")
      .then(r => setHistory(Array.isArray(r.data) ? r.data : []))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false))
  }, [])

  useEffect(() => {
    if (tab === "history") loadHistory()
  }, [tab, loadHistory])

  // ── File selection ───────────────────────────────────────────

  const handleFileSelect = (f: File | undefined) => {
    if (!f) return
    if (!f.name.endsWith(".zip")) {
      toast.error("Only .zip files are accepted")
      return
    }
    setFile(f)
    setPreview(null)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    handleFileSelect(e.dataTransfer.files[0])
  }

  // ── Preview (dry run) ────────────────────────────────────────

  const handlePreview = async () => {
    if (!file) return
    setPreviewing(true)
    setPreview(null)
    try {
      const buffer = await file.arrayBuffer()
      const token = localStorage.getItem("token")
      const res = await fetch("/api/v1/siclaw/skills/import?dry_run=true", {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          ...(token ? { "Authorization": `Bearer ${token}` } : {}),
        },
        body: buffer,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const result: PreviewResult = await res.json()
      setPreview(result)
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setPreviewing(false)
    }
  }

  // ── Confirm import ───────────────────────────────────────────

  const handleImport = async () => {
    if (!file || !preview) return
    const ok = await confirmDialog({
      title: "Confirm Import",
      message: `Import skill pack? This will apply ${preview.total_added} added, ${preview.total_updated} updated, and ${preview.total_deleted} deleted skills.`,
      confirmLabel: "Import",
    })
    if (!ok) return
    setImporting(true)
    try {
      const buffer = await file.arrayBuffer()
      const token = localStorage.getItem("token")
      const qs = comment ? `?comment=${encodeURIComponent(comment)}` : ""
      const res = await fetch(`/api/v1/siclaw/skills/import${qs}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          ...(token ? { "Authorization": `Bearer ${token}` } : {}),
        },
        body: buffer,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      toast.success("Skill pack imported successfully")
      setFile(null)
      setPreview(null)
      setComment("")
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setImporting(false)
    }
  }

  // ── Initialize from image ────────────────────────────────────

  const handleInit = async () => {
    const ok = await confirmDialog({
      title: "Initialize from Image",
      message: "This will load builtin skills from the current Docker image. Existing builtin skills may be overwritten.",
      confirmLabel: "Initialize",
    })
    if (!ok) return
    setInitializing(true)
    try {
      await api("/siclaw/skills/import/init", {
        method: "POST",
        body: { comment: comment || "Initialize from image" },
      })
      toast.success("Initialized builtin skills from image")
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setInitializing(false)
    }
  }

  // ── Rollback ─────────────────────────────────────────────────

  const handleRollback = async (version: number) => {
    const ok = await confirmDialog({
      title: "Rollback to Version",
      message: `Roll back to version ${version}? Current skills will be replaced with that snapshot.`,
      confirmLabel: "Rollback",
      destructive: true,
    })
    if (!ok) return
    setRollingBack(version)
    try {
      await api("/siclaw/skills/import/rollback", {
        method: "POST",
        body: { version },
      })
      toast.success(`Rolled back to version ${version}`)
      loadHistory()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setRollingBack(null)
    }
  }

  // ── Render ───────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-lg font-semibold">Skill Import</h1>
          <p className="text-sm text-muted-foreground">Import and manage builtin skill packs</p>
        </div>
        <button
          onClick={() => navigate("/skills")}
          className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Skills
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-6 pt-4 pb-0">
        <button
          onClick={() => setTab("import")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium transition-all border ${
            tab === "import"
              ? "bg-foreground text-background border-foreground"
              : "bg-transparent text-muted-foreground border-transparent hover:bg-secondary"
          }`}
        >
          <Upload className="h-3.5 w-3.5" /> Import
        </button>
        <button
          onClick={() => setTab("history")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium transition-all border ${
            tab === "history"
              ? "bg-foreground text-background border-foreground"
              : "bg-transparent text-muted-foreground border-transparent hover:bg-secondary"
          }`}
        >
          <History className="h-3.5 w-3.5" /> History
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {tab === "import" ? (
          <div className="max-w-2xl space-y-5">
            {/* File drop zone */}
            <div>
              <label className="block text-sm font-medium mb-2">Skill Pack (.zip)</label>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`flex flex-col items-center justify-center gap-3 h-36 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
                  dragOver
                    ? "border-primary bg-primary/5"
                    : file
                    ? "border-green-500/50 bg-green-500/5"
                    : "border-border hover:border-border/80 hover:bg-secondary/30"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip"
                  className="hidden"
                  onChange={e => handleFileSelect(e.target.files?.[0])}
                />
                {file ? (
                  <>
                    <FileArchive className="h-8 w-8 text-green-400" />
                    <div className="text-center">
                      <p className="text-sm font-medium text-green-400">{file.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{(file.size / 1024).toFixed(1)} KB — click to replace</p>
                    </div>
                  </>
                ) : (
                  <>
                    <Upload className="h-8 w-8 text-muted-foreground/50" />
                    <div className="text-center">
                      <p className="text-sm text-muted-foreground">Drag & drop a .zip file or click to select</p>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Comment field */}
            <div>
              <label className="block text-sm font-medium mb-1">Comment <span className="text-muted-foreground font-normal">(optional)</span></label>
              <input
                value={comment}
                onChange={e => setComment(e.target.value)}
                placeholder="Describe this import..."
                className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background"
              />
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={handlePreview}
                disabled={!file || previewing}
                className="flex items-center gap-1.5 h-8 px-4 text-sm rounded-md border border-border text-foreground hover:bg-secondary/50 disabled:opacity-50"
              >
                {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                Preview
              </button>

              {preview && (
                <button
                  onClick={handleImport}
                  disabled={importing}
                  className="flex items-center gap-1.5 h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
                  Confirm Import
                </button>
              )}

              <button
                onClick={handleInit}
                disabled={initializing}
                className="flex items-center gap-1.5 h-8 px-4 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {initializing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Initialize from Image
              </button>
            </div>

            {/* Preview results */}
            {preview && (
              <div className="space-y-4">
                {/* Summary counts */}
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium bg-green-500/15 text-green-400">
                    <Plus className="h-3 w-3" /> {preview.total_added} added
                  </span>
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium bg-yellow-500/15 text-yellow-400">
                    <RefreshCw className="h-3 w-3" /> {preview.total_updated} updated
                  </span>
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium bg-red-500/15 text-red-400">
                    <Minus className="h-3 w-3" /> {preview.total_deleted} deleted
                  </span>
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium bg-secondary text-muted-foreground">
                    {preview.total_unchanged} unchanged
                  </span>
                </div>

                {/* Added */}
                {preview.added.length > 0 && (
                  <DiffSection title="Added" color="green" items={preview.added} />
                )}

                {/* Updated */}
                {preview.updated.length > 0 && (
                  <DiffSection title="Updated" color="yellow" items={preview.updated} />
                )}

                {/* Deleted */}
                {preview.deleted.length > 0 && (
                  <DiffSection title="Deleted" color="red" items={preview.deleted} showAgentWarning />
                )}

                {/* Unchanged */}
                {preview.unchanged.length > 0 && (
                  <DiffSection title="Unchanged" color="gray" items={preview.unchanged} />
                )}
              </div>
            )}
          </div>
        ) : (
          /* ── History tab ─────────────────────────────────── */
          historyLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20">
              <History className="h-12 w-12 text-muted-foreground/20 mb-3" />
              <p className="text-sm text-muted-foreground">No import history yet</p>
            </div>
          ) : (
            <div className="max-w-2xl space-y-2">
              {history.map(v => (
                <div key={v.version} className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:bg-secondary/30">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-md bg-secondary flex items-center justify-center shrink-0">
                      <span className="text-xs font-mono font-semibold text-muted-foreground">v{v.version}</span>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium truncate">{v.comment || "No comment"}</p>
                        <span className="text-[10px] text-muted-foreground">{v.skill_count} skills</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {v.added > 0 && (
                          <span className="text-[10px] text-green-400">+{v.added} added</span>
                        )}
                        {v.updated > 0 && (
                          <span className="text-[10px] text-yellow-400">~{v.updated} updated</span>
                        )}
                        {v.deleted > 0 && (
                          <span className="text-[10px] text-red-400">-{v.deleted} deleted</span>
                        )}
                        <span className="text-[10px] text-muted-foreground">{new Date(v.created_at).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRollback(v.version)}
                    disabled={rollingBack === v.version}
                    title={`Roll back to version ${v.version}`}
                    className="flex items-center gap-1.5 h-7 px-2.5 text-[12px] rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-border/80 disabled:opacity-50 shrink-0 ml-3"
                  >
                    {rollingBack === v.version ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                    Rollback
                  </button>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}

// ── DiffSection ───────────────────────────────────────────────────

const COLOR_MAP = {
  green: { border: "border-green-500/30", bg: "bg-green-500/5", header: "text-green-400", dot: "bg-green-400" },
  yellow: { border: "border-yellow-500/30", bg: "bg-yellow-500/5", header: "text-yellow-400", dot: "bg-yellow-400" },
  red: { border: "border-red-500/30", bg: "bg-red-500/5", header: "text-red-400", dot: "bg-red-400" },
  gray: { border: "border-border/50", bg: "bg-secondary/20", header: "text-muted-foreground", dot: "bg-muted-foreground/40" },
}

function DiffSection({
  title, color, items, showAgentWarning,
}: {
  title: string
  color: keyof typeof COLOR_MAP
  items: DiffEntry[]
  showAgentWarning?: boolean
}) {
  const c = COLOR_MAP[color]
  return (
    <div className={`rounded-lg border ${c.border} ${c.bg} overflow-hidden`}>
      <div className="px-3 py-2 flex items-center gap-2 border-b border-inherit">
        <span className={`w-2 h-2 rounded-full ${c.dot} shrink-0`} />
        <span className={`text-[12px] font-semibold ${c.header}`}>{title}</span>
        <span className="text-[11px] text-muted-foreground ml-auto">{items.length}</span>
      </div>
      <div className="divide-y divide-border/30">
        {items.map(item => (
          <div key={item.name} className="px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-mono font-medium">{item.name}</span>
              {showAgentWarning && item.bound_agents && item.bound_agents.length > 0 && (
                <span className="flex items-center gap-1 text-[10px] text-amber-400">
                  <AlertTriangle className="h-3 w-3" />
                  {item.bound_agents.length} agent{item.bound_agents.length !== 1 ? "s" : ""} affected
                </span>
              )}
            </div>
            {item.description && (
              <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{item.description}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
