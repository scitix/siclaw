import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { ArrowLeft, Loader2, Save, Send, Undo2, Plus, Trash2, RotateCcw, Terminal, FileCode, X, History, ShieldAlert, Code2, FileUp } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { SkillDiffView } from "../components/SimpleDiff"
import { useConfirm } from "../components/confirm-dialog"
import Editor from "react-simple-code-editor"
import Prism from "prismjs"
import "prismjs/components/prism-python"
import "prismjs/components/prism-bash"
import "prismjs/themes/prism-dark.css"

// ── Types ───────────────────────────────────────────────────────

interface Skill {
  id: string; name: string; description: string; labels: string[] | null
  author_id: string; status: "draft" | "pending_review" | "installed"
  version: number; specs: string
  scripts: { name: string; content: string }[] | string | null
  created_at: string; updated_at: string
  is_builtin?: boolean; overlay_of?: string | null
}

interface SkillVersion {
  id: string; version: number; specs: string; scripts: string
  commit_message: string; author_id: string
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

  // Versions
  const [versions, setVersions] = useState<SkillVersion[]>([])
  const [showHistory, setShowHistory] = useState(false)

  // Label input + autocomplete
  const labelInputRef = useRef<HTMLInputElement>(null)
  const [labelQuery, setLabelQuery] = useState("")
  const [allLabels, setAllLabels] = useState<string[]>([])
  const [showLabelSuggestions, setShowLabelSuggestions] = useState(false)

  useEffect(() => {
    api<{ labels: string[] }>("/siclaw/skills/labels")
      .then(r => setAllLabels(r.labels ?? []))
      .catch(() => {})
  }, [])

  // ── Data loading ──────────────────────────────────────────────

  const loadSkill = useCallback(async () => {
    if (isCreate) return
    try {
      const s = await api<Skill>(`/siclaw/skills/${id}`)
      setSkill(s)
      setName(s.name)
      setDescription(s.description || "")
      setLabels(Array.isArray(s.labels) ? s.labels : [])
      // specs may be double-JSON-encoded (JSON.stringify was called on the string before DB insert)
      let specsVal = s.specs || ""
      if (typeof specsVal === "string" && specsVal.startsWith('"')) {
        try { specsVal = JSON.parse(specsVal) } catch { /* keep as-is */ }
      }
      setSpecs(specsVal)
      setScripts(parseScripts(s.scripts))
      setEditing(false)
    } catch (err: any) { toast.error(err.message) }
    finally { setLoading(false) }
  }, [id, isCreate])

