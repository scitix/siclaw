import { useState, useEffect } from "react"
import { useSearchParams, useLocation } from "react-router-dom"
import { Bot, Loader2, MessageSquare, PanelLeftClose, PanelLeftOpen } from "lucide-react"
import { api } from "../api"
import { AgentChat } from "../components/AgentChat"

const AGENT_SELECTOR_COLLAPSED_KEY = "siclaw.agentSelector.collapsed"

interface Agent {
  id: string; name: string; status: string; model_id: string; is_production: boolean
}

export function Chat() {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedAgentId, setSelectedAgentId] = useState<string>(searchParams.get("agent") || "")
  const [agentSelectorCollapsed, setAgentSelectorCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AGENT_SELECTOR_COLLAPSED_KEY) === "true"
    } catch {
      return false
    }
  })

  // Sync agent selection when the URL's ?agent= param changes (e.g. deep link
  // navigation while the component is always mounted in Layout).
  const agentFromUrl = searchParams.get("agent")
  useEffect(() => {
    if (agentFromUrl && agentFromUrl !== selectedAgentId) {
      setSelectedAgentId(agentFromUrl)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentFromUrl])

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

  useEffect(() => {
    try {
      localStorage.setItem(AGENT_SELECTOR_COLLAPSED_KEY, String(agentSelectorCollapsed))
    } catch {
      // Ignore storage failures in private browsing or locked-down environments.
    }
  }, [agentSelectorCollapsed])

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgentId(agentId)
    if (location.pathname.startsWith("/chat")) {
      setSearchParams({ agent: agentId })
    }
  }

  const agentStatusClass = (status: string) => (status === "active" ? "bg-green-500" : "bg-gray-500")

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
      <aside
        className={`border-r border-border flex flex-col shrink-0 bg-background/30 transition-[width] duration-200 ease-out ${
          agentSelectorCollapsed ? "w-14" : "w-[200px]"
        }`}
      >
        <div
          className={`border-b border-border ${
            agentSelectorCollapsed
              ? "h-12 flex items-center justify-center"
              : "px-3 py-2 flex items-center justify-between gap-2"
          }`}
        >
          {agentSelectorCollapsed ? (
            <button
              type="button"
              onClick={() => setAgentSelectorCollapsed(false)}
              className="h-8 w-8 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors"
              aria-label="Expand agent selector"
              title="Expand agent selector"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          ) : (
            <>
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Select Agent
              </span>
              <button
                type="button"
                onClick={() => setAgentSelectorCollapsed(true)}
                className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors"
                aria-label="Collapse agent selector"
                title="Collapse agent selector"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
        <div className={`flex-1 overflow-y-auto overflow-x-hidden ${agentSelectorCollapsed ? "py-2 px-1.5 space-y-1" : "py-1"}`}>
          {agents.map((a) => (
            agentSelectorCollapsed ? (
              <button
                key={a.id}
                type="button"
                onClick={() => handleSelectAgent(a.id)}
                className={`relative mx-auto flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
                  selectedAgentId === a.id
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                }`}
                aria-label={`Select agent ${a.name}`}
                title={`${a.name}${a.model_id ? ` · ${a.model_id}` : ""}`}
              >
                <Bot className="h-4 w-4" />
                <span className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${agentStatusClass(a.status)}`} />
              </button>
            ) : (
              <button
                key={a.id}
                type="button"
                onClick={() => handleSelectAgent(a.id)}
                className={`flex items-center gap-2 w-full px-3 py-2 text-left transition-colors ${
                  selectedAgentId === a.id
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                }`}
                title={`${a.name}${a.model_id ? ` · ${a.model_id}` : ""}`}
              >
                <Bot className="h-3.5 w-3.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-mono truncate">{a.name}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{a.model_id || "No model"}</p>
                </div>
                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${agentStatusClass(a.status)}`} />
              </button>
            )
          ))}
        </div>
      </aside>

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
