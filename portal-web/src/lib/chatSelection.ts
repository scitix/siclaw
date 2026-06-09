const STORAGE_KEY = "siclaw.chatSelection.v1"

export const CHAT_SELECTION_CHANGE_EVENT = "siclaw:chat-selection-change"

export interface ChatSelectionState {
  lastAgentId: string | null
  lastSessionId: string | null
  sessionsByAgent: Record<string, string>
}

interface ChatPathSelection {
  agentId?: string | null
  sessionId?: string | null
}

const emptySelection = (): ChatSelectionState => ({
  lastAgentId: null,
  lastSessionId: null,
  sessionsByAgent: {},
})

const normalizeId = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const normalizeSelection = (value: unknown): ChatSelectionState => {
  if (!value || typeof value !== "object") {
    return emptySelection()
  }

  const raw = value as Partial<ChatSelectionState>
  const sessionsByAgent: Record<string, string> = {}

  if (raw.sessionsByAgent && typeof raw.sessionsByAgent === "object") {
    Object.entries(raw.sessionsByAgent).forEach(([agentId, sessionId]) => {
      const normalizedAgentId = normalizeId(agentId)
      const normalizedSessionId = normalizeId(sessionId)
      if (normalizedAgentId && normalizedSessionId) {
        sessionsByAgent[normalizedAgentId] = normalizedSessionId
      }
    })
  }

  const lastAgentId = normalizeId(raw.lastAgentId)
  const lastSessionId = lastAgentId
    ? normalizeId(raw.lastSessionId) || sessionsByAgent[lastAgentId] || null
    : null

  if (lastAgentId && lastSessionId) {
    sessionsByAgent[lastAgentId] = lastSessionId
  }

  return {
    lastAgentId,
    lastSessionId,
    sessionsByAgent,
  }
}

const emitSelectionChange = () => {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(CHAT_SELECTION_CHANGE_EVENT))
}

const writeChatSelection = (selection: ChatSelectionState): ChatSelectionState => {
  if (typeof window === "undefined") {
    return selection
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection))
    emitSelectionChange()
  } catch {
    // Keep chat usable when localStorage is unavailable.
  }

  return selection
}

export const readChatSelection = (): ChatSelectionState => {
  if (typeof window === "undefined") {
    return emptySelection()
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? normalizeSelection(JSON.parse(raw)) : emptySelection()
  } catch {
    return emptySelection()
  }
}

export const chatSessionForAgent = (
  agentId: string | null | undefined,
  selection: ChatSelectionState = readChatSelection(),
): string | null => {
  const normalizedAgentId = normalizeId(agentId)
  if (!normalizedAgentId) return null
  return selection.sessionsByAgent[normalizedAgentId] || null
}

export const rememberChatAgent = (agentId: string): ChatSelectionState => {
  const normalizedAgentId = normalizeId(agentId)
  if (!normalizedAgentId) {
    return readChatSelection()
  }

  const previous = readChatSelection()
  return writeChatSelection({
    lastAgentId: normalizedAgentId,
    lastSessionId: previous.sessionsByAgent[normalizedAgentId] || null,
    sessionsByAgent: previous.sessionsByAgent,
  })
}

export const rememberChatSession = (
  agentId: string,
  sessionId: string | null,
): ChatSelectionState => {
  const normalizedAgentId = normalizeId(agentId)
  if (!normalizedAgentId) {
    return readChatSelection()
  }

  const normalizedSessionId = normalizeId(sessionId)
  const previous = readChatSelection()
  const sessionsByAgent = { ...previous.sessionsByAgent }

  if (normalizedSessionId) {
    sessionsByAgent[normalizedAgentId] = normalizedSessionId
  } else {
    delete sessionsByAgent[normalizedAgentId]
  }

  return writeChatSelection({
    lastAgentId: normalizedAgentId,
    lastSessionId: normalizedSessionId,
    sessionsByAgent,
  })
}

export const buildChatPath = (
  selection: ChatPathSelection = {},
  basePath = "/chat",
): string => {
  const params = new URLSearchParams()
  const agentId = normalizeId(selection.agentId)
  const sessionId = normalizeId(selection.sessionId)

  if (agentId) params.set("agent", agentId)
  if (sessionId) params.set("session", sessionId)

  const query = params.toString()
  return query ? `${basePath}?${query}` : basePath
}

export const chatPathFromStoredSelection = (basePath = "/chat"): string => {
  const selection = readChatSelection()
  return buildChatPath(
    {
      agentId: selection.lastAgentId,
      sessionId: chatSessionForAgent(selection.lastAgentId, selection),
    },
    basePath,
  )
}
