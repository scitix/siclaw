import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { ArrowLeft, Loader2, Save, Send, Undo2, CheckCircle, XCircle, Plus, Trash2, RotateCcw, Terminal, FileCode, X, History, ShieldAlert, Code2 } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { SkillDiffView } from "../components/SimpleDiff"
import { useConfirm } from "../components/confirm-dialog"

// ── Types ───────────────────────────────────────────────────────

interface Skill {
  id: string; name: string; description: string; labels: string[] | null
  author_id: string; status: "draft" | "pending_review" | "installed"
  version: number; specs: string
  scripts: { name: string; content: string }[] | string | null
  created_at: string; updated_at: string
}

interface SkillVersion {
  id: string; version: number; commit_message: string; author_id: string
  is_approved: number; created_at: string
}

interface SkillReview {
  id: string; version: number; diff: string | null
  security_assessment: { risk_level: string; findings: { category: string; severity: string; pattern: string; match: string; scriptName: string; line: number }[]; summary: string } | null
  submitted_by: string; reviewed_by: string | null
  decision: string | null; reject_reason: string | null
  submitted_at: string; reviewed_at: string | null
}

// ── Constants ───────────────────────────────────────────────────

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

const DEFAULT_SPEC = `---
name: new-skill
description: Describe what this skill does
---

# New Skill

## Purpose
Explain the problem this skill solves.

## Parameters
- target: The resource to analyze (required)

## Procedure
1. Step one
2. Step two
`

function parseScripts(raw: Skill["scripts"]): { name: string; content: string }[] {
  if (!raw) return []
  if (typeof raw === "string") { try { return JSON.parse(raw) } catch { return [] } }
  return raw
}

// ── Component ───────────────────────────────────────────────────

