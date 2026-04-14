import { useState, useEffect } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { ArrowLeft, Loader2, Save, Send, Undo2, CheckCircle, XCircle, Plus, Trash2, RotateCcw, ChevronDown, ChevronRight } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { SkillDiffView } from "../components/SimpleDiff"
import { useConfirm } from "../components/confirm-dialog"

interface Skill {
  id: string
  name: string
  description: string
  labels: string[] | null
  author_id: string
  status: "draft" | "pending_review" | "installed"
  version: number
  specs: string
  scripts: { name: string; content: string }[] | string | null
  created_at: string
  updated_at: string
}

interface SkillVersion {
  id: string
  skill_id: string
  version: number
  specs: string
  scripts: string
  diff: string | null
  commit_message: string
  author_id: string
  is_approved: number
  created_at: string
}

interface SkillReview {
  id: string
  skill_id: string
  version: number
  diff: string | null
  security_assessment: { risk_level: string; findings: { category: string; severity: string; pattern: string; match: string; scriptName: string; line: number }[]; summary: string } | null
  submitted_by: string
  reviewed_by: string | null
  decision: string | null
  reject_reason: string | null
  submitted_at: string
  reviewed_at: string | null
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  draft: { bg: "bg-yellow-500/20", text: "text-yellow-400", label: "Draft" },
  pending_review: { bg: "bg-blue-500/20", text: "text-blue-400", label: "Pending Review" },
  installed: { bg: "bg-green-500/20", text: "text-green-400", label: "Installed" },
}

const RISK_STYLES: Record<string, { bg: string; text: string }> = {
  critical: { bg: "bg-red-500/20", text: "text-red-400" },
  high: { bg: "bg-orange-500/20", text: "text-orange-400" },
  medium: { bg: "bg-yellow-500/20", text: "text-yellow-400" },
  low: { bg: "bg-blue-500/20", text: "text-blue-400" },
  safe: { bg: "bg-green-500/20", text: "text-green-400" },
}

function parseScripts(raw: Skill["scripts"]): { name: string; content: string }[] {
  if (!raw) return []
  if (typeof raw === "string") {
    try { return JSON.parse(raw) } catch { return [] }
  }
  return raw
}

