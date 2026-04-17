import { useState, useEffect, useRef } from "react"
import { BookOpen, Plus, Trash2, Upload, Loader2, Check, RotateCcw, Package, X, History } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { useConfirm } from "../components/confirm-dialog"

interface Repo {
  id: string; name: string; description: string | null
  max_versions: number; created_at: string
  version_count: number; active_version: number | null
}

interface Version {
  id: string; repo_id: string; version: number; message: string | null
  size_bytes: number; sha256: string | null; file_count: number | null
  source_repo: string | null; source_ref: string | null; source_commit: string | null
  built_at: string | null; schema_version: string | null
  status: string | null; error_message: string | null
  is_active: number; uploaded_by: string | null; activated_by: string | null
  activated_at: string | null; created_at: string
}

interface ReloadResult {
  boxes?: number
  results?: Array<{ ok: boolean; boxId?: string; error?: string }>
}

interface KnowledgeMutationResponse {
  reload?: { requested: boolean; ok?: boolean; result?: ReloadResult; error?: string }
}

interface PublishEvent {
  id: string; action: string; repo_name: string; version: number
  previous_version: number | null; status: string; requested_by: string | null
  created_at: string; reload_result_json?: unknown
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const chunkSize = 0x8000
  let binary = ""
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function shortSha(value?: string | null): string {
  return value ? value.slice(0, 12) : "-"
}

function formatDateTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : "-"
}

