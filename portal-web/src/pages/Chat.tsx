import { useState, useEffect } from "react"
import { useSearchParams } from "react-router-dom"
import { Bot, Loader2, MessageSquare } from "lucide-react"
import { api } from "../api"
import { AgentChat } from "../components/AgentChat"

interface Agent {
  id: string; name: string; status: string; model_id: string; is_production: boolean
}

export function Chat() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedAgentId, setSelectedAgentId] = useState<string>(searchParams.get("agent") || "")

  useEffect(() => {
    api<{ data: Agent[] }>("/agents")
      .then((r) => {
        const list = Array.isArray(r.data) ? r.data : []
        setAgents(list)
        // Auto-select first agent if none specified
        if (!selectedAgentId && list.length > 0) {
          setSelectedAgentId(list[0].id)
        }
      })
      .catch(() => setAgents([]))
      .finally(() => setLoading(false))
  }, [])

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgentId(agentId)
    setSearchParams({ agent: agentId })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <MessageSquare className="h-12 w-12 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">No agents available</p>
        <p className="text-xs text-muted-foreground/70 mt-1">Create an agent first to start chatting</p>
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Agent selector sidebar */}
      <div className="w-[200px] border-r border-border flex flex-col shrink-0">
        <div className="px-3 py-2 border-b border-border">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Select Agent
          </span>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {agents.map((a) => (
            <button
              key={a.id}
              onClick={() => handleSelectAgent(a.id)}
              className={`flex items-center gap-2 w-full px-3 py-2 text-left transition-colors ${
                selectedAgentId === a.id
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              }`}
            >
              <Bot className="h-3.5 w-3.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-mono truncate">{a.name}</p>
                <p className="text-[10px] text-muted-foreground truncate">{a.model_id || "No model"}</p>
              </div>
              <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                a.status === "active" ? "bg-green-500" : "bg-gray-500"
              }`} />
            </button>
          ))}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 overflow-hidden">
        {selectedAgentId ? (
          <AgentChat key={selectedAgentId} agentId={selectedAgentId} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full">
            <MessageSquare className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">Select an agent to start chatting</p>
          </div>
        )}
      </div>
    </div>
  )
}
