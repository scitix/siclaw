import { useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { Plus, Zap, Trash2, Loader2, Search } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { useConfirm } from "../components/confirm-dialog"

interface Skill {
  id: string
  name: string
  description: string
  labels: string[] | null
  author_id: string
  status: "draft" | "pending_review" | "installed"
  version: number
  created_at: string
  updated_at: string
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  draft: { bg: "bg-yellow-500/20", text: "text-yellow-400", label: "Draft" },
  pending_review: { bg: "bg-blue-500/20", text: "text-blue-400", label: "Pending Review" },
  installed: { bg: "bg-green-500/20", text: "text-green-400", label: "Installed" },
}

export function Skills() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [labelFilter, setLabelFilter] = useState("")
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const toast = useToast()
  const confirmDialog = useConfirm()

  const pageSize = 20

  useEffect(() => {
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
      } catch {
        if (!cancelled) setSkills([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetch()
    return () => { cancelled = true }
  }, [page, search, labelFilter])

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog({
      title: "Delete Skill",
      message: "This will delete the skill and all its versions. This cannot be undone.",
      destructive: true,
      confirmLabel: "Delete",
    }))) return
    try {
      await api(`/siclaw/skills/${id}`, { method: "DELETE" })
      setSkills(prev => prev.filter(s => s.id !== id))
      toast.success("Skill deleted")
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  if (loading && skills.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const totalPages = Math.ceil(total / pageSize)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-lg font-semibold">Skills</h1>
          <p className="text-sm text-muted-foreground">
            {total} skill{total !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={() => navigate("/skills/new")}
          className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-3.5 w-3.5" /> New Skill
        </button>
      </div>

      {/* Search & filter */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border/50">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search skills..."
            className="w-full h-8 pl-8 pr-3 text-sm rounded-md border border-border bg-background"
          />
        </div>
        <input
          value={labelFilter}
          onChange={e => { setLabelFilter(e.target.value); setPage(1) }}
          placeholder="Filter by label..."
          className="w-48 h-8 px-3 text-sm rounded-md border border-border bg-background"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto">
        {skills.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Zap className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No skills found</p>
          </div>
        ) : (
          <div className="px-6 py-4 space-y-2">
            {skills.map(s => {
              const st = STATUS_STYLES[s.status] || STATUS_STYLES.draft
              const labels = Array.isArray(s.labels) ? s.labels : []
              return (
                <div
                  key={s.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:bg-secondary/30 cursor-pointer"
                  onClick={() => navigate(`/skills/${s.id}`)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Zap className="h-5 w-5 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium font-mono truncate">{s.name}</p>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${st.bg} ${st.text}`}>
                          {st.label}
                        </span>
                        <span className="text-[10px] text-muted-foreground">v{s.version}</span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {s.description || "No description"}
                      </p>
                      {labels.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {labels.map(l => (
                            <span
                              key={l}
                              className="px-1.5 py-0.5 rounded text-[10px] bg-secondary text-secondary-foreground"
                            >
                              {l}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(s.id) }}
                      title="Delete"
                      className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 px-6 py-3 border-t border-border">
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            className="h-7 px-3 text-xs rounded border border-border disabled:opacity-50"
          >
            Prev
          </button>
          <span className="text-xs text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            className="h-7 px-3 text-xs rounded border border-border disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
