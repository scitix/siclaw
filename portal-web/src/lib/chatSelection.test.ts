import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildChatPath,
  chatPathFromStoredSelection,
  chatSessionForAgent,
  readChatSelection,
  rememberChatAgent,
  rememberChatSession,
} from "./chatSelection"

function installMockWindow() {
  const storage = new Map<string, string>()
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
    dispatchEvent: vi.fn(),
  })
}

describe("chatSelection", () => {
  beforeEach(() => {
    installMockWindow()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("builds chat paths with agent and session params", () => {
    expect(buildChatPath({ agentId: "agent-a", sessionId: "session-1" })).toBe(
      "/chat?agent=agent-a&session=session-1",
    )
    expect(buildChatPath({ agentId: "agent-a" })).toBe("/chat?agent=agent-a")
    expect(buildChatPath()).toBe("/chat")
  })

  it("remembers the last agent and each agent's last session", () => {
    rememberChatSession("agent-a", "session-a1")
    rememberChatSession("agent-b", "session-b1")
    rememberChatAgent("agent-a")

    const selection = readChatSelection()
    expect(selection.lastAgentId).toBe("agent-a")
    expect(selection.lastSessionId).toBe("session-a1")
    expect(chatSessionForAgent("agent-b", selection)).toBe("session-b1")
    expect(chatPathFromStoredSelection()).toBe("/chat?agent=agent-a&session=session-a1")
  })

  it("clears only the deleted agent session", () => {
    rememberChatSession("agent-a", "session-a1")
    rememberChatSession("agent-b", "session-b1")
    rememberChatSession("agent-a", null)

    const selection = readChatSelection()
    expect(selection.lastAgentId).toBe("agent-a")
    expect(selection.lastSessionId).toBeNull()
    expect(chatSessionForAgent("agent-a", selection)).toBeNull()
    expect(chatSessionForAgent("agent-b", selection)).toBe("session-b1")
    expect(chatPathFromStoredSelection()).toBe("/chat?agent=agent-a")
  })
})