export function SkillDetail() {
  const { id } = useParams<{ id: string }>()
  const isCreate = !id
  const navigate = useNavigate()
  const toast = useToast()
  const confirmDialog = useConfirm()

  const [loading, setLoading] = useState(!isCreate)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(isCreate)
  const [skill, setSkill] = useState<Skill | null>(null)

  // Form state
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [labelsStr, setLabelsStr] = useState("")
  const [specs, setSpecs] = useState("")
  const [scripts, setScripts] = useState<{ name: string; content: string }[]>([])
  const [commitMessage, setCommitMessage] = useState("")

  // Review & versions
  const [review, setReview] = useState<SkillReview | null>(null)
  const [versions, setVersions] = useState<SkillVersion[]>([])
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState("")

  // Load skill
  useEffect(() => {
    if (isCreate) return
    let cancelled = false
    async function load() {
      try {
        const s = await api<Skill>(`/siclaw/skills/${id}`)
        if (cancelled) return
        setSkill(s)
        setName(s.name)
        setDescription(s.description || "")
        setLabelsStr(Array.isArray(s.labels) ? s.labels.join(", ") : "")
        setSpecs(typeof s.specs === "string" ? s.specs : JSON.stringify(s.specs || ""))
        setScripts(parseScripts(s.scripts))
      } catch (err: any) {
        toast.error(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [id])

  // Load review
  useEffect(() => {
    if (isCreate || !id) return
    api<SkillReview>(`/siclaw/skills/${id}/review`).then(setReview).catch(() => setReview(null))
  }, [id, skill?.status])

  // Load versions
  useEffect(() => {
    if (isCreate || !id) return
    api<{ data: SkillVersion[] }>(`/siclaw/skills/${id}/versions`)
      .then(r => setVersions(Array.isArray(r.data) ? r.data : []))
      .catch(() => setVersions([]))
  }, [id, skill?.version])

  const handleCreate = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const labels = labelsStr.split(",").map(l => l.trim()).filter(Boolean)
      const created = await api<Skill>("/siclaw/skills", {
        method: "POST",
        body: { name: name.trim(), description: description.trim(), labels, specs, scripts },
      })
      toast.success("Skill created")
      navigate(`/skills/${created.id}`, { replace: true })
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async () => {
    if (!skill) return
    setSaving(true)
    try {
      const labels = labelsStr.split(",").map(l => l.trim()).filter(Boolean)
      const updated = await api<Skill>(`/siclaw/skills/${id}`, {
        method: "PUT",
        body: { name: name.trim(), description: description.trim(), labels, specs, scripts, commit_message: commitMessage || undefined },
      })
      setSkill(updated)
      setEditing(false)
      setCommitMessage("")
      toast.success("Skill saved")
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleSubmit = async () => {
    try {
      await api(`/siclaw/skills/${id}/submit`, { method: "POST" })
      const s = await api<Skill>(`/siclaw/skills/${id}`)
      setSkill(s)
      toast.success("Submitted for review")
    } catch (err: any) { toast.error(err.message) }
  }

  const handleWithdraw = async () => {
    try {
      await api(`/siclaw/skills/${id}/withdraw`, { method: "POST" })
      const s = await api<Skill>(`/siclaw/skills/${id}`)
      setSkill(s)
      toast.success("Review withdrawn")
    } catch (err: any) { toast.error(err.message) }
  }

  const handleApprove = async () => {
    try {
      await api(`/siclaw/skills/${id}/approve`, { method: "POST" })
      const s = await api<Skill>(`/siclaw/skills/${id}`)
      setSkill(s)
      setEditing(false)
      toast.success("Skill approved")
    } catch (err: any) { toast.error(err.message) }
  }

  const handleReject = async () => {
    try {
      await api(`/siclaw/skills/${id}/reject`, { method: "POST", body: { reason: rejectReason || undefined } })
      const s = await api<Skill>(`/siclaw/skills/${id}`)
      setSkill(s)
      setRejectReason("")
      toast.success("Skill rejected")
    } catch (err: any) { toast.error(err.message) }
  }

  const handleRollback = async (version: number) => {
    if (!(await confirmDialog({ title: "Rollback", message: `Roll back to version ${version}? Current content will be replaced and status will become draft.`, confirmLabel: "Rollback" }))) return
    try {
      await api(`/siclaw/skills/${id}/rollback`, { method: "POST", body: { version } })
      const s = await api<Skill>(`/siclaw/skills/${id}`)
      setSkill(s)
      setName(s.name)
      setDescription(s.description || "")
      setLabelsStr(Array.isArray(s.labels) ? s.labels.join(", ") : "")
      setSpecs(typeof s.specs === "string" ? s.specs : "")
      setScripts(parseScripts(s.scripts))
      setEditing(false)
      toast.success(`Rolled back to v${version}`)
    } catch (err: any) { toast.error(err.message) }
  }

  const addScript = () => setScripts([...scripts, { name: "", content: "" }])
  const removeScript = (i: number) => setScripts(scripts.filter((_, idx) => idx !== i))
  const updateScript = (i: number, field: "name" | "content", value: string) => {
    const next = [...scripts]
    next[i] = { ...next[i], [field]: value }
    setScripts(next)
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  }

  const st = STATUS_STYLES[skill?.status || "draft"] || STATUS_STYLES.draft
  const disabled = !editing

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/skills")} className="p-1 rounded hover:bg-secondary text-muted-foreground">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">{isCreate ? "New Skill" : skill?.name || ""}</h1>
              {!isCreate && (
                <>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${st.bg} ${st.text}`}>{st.label}</span>
                  <span className="text-[10px] text-muted-foreground">v{skill?.version}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isCreate && (
            <button onClick={handleCreate} disabled={saving || !name.trim()} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Create
            </button>
          )}
          {!isCreate && skill?.status === "draft" && !editing && (
            <>
              <button onClick={() => setEditing(true)} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md border border-border hover:bg-secondary">Edit</button>
              <button onClick={handleSubmit} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90">
                <Send className="h-3.5 w-3.5" /> Submit for Review
              </button>
            </>
          )}
          {!isCreate && skill?.status === "draft" && editing && (
            <>
              <button onClick={() => setEditing(false)} className="h-8 px-3 text-sm rounded-md border border-border text-muted-foreground">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
              </button>
            </>
          )}
          {!isCreate && skill?.status === "pending_review" && (
            <>
              <button onClick={handleWithdraw} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md border border-border text-muted-foreground hover:bg-secondary">
                <Undo2 className="h-3.5 w-3.5" /> Withdraw
              </button>
              <button onClick={handleApprove} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-green-600 text-white hover:opacity-90">
                <CheckCircle className="h-3.5 w-3.5" /> Approve
              </button>
              <button onClick={handleReject} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-red-600 text-white hover:opacity-90">
                <XCircle className="h-3.5 w-3.5" /> Reject
              </button>
            </>
          )}
          {!isCreate && skill?.status === "installed" && (
            <button onClick={() => setEditing(true)} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md border border-border hover:bg-secondary">Edit</button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-8">
          {/* Basic Info */}
          <section className="space-y-4">
            <h3 className="text-[14px] font-semibold border-b border-border pb-2">Basic Information</h3>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-[12px] text-muted-foreground">Name *</label>
                <input value={name} onChange={e => setName(e.target.value)} disabled={disabled && !isCreate}
                  className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-ring" />
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] text-muted-foreground">Description</label>
                <textarea value={description} onChange={e => setDescription(e.target.value)} disabled={disabled && !isCreate} rows={2}
                  className="w-full px-3 py-2 text-[13px] rounded-md border border-border bg-background resize-none disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-ring" />
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] text-muted-foreground">Labels (comma-separated)</label>
                <input value={labelsStr} onChange={e => setLabelsStr(e.target.value)} disabled={disabled && !isCreate}
                  placeholder="kubernetes, network, diagnostic"
                  className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-ring" />
              </div>
              {editing && !isCreate && (
                <div className="space-y-1.5">
                  <label className="text-[12px] text-muted-foreground">Commit Message</label>
                  <input value={commitMessage} onChange={e => setCommitMessage(e.target.value)}
                    placeholder="Describe your changes..."
                    className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
              )}
            </div>
          </section>

          {/* Specs */}
          <section className="space-y-4">
            <h3 className="text-[14px] font-semibold border-b border-border pb-2">SKILL.md (Specs)</h3>
            <textarea value={specs} onChange={e => setSpecs(e.target.value)} disabled={disabled && !isCreate} rows={12}
              className="w-full px-3 py-2 text-[13px] font-mono rounded-md border border-border bg-background resize-y disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-ring" />
          </section>

          {/* Scripts */}
          <section className="space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <h3 className="text-[14px] font-semibold">Scripts</h3>
              {(editing || isCreate) && (
                <button onClick={addScript} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
                  <Plus className="h-3 w-3" /> Add Script
                </button>
              )}
            </div>
            {scripts.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No scripts</p>
            ) : (
              <div className="space-y-4">
                {scripts.map((s, i) => (
                  <div key={i} className="border border-border rounded-md p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <input value={s.name} onChange={e => updateScript(i, "name", e.target.value)} disabled={disabled && !isCreate}
                        placeholder="script-name.sh"
                        className="flex-1 h-7 px-2 text-[12px] font-mono rounded border border-border bg-background disabled:opacity-50" />
                      {(editing || isCreate) && (
                        <button onClick={() => removeScript(i)} className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-red-400">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    <textarea value={s.content} onChange={e => updateScript(i, "content", e.target.value)} disabled={disabled && !isCreate} rows={8}
                      className="w-full px-2 py-1.5 text-[12px] font-mono rounded border border-border bg-background resize-y disabled:opacity-50" />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Review Section */}
          {review && (
            <section className="space-y-4">
              <h3 className="text-[14px] font-semibold border-b border-border pb-2">Review</h3>
              {review.security_assessment && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-muted-foreground">Security Risk:</span>
                    {(() => {
                      const rs = RISK_STYLES[review.security_assessment.risk_level] || RISK_STYLES.safe
                      return <span className={`px-1.5 py-0.5 rounded text-[10px] ${rs.bg} ${rs.text}`}>{review.security_assessment.risk_level}</span>
                    })()}
                  </div>
                  <p className="text-[12px] text-muted-foreground">{review.security_assessment.summary}</p>
                  {review.security_assessment.findings.length > 0 && (
                    <div className="border border-border rounded-md overflow-hidden">
                      <table className="w-full text-[11px]">
                        <thead className="bg-secondary/50">
                          <tr>
                            <th className="px-2 py-1 text-left font-medium text-muted-foreground">Severity</th>
                            <th className="px-2 py-1 text-left font-medium text-muted-foreground">Category</th>
                            <th className="px-2 py-1 text-left font-medium text-muted-foreground">Pattern</th>
                            <th className="px-2 py-1 text-left font-medium text-muted-foreground">File</th>
                            <th className="px-2 py-1 text-left font-medium text-muted-foreground">Line</th>
                          </tr>
                        </thead>
                        <tbody>
                          {review.security_assessment.findings.map((f, i) => (
                            <tr key={i} className="border-t border-border/50">
                              <td className="px-2 py-1">
                                <span className={`px-1 py-0.5 rounded text-[9px] ${(RISK_STYLES[f.severity] || RISK_STYLES.low).bg} ${(RISK_STYLES[f.severity] || RISK_STYLES.low).text}`}>
                                  {f.severity}
                                </span>
                              </td>
                              <td className="px-2 py-1 text-muted-foreground">{f.category}</td>
                              <td className="px-2 py-1 font-mono">{f.match}</td>
                              <td className="px-2 py-1 font-mono">{f.scriptName}</td>
                              <td className="px-2 py-1">{f.line}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
              {/* Diff display — collapsible per-file with context folding */}
              {review.diff && (
                <div className="space-y-2">
                  <h4 className="text-[12px] font-medium text-muted-foreground">Changes</h4>
                  <SkillDiffView diff={review.diff} />
                </div>
              )}
              {review.decision === "rejected" && review.reject_reason && (
                <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20">
                  <p className="text-[12px] text-red-400">Rejected: {review.reject_reason}</p>
                </div>
              )}
              {skill?.status === "pending_review" && (
                <div className="space-y-1.5">
                  <label className="text-[12px] text-muted-foreground">Reject Reason (optional)</label>
                  <input value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                    placeholder="Reason for rejection..."
                    className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
              )}
            </section>
          )}

          {/* Version History */}
          {!isCreate && versions.length > 0 && (
            <section className="space-y-4">
              <button onClick={() => setVersionsOpen(!versionsOpen)}
                className="flex items-center gap-2 text-[14px] font-semibold border-b border-border pb-2 w-full text-left">
                {versionsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                Version History ({versions.length})
              </button>
              {versionsOpen && (
                <div className="space-y-1">
                  {versions.map(v => (
                    <div key={v.id} className="flex items-center justify-between p-2 rounded border border-border/50 text-[12px]">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium">v{v.version}</span>
                        {v.is_approved ? (
                          <span className="px-1 py-0.5 rounded text-[9px] bg-green-500/20 text-green-400">approved</span>
                        ) : (
                          <span className="px-1 py-0.5 rounded text-[9px] bg-secondary text-muted-foreground">draft</span>
                        )}
                        <span className="text-muted-foreground">{v.commit_message || "No message"}</span>
                        <span className="text-muted-foreground/60">{new Date(v.created_at).toLocaleDateString()}</span>
                      </div>
                      {skill?.status !== "pending_review" && (
                        <button onClick={() => handleRollback(v.version)} title="Rollback to this version"
                          className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground">
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
