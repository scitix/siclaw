import { useState, useEffect, useCallback } from "react"
import { useSearchParams, useLocation } from "react-router-dom"
import { Bot, Loader2, MessageSquare, PanelLeftClose, PanelLeftOpen } from "lucide-react"
import { api } from "../api"
import { AgentChat } from "../components/AgentChat"
import {
  chatSessionForAgent,
  readChatSelection,
  rememberChatAgent,
  rememberChatSession,
} from "../lib/chatSelection"

const AGENT_SELECTOR_COLLAPSED_KEY = "siclaw.agentSelector.collapsed"
const AGENT_SELECTOR_OVERLAY_WIDTH = 220

interface Agent {
  id: string; name: string; status: string; model_id: string; is_production: boolean
}

export function Chat() {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedAgentId, setSelectedAgentId] = useState<string>(() => {
    const selection = readChatSelection()
    return searchParams.get("agent") || selection.lastAgentId || ""
  })
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => {
    const selection = readChatSelection()
    const initialAgentId = searchParams.get("agent") || selection.lastAgentId || ""
    return searchParams.get("session") || chatSessionForAgent(initialAgentId, selection)
  })
  const [agentPreview, setAgentPreview] = useState<{ agentId: string; left: number; top: number } | null>(null)
  const [agentSelectorCollapsed, setAgentSelectorCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AGENT_SELECTOR_COLLAPSED_KEY) === "true"
    } catch {
      return false
    }
  })

  const updateChatSearchParams = useCallback(
    (agentId: string, sessionId: string | null, replace = false) => {
      const pathname = typeof window === "undefined" ? location.pathname : window.location.pathname
      if (!pathname.startsWith("/chat")) return

      const next = new URLSearchParams()
      next.set("agent", agentId)
      if (sessionId) next.set("session", sessionId)
      setSearchParams(next, { replace })
    },
    [location.pathname, setSearchParams],
  )

  // Sync selection when URL params change while Chat is kept mounted by Layout.
  const agentFromUrl = searchParams.get("agent")
  const sessionFromUrl = searchParams.get("session")
  useEffect(() => {
    if (!location.pathname.startsWith("/chat") || !agentFromUrl) {
      return
    }

    const restoredSessionId = sessionFromUrl || chatSessionForAgent(agentFromUrl)
    setSelectedAgentId((current) => (current === agentFromUrl ? current : agentFromUrl))
    setSelectedSessionId((current) => (current === restoredSessionId ? current : restoredSessionId))

    if (sessionFromUrl) {
      rememberChatSession(agentFromUrl, sessionFromUrl)
    } else {
      rememberChatAgent(agentFromUrl)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentFromUrl, sessionFromUrl, location.pathname])

  useEffect(() => {
    const initialAgentFromUrl = searchParams.get("agent")
    const initialSessionFromUrl = searchParams.get("session")

    api<{ data: Agent[] }>("/agents")
      .then((r) => {
        const list = Array.isArray(r.data) ? r.data : []
        setAgents(list)
        if (list.length === 0) return

        const selection = readChatSelection()
        const candidateAgentId = [
          initialAgentFromUrl,
          selectedAgentId,
          selection.lastAgentId,
        ].find((agentId): agentId is string => (
          Boolean(agentId) && list.some((agent) => agent.id === agentId)
        ))

        const nextAgentId = candidateAgentId || list[0].id
        const nextSessionId = nextAgentId === initialAgentFromUrl && initialSessionFromUrl
          ? initialSessionFromUrl
          : chatSessionForAgent(nextAgentId, selection)

        setSelectedAgentId(nextAgentId)
        setSelectedSessionId(nextSessionId)
        if (nextSessionId) {
          rememberChatSession(nextAgentId, nextSessionId)
        } else {
          rememberChatAgent(nextAgentId)
        }
        updateChatSearchParams(nextAgentId, nextSessionId, true)
      })
      .catch(() => setAgents([]))
      .finally(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(AGENT_SELECTOR_COLLAPSED_KEY, String(agentSelectorCollapsed))
    } catch {
      // Ignore storage failures in private browsing or locked-down environments.
    }
  }, [agentSelectorCollapsed])

  useEffect(() => {
    if (agentSelectorCollapsed) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAgentSelectorCollapsed(true)
        setAgentPreview(null)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [agentSelectorCollapsed])

  useEffect(() => {
    if (!agentPreview) return

    const hideAgentPreview = () => setAgentPreview(null)

    window.addEventListener("resize", hideAgentPreview)
    document.addEventListener("scroll", hideAgentPreview, true)
    return () => {
      window.removeEventListener("resize", hideAgentPreview)
      document.removeEventListener("scroll", hideAgentPreview, true)
    }
  }, [agentPreview])

  const collapseAgentSelector = () => {
    setAgentSelectorCollapsed(true)
    setAgentPreview(null)
  }

  const handleSelectAgent = (agentId: string) => {
    const nextSessionId = chatSessionForAgent(agentId)
    setSelectedAgentId(agentId)
    setSelectedSessionId(nextSessionId)
    if (nextSessionId) {
      rememberChatSession(agentId, nextSessionId)
    } else {
      rememberChatAgent(agentId)
    }
    collapseAgentSelector()
    updateChatSearchParams(agentId, nextSessionId)
  }

  const handleSessionChange = useCallback((sessionId: string | null) => {
    if (!selectedAgentId) return

    setSelectedSessionId(sessionId)
    rememberChatSession(selectedAgentId, sessionId)
    updateChatSearchParams(selectedAgentId, sessionId, true)
  }, [selectedAgentId, updateChatSearchParams])

  const handleShowAgentPreview = (agentId: string, element: HTMLElement) => {
    if (!agentSelectorCollapsed) return
    const rect = element.getBoundingClientRect()
    const previewWidth = 224
    const previewHeight = 64
    setAgentPreview({
      agentId,
      left: Math.max(8, Math.min(rect.right + 10, window.innerWidth - previewWidth - 8)),
      top: Math.max(8, Math.min(rect.top, window.innerHeight - previewHeight - 8)),
    })
  }

  const agentStatusClass = (status: string) => (status === "active" ? "bg-green-500" : "bg-gray-500")
  const previewAgent = agentPreview ? agents.find((a) => a.id === agentPreview.agentId) : undefined

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
    <div className="relative flex h-full overflow-hidden">
      {/* Agent selector sidebar */}
      <aside
        className="w-14 border-r border-border flex flex-col shrink-0 bg-background/30"
      >
        <div className="h-12 border-b border-border flex items-center justify-center">
          <button
            type="button"
            onClick={() => {
              setAgentSelectorCollapsed(false)
              setAgentPreview(null)
            }}
            className="h-8 w-8 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors"
            aria-label="Expand agent selector"
            title="Expand agent selector"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden py-2 px-1.5 space-y-1">
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => handleSelectAgent(a.id)}
              onFocus={(e) => handleShowAgentPreview(a.id, e.currentTarget)}
              onMouseEnter={(e) => handleShowAgentPreview(a.id, e.currentTarget)}
              onBlur={() => setAgentPreview(null)}
              onMouseLeave={() => setAgentPreview(null)}
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
          ))}
        </div>
      </aside>

      {!agentSelectorCollapsed && (
        <>
          <div
            className="absolute right-0 top-0 bottom-0 z-30"
            style={{ left: AGENT_SELECTOR_OVERLAY_WIDTH }}
            onClick={collapseAgentSelector}
            aria-hidden="true"
          />
          <div
            className="absolute left-0 top-0 bottom-0 z-40 flex flex-col border-r border-border bg-background/95 shadow-xl shadow-black/10"
            style={{ width: AGENT_SELECTOR_OVERLAY_WIDTH }}
          >
            <div className="shrink-0 px-3 py-2 border-b border-border flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Select Agent
              </span>
              <button
                type="button"
                onClick={collapseAgentSelector}
                className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors"
                aria-label="Collapse agent selector"
                title="Collapse agent selector"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1">
              {agents.map((a) => (
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
              ))}
            </div>
          </div>
        </>
      )}

      {agentSelectorCollapsed && agentPreview && previewAgent && (
        <div
          className="fixed z-50 w-56 rounded-md border border-border bg-background/95 p-2 shadow-lg shadow-black/10 pointer-events-none"
          style={{ left: agentPreview.left, top: agentPreview.top }}
          aria-hidden="true"
        >
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary text-foreground">
              <Bot className="h-3.5 w-3.5" />
              <span className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${agentStatusClass(previewAgent.status)}`} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-medium text-foreground">{previewAgent.name}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {previewAgent.model_id || "No model"}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Chat area */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {selectedAgentId ? (
          <AgentChat
            key={selectedAgentId}
            agentId={selectedAgentId}
            selectedSessionId={selectedSessionId}
            onSessionChange={handleSessionChange}
          />
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
