import { useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { ShieldCheck, Loader2 } from "lucide-react"
import { api } from "../api"

interface PendingReview {
  id: string
  skill_id: string
  skill_name: string
  skill_description: string
  labels: string[] | null
  version: number
  security_assessment: { risk_level: string; findings: unknown[]; summary: string } | string | null
  submitted_by: string
  submitted_at: string
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
  if (typeof raw === "string") {
    try { return JSON.parse(raw) } catch { return null }
  }
  return raw
}

export function PendingReviews() {
  const [reviews, setReviews] = useState<PendingReview[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    api<{ data: PendingReview[] }>("/siclaw/reviews/pending")
      .then(r => setReviews(Array.isArray(r.data) ? r.data : []))
      .catch(() => setReviews([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-border">
        <h1 className="text-lg font-semibold">Pending Reviews</h1>
        <p className="text-sm text-muted-foreground">{reviews.length} skill{reviews.length !== 1 ? "s" : ""} awaiting review</p>
      </div>

      <div className="flex-1 overflow-auto">
        {reviews.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <ShieldCheck className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No pending reviews</p>
          </div>
        ) : (
          <div className="px-6 py-4 space-y-2">
            {reviews.map(r => {
              const assessment = parseAssessment(r.security_assessment)
              const riskLevel = assessment?.risk_level || "pending"
              const rs = RISK_STYLES[riskLevel] || { bg: "bg-secondary", text: "text-muted-foreground" }
              const labels = Array.isArray(r.labels) ? r.labels : []
              return (
                <div
                  key={r.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:bg-secondary/30 cursor-pointer"
                  onClick={() => navigate(`/skills/${r.skill_id}`)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <ShieldCheck className="h-5 w-5 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium font-mono truncate">{r.skill_name}</p>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${rs.bg} ${rs.text}`}>{riskLevel}</span>
                        <span className="text-[10px] text-muted-foreground">v{r.version}</span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{r.skill_description || "No description"}</p>
                      {labels.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {labels.map(l => (
                            <span key={l} className="px-1.5 py-0.5 rounded text-[10px] bg-secondary text-secondary-foreground">{l}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(r.submitted_at).toLocaleDateString()}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