  useEffect(() => { loadSkill() }, [loadSkill])

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
      // If the backend created an overlay (response has overlay_of set), redirect to the new overlay
      if (updated.overlay_of) {
        toast.success("Overlay created from builtin skill")
        navigate(`/skills/${updated.id}`)
        return
      }
      setSkill(updated)
      setEditing(false)
      setCommitMessage("")
      toast.success("Saved")
    } catch (err: any) { toast.error(err.message) }
    finally { setSaving(false) }
  }

  // Submit with diff preview
  const [showSubmitDialog, setShowSubmitDialog] = useState(false)
  const [submitDiff, setSubmitDiff] = useState<any>(null)
  const [submitLoading, setSubmitLoading] = useState(false)

  const handleSubmitClick = async () => {
    setSubmitLoading(true)
    try {
      const versionsRes = await api<{ data: SkillVersion[] }>(`/siclaw/skills/${id}/versions`)
      const approvedVersions = (versionsRes.data || []).filter(v => v.is_approved)
      const lastApproved = approvedVersions.length > 0 ? approvedVersions[0] : null

      // Decode baseline — may be double-encoded from old DB data
      let baselineSpecs = ""
      let baselineScripts: { name: string; content: string }[] = []
      if (lastApproved) {
        const vDetail = await api<SkillVersion>(`/siclaw/skills/${id}/versions/${lastApproved.version}`)
        baselineSpecs = vDetail.specs || ""
        if (baselineSpecs.startsWith('"')) { try { baselineSpecs = JSON.parse(baselineSpecs) } catch {} }
        try {
          const raw = vDetail.scripts || "[]"
          baselineScripts = typeof raw === "string" ? JSON.parse(raw) : raw
        } catch { baselineScripts = [] }
      }

      setSubmitDiff({
        specs_diff: { old: baselineSpecs || null, new: specs },
        scripts_diff: { old: JSON.stringify(baselineScripts), new: JSON.stringify(scripts) },
      })
      setShowSubmitDialog(true)
    } catch {
      setSubmitDiff(null)
      setShowSubmitDialog(true)
    } finally {
      setSubmitLoading(false)
    }
  }

  const [submitConfirming, setSubmitConfirming] = useState(false)

  const handleSubmitConfirm = async () => {
    setSubmitConfirming(true)
    try {
      await api(`/siclaw/skills/${id}/submit`, { method: "POST", body: { comment: commitMessage || undefined } })
      setShowSubmitDialog(false)
      setCommitMessage("")
      toast.success("Submitted for review")
      await loadSkill()
    } catch (err: any) {
      toast.error(err.message)
      setShowSubmitDialog(false)
    } finally {
      setSubmitConfirming(false)
    }
  }

  const handleWithdraw = async () => {
    try {
      await api(`/siclaw/skills/${id}/withdraw`, { method: "POST" })
      await loadSkill()
      toast.success("Withdrawn")
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

  const [showAddMenu, setShowAddMenu] = useState(false)
  const [showNameDialog, setShowNameDialog] = useState(false)
  const [newScriptType, setNewScriptType] = useState<"shell" | "python">("shell")
  const [newScriptName, setNewScriptName] = useState("")
  const fileInputRef2 = useRef<HTMLInputElement>(null)

  const initiateAddScript = (type: "shell" | "python") => {
    setNewScriptType(type)
    setNewScriptName(type === "python" ? "script.py" : "script.sh")
    setShowAddMenu(false)
    setShowNameDialog(true)
  }

  const confirmAddScript = () => {
    const trimmed = newScriptName.trim()
    if (!trimmed) return
    if (scripts.some(s => s.name === trimmed)) {
      toast.error(`Script "${trimmed}" already exists`)
      return
    }
    const template = newScriptType === "python" ? '#!/usr/bin/env python3\n\nprint("Hello")' : '#!/bin/bash\n\necho "Hello"'
    setScripts([...scripts, { name: trimmed, content: template }])
    setActiveScriptIdx(scripts.length)
    setShowNameDialog(false)
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (scripts.some(s => s.name === file.name)) {
      toast.error(`Script "${file.name}" already exists`)
      e.target.value = ""
      return
    }
    const reader = new FileReader()
    reader.onload = (event) => {
      const content = event.target?.result as string
      setScripts([...scripts, { name: file.name, content }])
      setActiveScriptIdx(scripts.length)
    }
    reader.readAsText(file)
    e.target.value = ""
  }

  const removeScript = (i: number) => {
    setScripts(scripts.filter((_, idx) => idx !== i))
    if (activeScriptIdx === i) setActiveScriptIdx(null)
    else if (activeScriptIdx !== null && activeScriptIdx > i) setActiveScriptIdx(activeScriptIdx - 1)
  }

  const updateScriptContent = (i: number, content: string) => {
    const next = [...scripts]
    next[i] = { ...next[i], content }
    setScripts(next)
  }

  // ── Label management ──────────────────────────────────────────

  const addLabel = (val: string) => {
    const trimmed = val.trim()
    if (trimmed && !labels.includes(trimmed)) setLabels([...labels, trimmed])
    setLabelQuery("")
    // Keep dropdown open so user can continue adding labels
    labelInputRef.current?.focus()
  }

  const handleLabelKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault()
      addLabel(labelQuery)
    }
    if (e.key === "Escape") setShowLabelSuggestions(false)
  }

  const labelSuggestions = useMemo(() => {
    if (!labelQuery.trim()) return allLabels.filter(l => !labels.includes(l))
    const q = labelQuery.toLowerCase()
    return allLabels.filter(l => l.toLowerCase().includes(q) && !labels.includes(l))
  }, [labelQuery, allLabels, labels])

  const removeLabel = (lbl: string) => setLabels(labels.filter(l => l !== lbl))

  /** Sync header name → frontmatter `name:` field in specs */
  const syncNameToFrontmatter = (newName: string) => {
    setSpecs(prev => {
      const fmMatch = prev.match(/^(---\n)([\s\S]*?)(\n---)/)
      if (!fmMatch) return prev
      const updated = fmMatch[2].replace(/^name:\s*.+$/m, `name: ${newName}`)
      return `${fmMatch[1]}${updated}${fmMatch[3]}${prev.slice(fmMatch[0].length)}`
    })
  }

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
            <input value={name} onChange={e => { setName(e.target.value); syncNameToFrontmatter(e.target.value) }} placeholder="Skill name..."
              className="text-lg font-semibold bg-transparent border-none outline-none w-64" autoFocus />
          ) : editing ? (
            <div className="flex items-center gap-2">
              <input value={name} onChange={e => { setName(e.target.value); syncNameToFrontmatter(e.target.value) }}
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
          {!isCreate && !editing && (skill?.status === "draft" || skill?.status === "installed") && (
            <>
              <button onClick={() => setEditing(true)} className="h-8 px-3 text-sm rounded-md border border-border hover:bg-secondary">Edit</button>
              {skill?.status === "draft" && (
                <button onClick={handleSubmitClick} disabled={submitLoading}
                  className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">
                  {submitLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Submit for Review
                </button>
              )}
            </>
          )}
          {!isCreate && editing && (
            <>
              <button onClick={() => { setEditing(false); loadSkill() }} className="h-8 px-3 text-sm rounded-md border border-border text-muted-foreground">Discard</button>
              <button onClick={handleSave} disabled={saving || !isDirty} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
              </button>
            </>
          )}
          {!isCreate && skill?.status === "pending_review" && (
            <button onClick={handleWithdraw} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md border border-border hover:bg-secondary">
              <Undo2 className="h-3.5 w-3.5" /> Withdraw
            </button>
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
      {!!skill?.is_builtin && (
        <div className="mx-6 mt-4 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm text-purple-300 shrink-0">
          This is a builtin skill. Editing will create a personal overlay — the original remains unchanged.
        </div>
      )}
      {skill?.overlay_of && (
        <div className="mx-6 mt-4 p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-sm text-cyan-300 shrink-0">
          This is an overlay of a builtin skill. Deleting it will revert to the original builtin version.
        </div>
      )}

      {/* ── Main content: split layout ──────────────────────── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* LEFT PANEL: metadata + specs */}
        <div className={`flex flex-col border-r border-border ${scripts.length > 0 || editing || isCreate ? "w-[65%]" : "w-full"}`}>
          <div className="flex-1 overflow-y-auto flex flex-col">
            {/* Metadata bar: labels + description (compact, always visible) */}
            <div className="px-6 py-3 border-b border-border/50 space-y-2.5 shrink-0">
              {/* Labels row */}
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
                  <div className="relative">
                    <input ref={labelInputRef} type="text" placeholder="+ Add label"
                      value={labelQuery}
                      onChange={e => { setLabelQuery(e.target.value); setShowLabelSuggestions(true) }}
                      onFocus={() => setShowLabelSuggestions(true)}
                      onBlur={() => setTimeout(() => setShowLabelSuggestions(false), 150)}
                      onKeyDown={handleLabelKeyDown}
                      className="text-[11px] px-1.5 py-0.5 border border-transparent rounded bg-transparent text-muted-foreground outline-none w-24 focus:border-border focus:bg-background placeholder:text-muted-foreground/40" />
                    {showLabelSuggestions && labelSuggestions.length > 0 && (
                      <div className="absolute left-0 top-full mt-1 w-40 max-h-32 overflow-y-auto bg-card border border-border rounded-md shadow-lg z-20 py-0.5">
                        {labelSuggestions.slice(0, 10).map(s => (
                          <button key={s} onMouseDown={e => { e.preventDefault(); addLabel(s) }}
                            className="w-full text-left px-2.5 py-1 text-[11px] hover:bg-secondary/50 transition-colors truncate">
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {labels.length === 0 && !editing && !isCreate && (
                  <span className="text-[11px] text-muted-foreground/40">No labels</span>
                )}
              </div>

              {/* Commit message: only in edit mode (not create) */}
              {editing && !isCreate && (
                <input value={commitMessage} onChange={e => setCommitMessage(e.target.value)} placeholder="Commit message (optional)..."
                  className="w-full h-7 px-2 text-[12px] rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring" />
              )}
            </div>

            {/* Specs (SKILL.md) — fills remaining space */}
            <div className="flex-1 flex flex-col min-h-0">
              <textarea
                value={specs} onChange={e => {
                  if (disabled) return
                  const newSpecs = e.target.value
                  setSpecs(newSpecs)
                  // Sync frontmatter name → header name
                  const fmMatch = newSpecs.match(/^---\n([\s\S]*?)\n---/)
                  const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+)$/m)
                  if (nameMatch) setName(nameMatch[1].trim())
                  // Sync frontmatter description
                  const descMatch = fmMatch?.[1]?.match(/^description:\s*(.+)$/m)
                  if (descMatch) setDescription(descMatch[1].trim())
                }}
                readOnly={disabled} spellCheck={false}
                className={`flex-1 px-5 py-4 text-[12px] font-mono leading-relaxed resize-none border-none outline-none ${
                  disabled ? "bg-transparent text-foreground" : "bg-background focus:ring-0"
                }`}
              />
            </div>
          </div>
        </div>

        {/* RIGHT PANEL: scripts */}
        {(scripts.length > 0 || editing || isCreate) && (
          <div className="flex-1 flex flex-col min-w-0 relative">
            {/* Scripts header */}
            <div className="px-4 py-3 flex items-center justify-between border-b border-border shrink-0">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Scripts ({scripts.length})
              </span>
              {(editing || isCreate) && (
                <div className="flex items-center gap-1">
                  <button onClick={() => fileInputRef2.current?.click()} title="Upload Script"
                    className="p-1.5 rounded hover:bg-secondary text-muted-foreground">
                    <FileUp className="h-3.5 w-3.5" />
                  </button>
                  <input type="file" ref={fileInputRef2} className="hidden" accept=".sh,.py,.txt" onChange={handleFileUpload} />
                  <div className="relative">
                    <button onClick={() => setShowAddMenu(!showAddMenu)} title="New Script"
                      className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground">
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                    {showAddMenu && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setShowAddMenu(false)} />
                        <div className="absolute right-0 top-full mt-1 w-36 bg-card border border-border rounded-lg shadow-lg z-20 py-1">
                          <button onClick={() => initiateAddScript("shell")}
                            className="w-full flex items-center gap-2 px-3 py-2 text-[12px] hover:bg-secondary/50 transition-colors">
                            <Terminal className="h-3.5 w-3.5 text-green-400" /> Shell Script
                          </button>
                          <button onClick={() => initiateAddScript("python")}
                            className="w-full flex items-center gap-2 px-3 py-2 text-[12px] hover:bg-secondary/50 transition-colors">
                            <FileCode className="h-3.5 w-3.5 text-blue-400" /> Python Script
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Script list */}
            <div className="flex-1 overflow-y-auto">
              {scripts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center">
                  <div className="p-3 bg-secondary/30 rounded-full mb-3">
                    <Code2 className="h-6 w-6 text-muted-foreground/30" />
                  </div>
                  <p className="text-[12px] text-muted-foreground/50">No scripts yet</p>
                  <p className="text-[10px] text-muted-foreground/30 mt-1">Add or upload a script to get started</p>
                </div>
              ) : (
                <div className="p-3 space-y-1.5">
                  {scripts.map((s, i) => {
                    const isPy = s.name.endsWith(".py")
                    return (
                      <div key={i} onClick={() => setActiveScriptIdx(i)}
                        className="flex items-center justify-between p-3 rounded-md border border-border/50 hover:border-border hover:bg-secondary/20 cursor-pointer group transition-colors">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${isPy ? "bg-blue-500/10 text-blue-400" : "bg-green-500/10 text-green-400"}`}>
                            {isPy ? <FileCode className="h-4 w-4" /> : <Terminal className="h-4 w-4" />}
                          </div>
                          <div>
                            <p className="text-[13px] font-medium font-mono group-hover:text-foreground transition-colors">{s.name}</p>
                            <p className="text-[10px] text-muted-foreground font-mono">{isPy ? "Python" : "Bash"} · {s.content.length}B</p>
                          </div>
                        </div>
                        {(editing || isCreate) && (
                          <button onClick={e => { e.stopPropagation(); removeScript(i) }} title="Delete"
                            className="p-1.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-all">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* OVERLAY EDITOR — full-screen dark editor when a script is active */}
            {activeScriptIdx !== null && scripts[activeScriptIdx] && (
              <div className="absolute inset-0 z-40 bg-[#1e1e1e] flex flex-col">
                {/* Editor header */}
                <div className="flex items-center justify-between px-4 py-3 bg-[#252526] border-b border-[#1e1e1e]">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded flex items-center justify-center ${
                      scripts[activeScriptIdx].name.endsWith(".py") ? "bg-[#37373d] text-yellow-400" : "bg-[#37373d] text-green-400"
                    }`}>
                      {scripts[activeScriptIdx].name.endsWith(".py") ? <FileCode className="h-4 w-4" /> : <Terminal className="h-4 w-4" />}
                    </div>
                    <span className="text-sm font-medium text-gray-200 font-mono">
                      {scripts[activeScriptIdx].name}
                    </span>
                  </div>
                  <button onClick={() => setActiveScriptIdx(null)} title="Close Editor"
                    className="p-1.5 text-gray-400 hover:text-white hover:bg-[#333] rounded transition-colors">
                    <X className="h-5 w-5" />
                  </button>
                </div>

                {/* Editor content with syntax highlighting */}
                <div className="flex-1 overflow-auto">
                  <Editor
                    value={scripts[activeScriptIdx].content}
                    onValueChange={code => {
                      if (disabled) return
                      updateScriptContent(activeScriptIdx, code)
                    }}
                    highlight={code => {
                      const isPy = scripts[activeScriptIdx].name.endsWith(".py")
                      const grammar = isPy ? Prism.languages.python : Prism.languages.bash
                      if (!grammar) return code
                      return Prism.highlight(code, grammar, isPy ? "python" : "bash")
                    }}
                    readOnly={disabled}
                    padding={24}
                    style={{
                      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", monospace',
                      fontSize: 13,
                      lineHeight: 1.6,
                      backgroundColor: "#1e1e1e",
                      color: "#d4d4d4",
                      minHeight: "100%",
                    }}
                    textareaClassName="outline-none"
                  />
                </div>
              </div>
            )}
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
                    {v.commit_message?.startsWith("Rollback to") && (
                      <span className="px-1 py-0.5 rounded text-[9px] bg-orange-500/20 text-orange-400">rollback</span>
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

      {/* ── New Script Name Dialog ────────────────────────────── */}
      {showNameDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowNameDialog(false)} />
          <div className="relative bg-card rounded-xl shadow-xl border border-border p-5 w-80 space-y-4">
            <div>
              <h3 className="text-sm font-semibold">New {newScriptType === "python" ? "Python" : "Shell"} Script</h3>
              <p className="text-[11px] text-muted-foreground mt-1">Enter a filename for your script.</p>
            </div>
            <input autoFocus type="text" value={newScriptName}
              onChange={e => setNewScriptName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && confirmAddScript()}
              placeholder={newScriptType === "python" ? "script.py" : "script.sh"}
              className="w-full h-9 px-3 text-sm rounded-md border border-border bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowNameDialog(false)}
                className="h-8 px-3 text-[12px] text-muted-foreground hover:text-foreground rounded-md">Cancel</button>
              <button onClick={confirmAddScript} disabled={!newScriptName.trim()}
                className="h-8 px-3 text-[12px] rounded-md bg-primary text-primary-foreground disabled:opacity-50">Create Script</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Submit Diff Preview Dialog ──────────────────────── */}
      {showSubmitDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowSubmitDialog(false)} />
          <div className="relative w-full max-w-2xl bg-card rounded-xl shadow-xl border border-border overflow-hidden flex flex-col max-h-[80vh]">
            <div className="px-6 py-4 border-b border-border">
              <h3 className="text-[14px] font-semibold">Submit for Review</h3>
              <p className="text-[12px] text-muted-foreground mt-1">Review your changes before submitting.</p>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
              {submitDiff ? (
                <SkillDiffView diff={submitDiff} />
              ) : (
                <p className="text-[12px] text-muted-foreground">First submission — all content will be reviewed.</p>
              )}
            </div>
            <div className="border-t border-border px-6 py-3 space-y-2">
              <input
                value={commitMessage} onChange={e => setCommitMessage(e.target.value)}
                placeholder="Comment (optional) — describe what changed and why"
                className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setShowSubmitDialog(false)} disabled={submitConfirming}
                  className="h-8 px-3 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">Cancel</button>
                <button onClick={handleSubmitConfirm} disabled={submitConfirming}
                  className="flex items-center gap-1.5 h-8 px-4 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
                  {submitConfirming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  {submitConfirming ? "Submitting..." : "Confirm Submit"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