export function SkillDetail() {
  const { id } = useParams<{ id: string }>()
  const isCreate = !id
  const navigate = useNavigate()
  const toast = useToast()
  const confirmDialog = useConfirm()

  const [loading, setLoading] = useState(!isCreate)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(isCreate)

  // Skill data
  const [skill, setSkill] = useState<Skill | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [labels, setLabels] = useState<string[]>([])
  const [specs, setSpecs] = useState(DEFAULT_SPEC)
  const [scripts, setScripts] = useState<{ name: string; content: string }[]>([])
  const [commitMessage, setCommitMessage] = useState("")

  // Active script editor
  const [activeScriptIdx, setActiveScriptIdx] = useState<number | null>(null)

  // Review & versions
  const [review, setReview] = useState<SkillReview | null>(null)
  const [versions, setVersions] = useState<SkillVersion[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [rejectReason, setRejectReason] = useState("")

  // Label input
  const labelInputRef = useRef<HTMLInputElement>(null)

  // ── Data loading ──────────────────────────────────────────────

  const loadSkill = useCallback(async () => {
    if (isCreate) return
    try {
      const s = await api<Skill>(`/siclaw/skills/${id}`)
      setSkill(s)
      setName(s.name)
      setDescription(s.description || "")
      setLabels(Array.isArray(s.labels) ? s.labels : [])
      setSpecs(typeof s.specs === "string" ? s.specs : JSON.stringify(s.specs || ""))
      setScripts(parseScripts(s.scripts))
    } catch (err: any) { toast.error(err.message) }
    finally { setLoading(false) }
  }, [id, isCreate])

  useEffect(() => { loadSkill() }, [loadSkill])

  useEffect(() => {
    if (isCreate || !id) return
    api<SkillReview>(`/siclaw/skills/${id}/review`).then(setReview).catch(() => setReview(null))
  }, [id, skill?.status])

  useEffect(() => {
    if (isCreate || !id) return
    api<{ data: SkillVersion[] }>(`/siclaw/skills/${id}/versions`)
      .then(r => setVersions(Array.isArray(r.data) ? r.data : []))
      .catch(() => setVersions([]))
  }, [id, skill?.version])

  // ── Dirty detection ───────────────────────────────────────────

  const isDirty = useMemo(() => {
    if (!skill) return isCreate && name.trim().length > 0
    return name !== skill.name ||
      description !== (skill.description || "") ||
      specs !== (typeof skill.specs === "string" ? skill.specs : "") ||
      JSON.stringify(scripts) !== JSON.stringify(parseScripts(skill.scripts)) ||
      JSON.stringify(labels) !== JSON.stringify(Array.isArray(skill.labels) ? skill.labels : [])
  }, [skill, name, description, specs, scripts, labels, isCreate])

  // ── Actions ───────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const created = await api<Skill>("/siclaw/skills", {
        method: "POST", body: { name: name.trim(), description: description.trim(), labels, specs, scripts },
      })
      toast.success("Skill created")
      navigate(`/skills/${created.id}`, { replace: true })
    } catch (err: any) { toast.error(err.message) }
    finally { setSaving(false) }
  }

  const handleSave = async () => {
    if (!skill) return
    setSaving(true)
    try {
      const updated = await api<Skill>(`/siclaw/skills/${id}`, {
        method: "PUT", body: { name: name.trim(), description: description.trim(), labels, specs, scripts, commit_message: commitMessage || undefined },
      })
      setSkill(updated)
      setEditing(false)
      setCommitMessage("")
      toast.success("Saved")
    } catch (err: any) { toast.error(err.message) }
    finally { setSaving(false) }
  }

  const handleSubmit = async () => {
    try {
      await api(`/siclaw/skills/${id}/submit`, { method: "POST" })
      await loadSkill()
      toast.success("Submitted for review")
    } catch (err: any) { toast.error(err.message) }
  }

  const handleWithdraw = async () => {
    try {
      await api(`/siclaw/skills/${id}/withdraw`, { method: "POST" })
      await loadSkill()
      toast.success("Withdrawn")
    } catch (err: any) { toast.error(err.message) }
  }

  const handleApprove = async () => {
    try {
      await api(`/siclaw/skills/${id}/approve`, { method: "POST" })
      await loadSkill()
      toast.success("Approved")
    } catch (err: any) { toast.error(err.message) }
  }

  const handleReject = async () => {
    try {
      await api(`/siclaw/skills/${id}/reject`, { method: "POST", body: { reason: rejectReason || undefined } })
      await loadSkill()
      setRejectReason("")
      toast.success("Rejected")
    } catch (err: any) { toast.error(err.message) }
  }

  const handleRollback = async (version: number) => {
    if (!(await confirmDialog({ title: "Rollback", message: `Roll back to v${version}? Status will become draft.`, confirmLabel: "Rollback" }))) return
    try {
      await api(`/siclaw/skills/${id}/rollback`, { method: "POST", body: { version } })
      await loadSkill()
      setEditing(false)
      toast.success(`Rolled back to v${version}`)
    } catch (err: any) { toast.error(err.message) }
  }

  // ── Script management ─────────────────────────────────────────

  const addScript = (type: "shell" | "python") => {
    const ext = type === "python" ? ".py" : ".sh"
    const template = type === "python" ? '#!/usr/bin/env python3\n\nprint("Hello")' : '#!/bin/bash\n\necho "Hello"'
    const newScript = { name: `script${ext}`, content: template }
    setScripts([...scripts, newScript])
    setActiveScriptIdx(scripts.length)
  }

  const removeScript = (i: number) => {
    setScripts(scripts.filter((_, idx) => idx !== i))
    if (activeScriptIdx === i) setActiveScriptIdx(null)
    else if (activeScriptIdx !== null && activeScriptIdx > i) setActiveScriptIdx(activeScriptIdx - 1)
  }

  const updateScript = (i: number, field: "name" | "content", value: string) => {
    const next = [...scripts]
    next[i] = { ...next[i], [field]: value }
    setScripts(next)
  }

  // ── Label management ──────────────────────────────────────────

  const handleLabelKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault()
      const val = (e.target as HTMLInputElement).value.trim()
      if (val && !labels.includes(val)) setLabels([...labels, val])
      ;(e.target as HTMLInputElement).value = ""
    }
  }

  const removeLabel = (lbl: string) => setLabels(labels.filter(l => l !== lbl))

  // ── Render ────────────────────────────────────────────────────

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  const st = STATUS_STYLES[skill?.status || "draft"] || STATUS_STYLES.draft
  const disabled = !editing && !isCreate

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ──────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/skills")} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground">
            <ArrowLeft className="h-4 w-4" />
          </button>
          {isCreate ? (
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Skill name..."
              className="text-lg font-semibold bg-transparent border-none outline-none w-64" autoFocus />
          ) : editing ? (
            <div className="flex items-center gap-2">
              <input value={name} onChange={e => setName(e.target.value)}
                className="text-lg font-semibold bg-transparent border-none outline-none w-64 hover:bg-secondary/30 rounded px-1 -ml-1" />
              {isDirty && <span className="text-amber-400 text-lg leading-none" title="Unsaved changes">●</span>}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">{skill?.name}</h1>
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${st.bg} ${st.text}`}>{st.label}</span>
              <span className="text-[10px] text-muted-foreground">v{skill?.version}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {/* Version history toggle */}
          {!isCreate && (
            <button onClick={() => setShowHistory(!showHistory)} title="Version History"
              className={`p-2 rounded-md transition-colors ${showHistory ? "text-blue-400 bg-blue-500/10" : "text-muted-foreground hover:bg-secondary"}`}>
              <History className="h-4 w-4" />
            </button>
          )}

          <div className="h-5 w-px bg-border mx-1" />

          {/* Context actions */}
          {isCreate && (
            <button onClick={handleCreate} disabled={saving || !name.trim()} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Create
            </button>
          )}
          {!isCreate && skill?.status === "draft" && !editing && (
            <>
              <button onClick={() => setEditing(true)} className="h-8 px-3 text-sm rounded-md border border-border hover:bg-secondary">Edit</button>
              <button onClick={handleSubmit} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground">
                <Send className="h-3.5 w-3.5" /> Submit
              </button>
            </>
          )}
          {!isCreate && skill?.status === "draft" && editing && (
            <>
              <button onClick={() => { setEditing(false); loadSkill() }} className="h-8 px-3 text-sm rounded-md border border-border text-muted-foreground">Cancel</button>
              <button onClick={handleSave} disabled={saving || !isDirty} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
              </button>
            </>
          )}
          {!isCreate && skill?.status === "pending_review" && (
            <>
              <button onClick={handleWithdraw} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md border border-border hover:bg-secondary">
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
            <button onClick={() => setEditing(true)} className="h-8 px-3 text-sm rounded-md border border-border hover:bg-secondary">Edit</button>
          )}
        </div>
      </header>

      {/* ── Status banners ──────────────────────────────────── */}
      {skill?.status === "pending_review" && (
        <div className="px-6 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2 shrink-0">
          <ShieldAlert className="h-4 w-4 text-amber-400" />
          <span className="text-[12px] text-amber-300">Pending review — editing is locked until approved or withdrawn.</span>
        </div>
      )}
      {review?.decision === "rejected" && review.reject_reason && skill?.status === "draft" && (
        <div className="px-6 py-2 bg-red-500/10 border-b border-red-500/20 flex items-center gap-2 shrink-0">
          <XCircle className="h-4 w-4 text-red-400" />
          <span className="text-[12px] text-red-300">Rejected: {review.reject_reason}</span>
        </div>
      )}

      {/* ── Main content: split layout ──────────────────────── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* LEFT PANEL: metadata + specs */}
        <div className={`flex flex-col border-r border-border ${scripts.length > 0 || editing || isCreate ? "w-[65%]" : "w-full"}`}>
          <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-5">

            {/* Description */}
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5 block">Description</label>
              {editing || isCreate ? (
                <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
                  className="w-full px-3 py-2 text-[13px] rounded-md border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring" />
              ) : (
                <p className="text-[13px] text-muted-foreground px-1">{description || "No description"}</p>
              )}
            </div>

            {/* Labels */}
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5 block">Labels</label>
              <div className="flex flex-wrap gap-1.5 items-center">
                {labels.map(lbl => (
                  <span key={lbl} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border border-border bg-secondary text-secondary-foreground">
                    {lbl}
                    {(editing || isCreate) && (
                      <button onClick={() => removeLabel(lbl)} className="p-0.5 rounded hover:bg-background text-muted-foreground hover:text-foreground">
                        <X className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </span>
                ))}
                {(editing || isCreate) && (
                  <input ref={labelInputRef} type="text" placeholder="+ Add label" onKeyDown={handleLabelKeyDown}
                    className="text-[11px] px-1.5 py-0.5 border border-transparent rounded bg-transparent text-muted-foreground outline-none w-20 focus:border-border focus:bg-background placeholder:text-muted-foreground/40" />
                )}
                {labels.length === 0 && !editing && !isCreate && (
                  <span className="text-[11px] text-muted-foreground/50">No labels</span>
                )}
              </div>
            </div>

            {/* Commit message (when editing) */}
            {editing && !isCreate && (
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5 block">Commit Message</label>
                <input value={commitMessage} onChange={e => setCommitMessage(e.target.value)} placeholder="Describe your changes..."
                  className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring" />
              </div>
            )}

            {/* Specs (SKILL.md) */}
            <div className="flex-1 flex flex-col min-h-[300px]">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5 block">
                Skill Specification (SKILL.md)
              </label>
              <textarea
                value={specs} onChange={e => {
                  if (disabled) return
                  const newSpecs = e.target.value
                  setSpecs(newSpecs)
                  // Sync frontmatter name → header name
                  const fmMatch = newSpecs.match(/^---\n([\s\S]*?)\n---/)
                  const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+)$/m)
                  if (nameMatch) setName(nameMatch[1].trim())
                }}
                readOnly={disabled} spellCheck={false}
                className={`flex-1 px-4 py-3 text-[12px] font-mono leading-relaxed rounded-md border border-border resize-none transition-colors ${
                  disabled ? "bg-secondary/30 text-foreground" : "bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                }`}
              />
            </div>
          </div>
        </div>

        {/* RIGHT PANEL: scripts */}
        {(scripts.length > 0 || editing || isCreate) && (
          <div className="flex-1 flex flex-col min-w-0">
            {/* Scripts header */}
            <div className="px-4 py-3 flex items-center justify-between border-b border-border shrink-0">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Scripts ({scripts.length})
              </span>
              {(editing || isCreate) && (
                <div className="flex items-center gap-1">
                  <button onClick={() => addScript("shell")} title="Add Shell Script"
                    className="flex items-center gap-1 px-2 py-1 text-[11px] rounded hover:bg-secondary text-muted-foreground">
                    <Terminal className="h-3 w-3 text-green-400" /> .sh
                  </button>
                  <button onClick={() => addScript("python")} title="Add Python Script"
                    className="flex items-center gap-1 px-2 py-1 text-[11px] rounded hover:bg-secondary text-muted-foreground">
                    <FileCode className="h-3 w-3 text-blue-400" /> .py
                  </button>
                </div>
              )}
            </div>

            {/* Script list / editor */}
            <div className="flex-1 overflow-y-auto">
              {scripts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center">
                  <Code2 className="h-8 w-8 text-muted-foreground/20 mb-2" />
                  <p className="text-[12px] text-muted-foreground/50">No scripts yet</p>
                </div>
              ) : activeScriptIdx !== null && scripts[activeScriptIdx] ? (
                /* Script editor view */
                <div className="flex flex-col h-full">
                  <div className="flex items-center gap-2 px-4 py-2 border-b border-border/50 shrink-0">
                    <button onClick={() => setActiveScriptIdx(null)} className="text-[11px] text-muted-foreground hover:text-foreground">
                      ← Back
                    </button>
                    <span className="text-[11px] text-muted-foreground">·</span>
                    {editing || isCreate ? (
                      <input value={scripts[activeScriptIdx].name}
                        onChange={e => updateScript(activeScriptIdx, "name", e.target.value)}
                        className="text-[12px] font-mono bg-transparent border-none outline-none flex-1" />
                    ) : (
                      <span className="text-[12px] font-mono">{scripts[activeScriptIdx].name}</span>
                    )}
                  </div>
                  <textarea
                    value={scripts[activeScriptIdx].content}
                    onChange={e => updateScript(activeScriptIdx, "content", e.target.value)}
                    readOnly={disabled} spellCheck={false}
                    className={`flex-1 px-4 py-3 text-[12px] font-mono leading-relaxed resize-none ${
                      disabled ? "bg-secondary/30" : "bg-background focus:outline-none"
                    }`}
                  />
                </div>
              ) : (
                /* Script list view */
                <div className="p-3 space-y-1.5">
                  {scripts.map((s, i) => {
                    const isPy = s.name.endsWith(".py")
                    return (
                      <div key={i} onClick={() => setActiveScriptIdx(i)}
                        className="flex items-center justify-between p-2.5 rounded-md border border-border/50 hover:border-border hover:bg-secondary/20 cursor-pointer group transition-colors">
                        <div className="flex items-center gap-2.5">
                          <div className={`w-7 h-7 rounded flex items-center justify-center shrink-0 ${isPy ? "bg-blue-500/10 text-blue-400" : "bg-green-500/10 text-green-400"}`}>
                            {isPy ? <FileCode className="h-3.5 w-3.5" /> : <Terminal className="h-3.5 w-3.5" />}
                          </div>
                          <div>
                            <p className="text-[12px] font-medium font-mono">{s.name}</p>
                            <p className="text-[10px] text-muted-foreground">{isPy ? "Python" : "Bash"} · {s.content.length}B</p>
                          </div>
                        </div>
                        {(editing || isCreate) && (
                          <button onClick={e => { e.stopPropagation(); removeScript(i) }} title="Delete"
                            className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-all">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* VERSION HISTORY PANEL (slide-in) */}
        {showHistory && (
          <div className="w-[280px] border-l border-border flex flex-col shrink-0">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">History</span>
              <button onClick={() => setShowHistory(false)} className="p-1 rounded hover:bg-secondary text-muted-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1">
              {versions.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/50 text-center py-8">No versions yet</p>
              ) : versions.map(v => (
                <div key={v.id} className="p-2.5 rounded-md border border-border/50 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-mono font-medium">v{v.version}</span>
                    {v.is_approved ? (
                      <span className="px-1 py-0.5 rounded text-[9px] bg-green-500/20 text-green-400">approved</span>
                    ) : (
                      <span className="px-1 py-0.5 rounded text-[9px] bg-secondary text-muted-foreground">draft</span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">{v.commit_message || "No message"}</p>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground/60">{new Date(v.created_at).toLocaleDateString()}</span>
                    {skill?.status !== "pending_review" && (
                      <button onClick={() => handleRollback(v.version)} title="Rollback"
                        className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground">
                        <RotateCcw className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Review panel (below main content when pending) ──── */}
      {review && review.security_assessment && (
        <div className="border-t border-border shrink-0 max-h-[40%] overflow-y-auto">
          <div className="px-6 py-4 space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-[12px] font-medium text-muted-foreground">Security Assessment</span>
              {(() => {
                const rs = RISK_STYLES[review.security_assessment.risk_level] || RISK_STYLES.safe
                return <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${rs.bg} ${rs.text}`}>{review.security_assessment.risk_level}</span>
              })()}
              <span className="text-[11px] text-muted-foreground">{review.security_assessment.summary}</span>
            </div>

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
                          <span className={`px-1 py-0.5 rounded text-[9px] ${(RISK_STYLES[f.severity] || RISK_STYLES.low).bg} ${(RISK_STYLES[f.severity] || RISK_STYLES.low).text}`}>{f.severity}</span>
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

            {/* Diff */}
            {review.diff && (
              <div className="space-y-2">
                <span className="text-[12px] font-medium text-muted-foreground">Changes</span>
                <SkillDiffView diff={review.diff} />
              </div>
            )}

            {/* Reject reason input (for reviewers) */}
            {skill?.status === "pending_review" && (
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1 block">Reject Reason</label>
                <input value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="Optional reason..."
                  className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring" />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