function reloadMessage(): string {
  return "Version saved and activated."
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function statusTone(status: string): string {
  if (status === "success") return "text-green-400"
  // reload issues are warnings, not failures — upload/activate itself succeeded
  if (status === "partial_failed" || status === "failed") return "text-yellow-400"
  return "text-muted-foreground"
}

export function KnowledgeAdmin() {
  const [repos, setRepos] = useState<Repo[]>([])
  const [events, setEvents] = useState<PublishEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null)
  const [versions, setVersions] = useState<Version[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({ name: "", description: "" })
  const [creating, setCreating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState("")
  const [showUpload, setShowUpload] = useState(false)
  const [pickedFile, setPickedFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const toast = useToast()
  const confirm = useConfirm()

  const loadRepos = async () => {
    try {
      const r = await api<{ data: Repo[] }>("/siclaw/admin/knowledge/repos")
      setRepos(r.data ?? [])
    } catch (err: any) { toast.error(err.message) }
    finally { setLoading(false) }
  }

  const loadEvents = async () => {
    try {
      const r = await api<{ data: PublishEvent[] }>("/siclaw/admin/knowledge/publish-events?limit=50")
      setEvents(r.data ?? [])
    } catch (err: any) { toast.error(err.message) }
  }

  useEffect(() => {
    loadRepos()
    loadEvents()
  }, [])

  const loadVersions = async (repoId: string) => {
    setVersionsLoading(true)
    try {
      const r = await api<{ data: Version[] }>(`/siclaw/admin/knowledge/repos/${repoId}/versions`)
      setVersions(r.data ?? [])
    } catch (err: any) { toast.error(err.message) }
    finally { setVersionsLoading(false) }
  }

  const toggleRepo = (repoId: string) => {
    if (expandedRepo === repoId) {
      setExpandedRepo(null)
    } else {
      setExpandedRepo(repoId)
      loadVersions(repoId)
    }
  }

  const handleCreateRepo = async () => {
    if (!createForm.name.trim()) return
    setCreating(true)
    try {
      await api("/siclaw/admin/knowledge/repos", { method: "POST", body: createForm })
      setShowCreate(false)
      setCreateForm({ name: "", description: "" })
      toast.success("Repository created")
      await loadRepos()
    } catch (err: any) { toast.error(err.message) }
    finally { setCreating(false) }
  }

  const handleDeleteRepo = async (repo: Repo) => {
    if (!(await confirm({ title: "Delete Repository", message: `Delete "${repo.name}" and all its versions? This cannot be undone.`, destructive: true, confirmLabel: "Delete" }))) return
    try {
      await api(`/siclaw/admin/knowledge/repos/${repo.id}`, { method: "DELETE" })
      if (expandedRepo === repo.id) setExpandedRepo(null)
      toast.success("Repository deleted")
      await loadRepos()
    } catch (err: any) { toast.error(err.message) }
  }

  const handleUpload = async (repoId: string, file: File) => {
    const ctl = new AbortController()
    uploadAbortRef.current = ctl
    setUploading(true)
    try {
      const buf = await file.arrayBuffer()
      const base64 = arrayBufferToBase64(buf)
      await api<KnowledgeMutationResponse>(`/siclaw/admin/knowledge/repos/${repoId}/versions`, {
        method: "POST",
        body: { message: uploadMessage.trim() || file.name, data: base64 },
        signal: ctl.signal,
      })
      closeUploadDialog()
      toast.success(reloadMessage())
      await loadRepos()
      await loadVersions(repoId)
      await loadEvents()
    } catch (err: any) {
      if (err.name === "AbortError") { toast.success("Upload cancelled."); return }
      toast.error(err.message)
    } finally {
      setUploading(false)
      uploadAbortRef.current = null
    }
  }

  const closeUploadDialog = () => {
    uploadAbortRef.current?.abort()
    setShowUpload(false)
    setUploadMessage("")
    setPickedFile(null)
  }

  const handleActivate = async (repoId: string, version: Version) => {
    try {
      await api(`/siclaw/admin/knowledge/repos/${repoId}/versions/${version.id}/activate`, { method: "POST" })
      toast.success(`v${version.version} activated.`)
      await loadRepos()
      await loadVersions(repoId)
      await loadEvents()
    } catch (err: any) { toast.error(err.message) }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-lg font-semibold">Knowledge</h1>
          <p className="text-sm text-muted-foreground">Manage knowledge repositories and versions</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90">
          <Plus className="h-3.5 w-3.5" /> New Repository
        </button>
      </div>

      {/* Create repo form */}
      {showCreate && (
        <div className="mx-6 my-4 p-4 rounded-lg border border-border bg-card space-y-3">
          <input value={createForm.name} onChange={e => setCreateForm({ ...createForm, name: e.target.value })}
            placeholder="Repository name (e.g. network, scheduler, system)"
            className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" autoFocus />
          <input value={createForm.description} onChange={e => setCreateForm({ ...createForm, description: e.target.value })}
            placeholder="Description (optional)"
            className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
          <div className="flex gap-2">
            <button onClick={handleCreateRepo} disabled={creating || !createForm.name.trim()}
              className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">
              {creating ? "..." : "Create"}
            </button>
            <button onClick={() => setShowCreate(false)} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground">Cancel</button>
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div className="mx-6 mt-4 rounded-lg border border-border/50">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border/50">
            <History className="h-4 w-4 text-muted-foreground" />
            <span className="text-[12px] font-semibold">Publish History ({events.length})</span>
          </div>
          <div className="divide-y divide-border/40 max-h-[300px] overflow-y-auto">
            {events.map(event => (
              <div key={event.id} className="grid grid-cols-[90px_1fr_90px_130px] items-center gap-3 px-4 py-2 text-[11px]">
                <span className="font-mono text-muted-foreground">{event.action}</span>
                <span className="truncate">
                  <span className="font-mono">{event.repo_name}</span>
                  <span className="text-muted-foreground"> v{event.version}</span>
                  {event.previous_version != null && (
                    <span className="text-muted-foreground"> from v{event.previous_version}</span>
                  )}
                </span>
                <span className={`font-mono ${statusTone(event.status)}`}>{event.status}</span>
                <span className="text-muted-foreground text-right">{formatDateTime(event.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {repos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <BookOpen className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No knowledge repositories</p>
            <p className="text-[11px] text-muted-foreground/60 mt-1">Create one and upload a tar.gz package</p>
          </div>
        ) : (
          <div className="px-6 py-4 space-y-2">
            {repos.map(repo => (
              <div key={repo.id} className="rounded-lg border border-border/50">
                {/* Repo header */}
                <div className="flex items-center gap-4 p-4 cursor-pointer hover:bg-secondary/20 transition-colors"
                  onClick={() => toggleRepo(repo.id)}>
                  <div className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0 bg-secondary text-muted-foreground">
                    <Package className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] font-semibold font-mono">{repo.name}</p>
                      {repo.active_version != null && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-500/20 text-green-400">
                          v{repo.active_version} active
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground">{repo.version_count} versions</span>
                    </div>
                    {repo.description && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{repo.description}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={e => { e.stopPropagation(); setExpandedRepo(repo.id); setShowUpload(true) }}
                      className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground" title="Upload version">
                      <Upload className="h-4 w-4" />
                    </button>
                    <button onClick={e => { e.stopPropagation(); handleDeleteRepo(repo) }}
                      className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400" title="Delete">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Version list (expanded) */}
                {expandedRepo === repo.id && (
                  <div className="border-t border-border/50 px-4 py-3">
                    {versionsLoading ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : versions.length === 0 ? (
                      <p className="text-[12px] text-muted-foreground/50 text-center py-4">No versions yet. Upload a tar.gz to get started.</p>
                    ) : (
                      <div className="space-y-1">
                        {versions.map(v => (
                          <div key={v.id} className={`px-3 py-2 rounded-md text-[12px] ${v.is_active ? "bg-green-500/5 border border-green-500/20" : "hover:bg-secondary/30"}`}>
                            <div className="flex items-center gap-3">
                              <span className="font-mono font-medium w-8 shrink-0">v{v.version}</span>
                              <span className="flex-1 text-muted-foreground truncate">{v.message || "-"}</span>
                              <span className="text-[10px] text-muted-foreground/60 shrink-0">{formatBytes(v.size_bytes)}</span>
                              <span className="text-[10px] text-muted-foreground/60 shrink-0 w-20 text-right">
                                {new Date(v.created_at).toLocaleDateString()}
                              </span>
                              {v.is_active ? (
                                <span className="flex items-center gap-1 text-green-400 shrink-0">
                                  <Check className="h-3 w-3" /> Active
                                </span>
                              ) : (
                                <button onClick={() => handleActivate(repo.id, v)}
                                  className="flex items-center gap-1 px-2 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
                                  title="Activate this version">
                                  <RotateCcw className="h-3 w-3" /> Rollback
                                </button>
                              )}
                            </div>
                            <div className="mt-1 grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-1 text-[10px] text-muted-foreground/60">
                              <span className="truncate">sha <span className="font-mono">{shortSha(v.sha256)}</span></span>
                              <span className="truncate">files <span className="font-mono">{v.file_count ?? "-"}</span></span>
                              <span className="truncate">src <span className="font-mono">{v.source_ref || "-"}</span></span>
                              <span className="truncate">commit <span className="font-mono">{shortSha(v.source_commit)}</span></span>
                              <span className="truncate col-span-2">repo <span className="font-mono">{v.source_repo || "-"}</span></span>
                              <span className="truncate">schema <span className="font-mono">{v.schema_version || "-"}</span></span>
                              <span className="truncate">built <span className="font-mono">{formatDateTime(v.built_at)}</span></span>
                              <span className="truncate col-span-2">activated <span className="font-mono">{formatDateTime(v.activated_at)}</span></span>
                              {v.error_message && <span className="truncate col-span-4 text-red-400">error {v.error_message}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upload dialog */}
      {showUpload && expandedRepo && (() => {
        const repo = repos.find(r => r.id === expandedRepo)
        const nextVersion = (repo?.version_count ?? 0) + 1
        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={closeUploadDialog} />
          <div className="relative bg-card rounded-xl shadow-xl border border-border p-5 w-96 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Upload Version</h3>
              <button onClick={closeUploadDialog} className="p-1 text-muted-foreground hover:text-foreground" title={uploading ? "Cancel upload" : "Close"}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <input value={uploadMessage} onChange={e => setUploadMessage(e.target.value)}
              placeholder="What changed? (optional)"
              disabled={uploading}
              className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background disabled:opacity-50" />
            <input ref={fileInputRef} type="file" accept=".tar.gz,.tgz,application/gzip,application/x-gzip,application/x-tar" className="hidden"
              onChange={e => {
                const file = e.target.files?.[0] ?? null
                setPickedFile(file)
                e.target.value = ""
              }} />
            {!pickedFile ? (
              <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
                className="w-full flex items-center justify-center gap-2 h-10 rounded-md border-2 border-dashed border-border hover:border-muted-foreground text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
                <Upload className="h-4 w-4" />
                Select tar.gz file
              </button>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-muted/30 border border-border text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="truncate">{pickedFile.name}</span>
                    <span className="text-muted-foreground shrink-0">{humanBytes(pickedFile.size)}</span>
                  </div>
                  <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
                    className="text-muted-foreground hover:text-foreground underline shrink-0 disabled:opacity-50">
                    Change
                  </button>
                </div>
                <button onClick={() => handleUpload(expandedRepo, pickedFile)} disabled={uploading}
                  className="w-full flex items-center justify-center gap-2 h-10 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {uploading ? "Uploading…" : `Upload as v${nextVersion}`}
                </button>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground/60 text-center">
              {pickedFile && !uploading
                ? `Will be activated automatically after upload. Max ${repo?.max_versions ?? 10} versions retained.`
                : `New version will be automatically activated. Max ${repo?.max_versions ?? 10} versions retained.`}
            </p>
          </div>
        </div>
        )
      })()}
    </div>
  )
}
