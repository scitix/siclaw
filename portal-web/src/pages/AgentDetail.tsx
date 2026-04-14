import { useState, useEffect } from "react"
import { useParams, useSearchParams, useNavigate } from "react-router-dom"
import { ArrowLeft, Loader2 } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { AgentSettings } from "../components/AgentSettings"

interface Agent {
  id: string; name: string; description: string; status: string
  model_provider: string; model_id: string; is_production: boolean
  system_prompt: string; icon: string; color: string; created_at: string
}

const statusColors: Record<string, string> = {
  active: "bg-[#10B981]",
  inactive: "bg-[#8B949E]",
  error: "bg-[#EF4444]",
}

export function AgentDetail() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()

  const [agent, setAgent] = useState<Agent | null>(null)
  const [loading, setLoading] = useState(true)

  const initialTab = searchParams.get("tab") || "basic"

  useEffect(() => {
    if (!id) return
    let cancelled = false
    api<Agent>(`/agents/${id}`)
      .then((data) => { if (!cancelled) setAgent(data) })
      .catch((err) => { if (!cancelled) toast.error(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <p className="text-[13px] text-muted-foreground">Agent not found</p>
        <button onClick={() => navigate("/agents")} className="mt-4 h-8 px-3 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground">
          <ArrowLeft className="inline h-3.5 w-3.5 mr-1.5" />
          Back to Agents
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center border-b border-border px-6 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/agents")}
            title="Back"
            className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold font-mono">{agent.name}</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                agent.is_production ? "bg-red-500/20 text-red-400" : "bg-blue-500/20 text-blue-400"
              }`}>
                {agent.is_production ? "PROD" : "DEV"}
              </span>
              <span className={`h-2 w-2 rounded-full ${statusColors[agent.status] || statusColors.inactive}`} />
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {agent.model_id || "No model"}
              {agent.model_provider ? ` · ${agent.model_provider}` : ""}
            </p>
          </div>
        </div>
      </div>

      {/* Settings with tabs */}
      <div className="flex-1 overflow-auto">
        <AgentSettings agent={agent} onUpdate={(updated) => setAgent(updated)} initialTab={initialTab} />
      </div>
    </div>
  )
}
