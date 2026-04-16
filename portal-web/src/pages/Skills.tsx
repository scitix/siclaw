import { useState, useEffect, useMemo, useRef } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { Plus, Zap, Trash2, Loader2, Search, ClipboardCheck, ShieldCheck, Tag, ChevronDown, ChevronRight, X, Check, CheckCircle, XCircle, Upload, Pencil } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { useConfirm } from "../components/confirm-dialog"
import { SkillDiffView } from "../components/SimpleDiff"

// ── Types ───────────────────────────────────────────────────────

interface Skill {
  id: string; name: string; description: string; labels: string[] | null
  author_id: string; status: "draft" | "pending_review" | "installed"
  version: number; installed_version?: number | null; created_at: string; updated_at: string
  is_builtin?: boolean; overlay_of?: string | null
}

interface PendingReview {
  id: string; skill_id: string; skill_name: string; skill_description: string
  labels: string[] | null; version: number
  security_assessment: { risk_level: string; findings: unknown[] } | string | null
  submitted_by: string; submitted_at: string
}

// ── Style maps ──────────────────────────────────────────────────

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

function parseAssessment(raw: PendingReview["security_assessment"]): { risk_level: string } | null {
  if (!raw) return null
  if (typeof raw === "string") { try { return JSON.parse(raw) } catch { return null } }
  return raw
}

// ── Component ───────────────────────────────────────────────────

type Tab = "all" | "reviews"

