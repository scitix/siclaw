import { useState, useEffect } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { Plus, Zap, Trash2, Loader2, Search, ClipboardCheck, ShieldCheck } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { useConfirm } from "../components/confirm-dialog"

// ── Types ───────────────────────────────────────────────────────

interface Skill {
  id: string; name: string; description: string; labels: string[] | null
  author_id: string; status: "draft" | "pending_review" | "installed"
  version: number; created_at: string; updated_at: string
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

  // Tab
  const tabFromUrl = searchParams.get("tab") as Tab | null
  const [activeTab, setActiveTab] = useState<Tab>(tabFromUrl === "reviews" ? "reviews" : "all")

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab)
    setSearchParams(tab === "all" ? {} : { tab })
  }

  // ── All Skills state ──────────────────────────────────────────
  const [skills, setSkills] = useState<Skill[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [labelFilter, setLabelFilter] = useState("")
  const [loading, setLoading] = useState(true)
  const pageSize = 20

  useEffect(() => {
    if (activeTab !== "all") return
    let cancelled = false
    async function fetch() {
      setLoading(true)
      try {
        let path = `/siclaw/skills?page=${page}&page_size=${pageSize}`
        if (search) path += `&search=${encodeURIComponent(search)}`
        if (labelFilter) path += `&labels=${encodeURIComponent(labelFilter)}`
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
  }, [page, search, labelFilter, activeTab])

  // ── Pending Reviews state ─────────────────────────────────────
  const [reviews, setReviews] = useState<PendingReview[]>([])
  const [reviewsLoading, setReviewsLoading] = useState(true)

  useEffect(() => {
    if (activeTab !== "reviews") return
    setReviewsLoading(true)
    api<{ data: PendingReview[] }>("/siclaw/reviews/pending")
      .then(r => setReviews(Array.isArray(r.data) ? r.data : []))
      .catch(() => setReviews([]))
      .finally(() => setReviewsLoading(false))
  }, [activeTab])

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
          </div>
        </div>

        {activeTab === "all" && (
          <button onClick={() => navigate("/skills/new")}
            className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90">
            <Plus className="h-3.5 w-3.5" /> New Skill
          </button>
        )}
      </div>

      {/* Search & filter (all tab only) */}
      {activeTab === "all" && (
        <div className="flex items-center gap-3 px-6 py-2.5 border-b border-border/50">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }}
              placeholder="Search skills..."
              className="w-full h-8 pl-8 pr-3 text-sm rounded-md border border-border bg-background" />
          </div>
          <input value={labelFilter} onChange={e => { setLabelFilter(e.target.value); setPage(1) }}
            placeholder="Filter by label..."
            className="w-48 h-8 px-3 text-sm rounded-md border border-border bg-background" />
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
                  <div key={s.id} onClick={() => navigate(`/skills/${s.id}`)}
                    className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:bg-secondary/30 cursor-pointer">
                    <div className="flex items-center gap-3 min-w-0">
                      <Zap className="h-5 w-5 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium font-mono truncate">{s.name}</p>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] ${st.bg} ${st.text}`}>{st.label}</span>
                          <span className="text-[10px] text-muted-foreground">v{s.version}</span>
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
                    <button onClick={e => { e.stopPropagation(); handleDelete(s.id) }} title="Delete"
                      className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400 shrink-0">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )
              })}
            </div>
          )
        ) : (
          /* ── Pending Reviews ────────────────────────────────── */
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
            <div className="px-6 py-4 space-y-2">
              {reviews.map(r => {
                const assessment = parseAssessment(r.security_assessment)
                const riskLevel = assessment?.risk_level || "pending"
                const rs = RISK_STYLES[riskLevel] || { bg: "bg-secondary", text: "text-muted-foreground" }
                const lbls = Array.isArray(r.labels) ? r.labels : []
                return (
                  <div key={r.id} onClick={() => navigate(`/skills/${r.skill_id}`)}
                    className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:bg-secondary/30 cursor-pointer">
                    <div className="flex items-center gap-3 min-w-0">
                      <ShieldCheck className="h-5 w-5 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium font-mono truncate">{r.skill_name}</p>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] ${rs.bg} ${rs.text}`}>{riskLevel}</span>
                          <span className="text-[10px] text-muted-foreground">v{r.version}</span>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{r.skill_description || "No description"}</p>
                        {lbls.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {lbls.map(l => (
                              <span key={l} className="px-1.5 py-0.5 rounded text-[10px] bg-secondary text-secondary-foreground">{l}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {new Date(r.submitted_at).toLocaleDateString()}
                    </span>
                  </div>
                )
              })}
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