export function Skills() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const toast = useToast()
  const confirmDialog = useConfirm()

  // Current user permissions
  const [isReviewer, setIsReviewer] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  useEffect(() => {
    api<{ role?: string; can_review_skills?: boolean }>("/auth/me")
      .then(u => {
        setIsReviewer(u.role === "admin" || !!u.can_review_skills)
        setIsAdmin(u.role === "admin")
      })
      .catch(() => {})
  }, [])

  // Tab — reviews tab only visible to reviewers
  const tabFromUrl = searchParams.get("tab") as Tab | null
  const [activeTab, setActiveTab] = useState<Tab>(tabFromUrl === "reviews" ? "reviews" : "all")

  // Reset to "all" if non-reviewer navigated to reviews
  useEffect(() => {
    if (activeTab === "reviews" && !isReviewer) setActiveTab("all")
  }, [isReviewer])

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab)
    setSearchParams(tab === "all" ? {} : { tab })
  }

  // ── All Skills state ──────────────────────────────────────────
  const [skills, setSkills] = useState<Skill[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set())
  const [labelDropdownOpen, setLabelDropdownOpen] = useState(false)
  const labelDropdownRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const pageSize = 20

  const labelFilterStr = [...selectedLabels].join(",")

  useEffect(() => {
    if (activeTab !== "all") return
    let cancelled = false
    async function fetch() {
      setLoading(true)
      try {
        let path = `/siclaw/skills?page=${page}&page_size=${pageSize}`
        if (search) path += `&search=${encodeURIComponent(search)}`
        if (labelFilterStr) path += `&labels=${encodeURIComponent(labelFilterStr)}`
        const res = await api<{ data: Skill[]; total: number }>(path)
        if (!cancelled) {
          setSkills(Array.isArray(res.data) ? res.data : [])
          setTotal(res.total || 0)
        }
      } catch { if (!cancelled) setSkills([]) }
      finally { if (!cancelled) setLoading(false) }
    }
    fetch()
    return () => { cancelled = true }
  }, [page, search, labelFilterStr, activeTab])

  // Compute available labels from loaded skills
  const availableLabels = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of skills) {
      for (const l of (Array.isArray(s.labels) ? s.labels : [])) {
        counts.set(l, (counts.get(l) || 0) + 1)
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [skills])

  const toggleLabel = (label: string) => {
    const next = new Set(selectedLabels)
    if (next.has(label)) next.delete(label)
    else next.add(label)
    setSelectedLabels(next)
    setPage(1)
  }

  // Close dropdown on click outside
  useEffect(() => {
    if (!labelDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (labelDropdownRef.current && !labelDropdownRef.current.contains(e.target as Node)) {
        setLabelDropdownOpen(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [labelDropdownOpen])

  // ── Pending Reviews state ─────────────────────────────────────
  const [reviews, setReviews] = useState<PendingReview[]>([])
  const [reviewsLoading, setReviewsLoading] = useState(true)

  // Load reviews when tab is active, or preload count for badge
  useEffect(() => {
    if (!isReviewer) return
    if (activeTab === "reviews") {
      setReviewsLoading(true)
      api<{ data: PendingReview[] }>("/siclaw/reviews/pending")
        .then(r => setReviews(Array.isArray(r.data) ? r.data : []))
        .catch(() => setReviews([]))
        .finally(() => setReviewsLoading(false))
    } else {
      // Preload count for badge
      api<{ data: PendingReview[] }>("/siclaw/reviews/pending")
        .then(r => setReviews(Array.isArray(r.data) ? r.data : []))
        .catch(() => {})
    }
  }, [activeTab, isReviewer])

  // ── Actions ───────────────────────────────────────────────────

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog({
      title: "Delete Skill", message: "Delete this skill and all versions? This cannot be undone.",
      destructive: true, confirmLabel: "Delete",
    }))) return
    try {
      await api(`/siclaw/skills/${id}`, { method: "DELETE" })
      setSkills(prev => prev.filter(s => s.id !== id))
      toast.success("Skill deleted")
    } catch (err: any) { toast.error(err.message) }
  }

  // ── Render ────────────────────────────────────────────────────

  const totalPages = Math.ceil(total / pageSize)

  return (
    <div className="flex flex-col h-full">
      {/* Header with tabs */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold">Skills</h1>
          <div className="flex items-center gap-1">
            <button onClick={() => handleTabChange("all")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium transition-all border ${
                activeTab === "all"
                  ? "bg-foreground text-background border-foreground"
                  : "bg-transparent text-muted-foreground border-transparent hover:bg-secondary"
              }`}>
              All Skills
              {total > 0 && <span className="text-[10px] opacity-70">{total}</span>}
            </button>
            {isReviewer && (
              <>
              <div className="w-px h-4 bg-border mx-1" />
              <button onClick={() => handleTabChange("reviews")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium transition-all border ${
                  activeTab === "reviews"
                    ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
                    : "bg-transparent text-muted-foreground border-transparent hover:bg-secondary"
                }`}>
                <ClipboardCheck className="h-3.5 w-3.5" />
                Reviews
              {reviews.length > 0 && activeTab !== "reviews" && (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] text-white">
                  {reviews.length}
                </span>
              )}
              </button>
              </>
            )}
          </div>
        </div>

        {activeTab === "all" && (
          <div className="flex items-center gap-2">
            {isAdmin && (
              <button onClick={() => navigate("/skills/import")} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground">
                <Upload className="h-3.5 w-3.5" /> Import
              </button>
            )}
            <button onClick={() => navigate("/skills/new")}
              className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90">
              <Plus className="h-3.5 w-3.5" /> New Skill
            </button>
          </div>
        )}
      </div>

      {/* Search & label filter (all tab only) */}
      {activeTab === "all" && (
        <div className="px-6 py-2.5 border-b border-border/50 space-y-2">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }}
                placeholder="Search skills..."
                className="w-full h-8 pl-8 pr-3 text-sm rounded-md border border-border bg-background" />
            </div>

            {/* Label dropdown */}
            <div ref={labelDropdownRef} className="relative">
              <button onClick={() => setLabelDropdownOpen(v => !v)}
                className={`flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[12px] font-medium border transition-all ${
                  labelDropdownOpen
                    ? "bg-secondary text-foreground border-border"
                    : "text-muted-foreground border-border hover:text-foreground"
                }`}>
                <Tag className="h-3 w-3" />
                Labels
                {selectedLabels.size > 0 && (
                  <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] px-1">
                    {selectedLabels.size}
                  </span>
                )}
                <ChevronDown className={`h-3 w-3 transition-transform ${labelDropdownOpen ? "rotate-180" : ""}`} />
              </button>

              {labelDropdownOpen && (
                <div className="absolute right-0 top-full mt-1 w-56 bg-card rounded-lg shadow-lg border border-border z-30 py-1 max-h-72 overflow-y-auto">
                  {availableLabels.length === 0 ? (
                    <p className="px-3 py-2 text-[11px] text-muted-foreground">No labels found</p>
                  ) : availableLabels.map(([label, count]) => (
                    <button key={label} onClick={() => toggleLabel(label)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-secondary/50 transition-colors">
                      <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                        selectedLabels.has(label)
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-border"
                      }`}>
                        {selectedLabels.has(label) && <Check className="h-2.5 w-2.5" />}
                      </span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-secondary text-secondary-foreground">
                        {label}
                      </span>
                      <span className="ml-auto text-muted-foreground/60 text-[10px]">{count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Selected label chips */}
          {selectedLabels.size > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {[...selectedLabels].map(label => (
                <span key={label}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-border bg-secondary text-secondary-foreground">
                  {label}
                  <button onClick={() => toggleLabel(label)} className="hover:opacity-70">
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
              <button onClick={() => { setSelectedLabels(new Set()); setPage(1) }}
                className="px-2 py-0.5 rounded-full text-[11px] text-muted-foreground hover:text-foreground">
                Clear all
              </button>
            </div>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === "all" ? (
          /* ── All Skills ─────────────────────────────────────── */
          loading && skills.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : skills.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20">
              <Zap className="h-12 w-12 text-muted-foreground/20 mb-3" />
              <p className="text-sm text-muted-foreground">No skills found</p>
            </div>
          ) : (
            <div className="px-6 py-4 space-y-2">
              {skills.map(s => {
                const st = STATUS_STYLES[s.status] || STATUS_STYLES.draft
                const lbls = Array.isArray(s.labels) ? s.labels : []
                return (
                  <div key={s.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:bg-secondary/30">
                    <div className="flex items-center gap-3 min-w-0">
                      <Zap className="h-5 w-5 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium font-mono truncate">{s.name}</p>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] ${st.bg} ${st.text}`}>{st.label}</span>
                          {s.is_builtin && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-500/20 text-purple-400">BUILTIN</span>
                          )}
                          {s.overlay_of && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-cyan-500/20 text-cyan-400">OVERLAY</span>
                          )}
                          {s.installed_version && (
                            <span className="text-[10px] text-green-400">installed v{s.installed_version}</span>
                          )}
                          {s.version !== (s.installed_version ?? 0) && (
                            <span className="text-[10px] text-muted-foreground">draft v{s.version}</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{s.description || "No description"}</p>
                        {lbls.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {lbls.map(l => (
                              <span key={l} className="px-1.5 py-0.5 rounded text-[10px] bg-secondary text-secondary-foreground">{l}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => navigate(`/skills/${s.id}`)} title="Edit"
                        className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground">
                        <Pencil className="h-4 w-4" />
                      </button>
                      {!s.is_builtin && (
                        <button onClick={() => handleDelete(s.id)} title="Delete"
                          className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        ) : (
          /* ── Pending Reviews with expandable approval cards ── */
          reviewsLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : reviews.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20">
              <ClipboardCheck className="h-12 w-12 text-muted-foreground/20 mb-3" />
              <p className="text-sm text-muted-foreground">No pending reviews</p>
            </div>
          ) : (
            <div className="px-6 py-4 space-y-3">
              {reviews.map(r => (
                <ReviewApprovalCard key={r.id} review={r} onDecision={() => {
                  // Reload reviews after decision
                  api<{ data: PendingReview[] }>("/siclaw/reviews/pending")
                    .then(res => setReviews(Array.isArray(res.data) ? res.data : []))
                    .catch(() => {})
                }} />
              ))}
            </div>
          )
        )}
      </div>

      {/* Pagination (all tab only) */}
      {activeTab === "all" && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 px-6 py-3 border-t border-border">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
            className="h-7 px-3 text-xs rounded border border-border disabled:opacity-50">Prev</button>
          <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
            className="h-7 px-3 text-xs rounded border border-border disabled:opacity-50">Next</button>
        </div>
      )}
    </div>
  )
}

// ── ReviewApprovalCard ──────────────────────────────────────────

function ReviewApprovalCard({ review: r, onDecision }: { review: PendingReview; onDecision: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [reviewDetail, setReviewDetail] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const toast = useToast()
  const confirmDialog = useConfirm()

  const assessment = parseAssessment(r.security_assessment)
  const riskLevel = assessment?.risk_level || "pending"
  const rs = RISK_STYLES[riskLevel] || { bg: "bg-secondary", text: "text-muted-foreground" }
  const lbls = Array.isArray(r.labels) ? r.labels : []

  const handleExpand = async () => {
    if (expanded) { setExpanded(false); return }
    setExpanded(true)
    setLoading(true)
    try {
      const detail = await api<any>(`/siclaw/skills/${r.skill_id}/review`)
      setReviewDetail(detail)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  const handleApprove = async () => {
    if (!(await confirmDialog({
      title: "Approve Skill",
      message: `Approve "${r.skill_name}"? It will become available for production agents.`,
      confirmLabel: "Approve",
    }))) return
    setSubmitting(true)
    try {
      await api(`/siclaw/skills/${r.skill_id}/approve`, { method: "POST" })
      toast.success(`"${r.skill_name}" approved`)
      onDecision()
    } catch (err: any) { toast.error(err.message) }
    finally { setSubmitting(false) }
  }

  const handleReject = async () => {
    if (!(await confirmDialog({
      title: "Reject Skill",
      message: `Reject "${r.skill_name}"?${reason ? "" : " You can add a reason before confirming."}`,
      confirmLabel: "Reject",
      destructive: true,
    }))) return
    setSubmitting(true)
    try {
      await api(`/siclaw/skills/${r.skill_id}/reject`, { method: "POST", body: { reason: reason || undefined } })
      toast.success(`"${r.skill_name}" rejected`)
      onDecision()
    } catch (err: any) { toast.error(err.message) }
    finally { setSubmitting(false) }
  }

  // Parse security assessment for the list card
  const sa = reviewDetail?.security_assessment
    ? (typeof reviewDetail.security_assessment === "string" ? JSON.parse(reviewDetail.security_assessment) : reviewDetail.security_assessment)
    : null
  const diffData = reviewDetail?.diff
    ? (typeof reviewDetail.diff === "string" ? JSON.parse(reviewDetail.diff) : reviewDetail.diff)
    : null

  return (
    <>
      {/* Review card — click opens modal */}
      <div onClick={handleExpand}
        className="flex items-center justify-between p-4 rounded-lg border border-border/50 hover:bg-secondary/20 cursor-pointer transition-colors">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
            <ShieldCheck className="h-4 w-4 text-amber-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium font-mono truncate">{r.skill_name}</p>
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${rs.bg} ${rs.text}`}>{riskLevel}</span>
              <span className="text-[10px] text-muted-foreground">v{r.version}</span>
            </div>
            <p className="text-xs text-muted-foreground truncate">{r.skill_description || "No description"}</p>
            {lbls.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {lbls.map(l => <span key={l} className="px-1.5 py-0.5 rounded text-[10px] bg-secondary text-secondary-foreground">{l}</span>)}
              </div>
            )}
          </div>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">{new Date(r.submitted_at).toLocaleDateString()}</span>
      </div>

      {/* Review modal */}
      {expanded && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setExpanded(false)} />
          <div className="relative w-full max-w-3xl bg-card rounded-xl shadow-xl border border-border overflow-hidden flex flex-col max-h-[85vh]">
            {/* Modal header */}
            <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-[14px] font-semibold font-mono">{r.skill_name}</h3>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${rs.bg} ${rs.text}`}>{riskLevel}</span>
                  <span className="text-[10px] text-muted-foreground">v{r.version}</span>
                </div>
                <p className="text-[12px] text-muted-foreground mt-0.5">{r.skill_description || "No description"}</p>
              </div>
              <button onClick={() => setExpanded(false)} className="p-1.5 rounded hover:bg-secondary text-muted-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Modal body — scrollable */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5 min-h-0">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <>
                  {/* Comment */}
                  {diffData?.comment && (
                    <div className="px-3 py-2 rounded-md bg-secondary/50 text-[12px]">
                      <span className="font-medium text-muted-foreground">Comment:</span> {diffData.comment}
                    </div>
                  )}

                  {/* Security assessment */}
                  {!sa && (
                    <div className="rounded-lg border border-border p-4 flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      <span className="text-[12px] text-muted-foreground">Security assessment in progress...</span>
                    </div>
                  )}
                  {sa && (
                    <div className="rounded-lg border border-border overflow-hidden">
                      <div className="px-4 py-3 bg-secondary/30 flex items-center gap-3">
                        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Security Review</span>
                        {(() => {
                          const rsk = RISK_STYLES[sa.risk_level] || RISK_STYLES.safe
                          return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${rsk.bg} ${rsk.text}`}>{sa.risk_level}</span>
                        })()}
                      </div>
                      <div className="p-4 space-y-3">
                        <p className="text-[12px] text-muted-foreground">{sa.summary}</p>
                        {sa.findings?.length > 0 && (
                          <div className="space-y-2">
                            {sa.findings.map((f: any, i: number) => {
                              const severityBorder = f.severity === "critical" ? "border-l-red-500" :
                                f.severity === "high" ? "border-l-orange-500" :
                                f.severity === "medium" ? "border-l-yellow-500" : "border-l-blue-500"
                              const rsk = RISK_STYLES[f.severity] || RISK_STYLES.low
                              return (
                                <div key={i} className={`flex items-start gap-3 p-3 rounded-md border border-border/50 border-l-2 ${severityBorder} bg-secondary/20`}>
                                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase shrink-0 mt-0.5 ${rsk.bg} ${rsk.text}`}>{f.severity}</span>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-[12px]">{f.pattern || f.description || f.match}</p>
                                    <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                                      <span className="font-mono">{f.scriptName}:{f.line}</span>
                                      <span>{f.category}</span>
                                      {f.match && f.match !== "[AI analysis]" && (
                                        <code className="px-1 py-0.5 rounded bg-secondary font-mono">{f.match}</code>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                        {(!sa.findings || sa.findings.length === 0) && (
                          <div className="text-center py-3 text-[12px] text-green-400">No security issues found.</div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Diff */}
                  {reviewDetail?.diff && (
                    <div className="space-y-2">
                      <span className="text-[12px] font-medium text-muted-foreground">Changes</span>
                      <SkillDiffView diff={reviewDetail.diff} />
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Modal footer — actions */}
            <div className="border-t border-border px-6 py-3 space-y-2 shrink-0">
              <input value={reason} onChange={e => setReason(e.target.value)}
                placeholder="Reject reason (optional)..."
                className="w-full h-8 px-3 text-[12px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring" />
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setExpanded(false)} className="h-8 px-3 text-[12px] text-muted-foreground hover:text-foreground">Cancel</button>
                <button onClick={handleReject} disabled={submitting}
                  className="flex items-center gap-1.5 h-8 px-3 text-[12px] rounded-md bg-red-600 text-white hover:opacity-90 disabled:opacity-50">
                  <XCircle className="h-3.5 w-3.5" /> Reject
                </button>
                <button onClick={handleApprove} disabled={submitting}
                  className="flex items-center gap-1.5 h-8 px-3 text-[12px] rounded-md bg-green-600 text-white hover:opacity-90 disabled:opacity-50">
                  <CheckCircle className="h-3.5 w-3.5" /> Approve
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
