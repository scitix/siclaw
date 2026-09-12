// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../api"
import { AgentSettings } from "./AgentSettings"
import { AGENT_TYPES, agentTypeOption } from "../lib/agentTypes"

vi.mock("../api", () => ({ api: vi.fn() }))
vi.mock("./toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

const agent = {
  id: "a", name: "Legacy", description: "History", status: "disabled", agent_type: "coordinator",
  model_provider: "", model_id: "", system_prompt: "Historical prompt", is_production: true,
  icon: "", color: "", created_at: "", tool_capabilities: [] as string[],
}

afterEach(() => vi.clearAllMocks())

describe("Agent retirement settings", () => {
  it("renders a retired instance read-only, outside the selectable type catalog", () => {
    const html = renderToStaticMarkup(<AgentSettings agent={agent} onUpdate={vi.fn()} initialTab="tools" />)
    expect(html).toContain("Retired Agent")
    expect(html).toContain("Historical prompt")
    expect(html).not.toContain("Custom Agent")
    expect(html).not.toContain("<button")
    expect(vi.mocked(api)).not.toHaveBeenCalled()
    expect(agentTypeOption("coordinator").label).toBe("Retired Agent")
    expect(AGENT_TYPES.some(t => String(t.key) === "coordinator")).toBe(false)
  })

  it("does not clear a stored empty whitelist when saving unrelated settings", async () => {
    const custom = { ...agent, agent_type: "custom", status: "active" }
    vi.mocked(api).mockImplementation(async (_path, options) => options?.method === "PUT" ? custom as any : {} as any)
    const container = document.createElement("div")
    const root = createRoot(container)
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    try {
      await act(async () => root.render(<AgentSettings agent={custom} onUpdate={vi.fn()} initialTab="tools" />))
      expect(container.textContent).toContain("empty tool whitelist")
      expect(container.textContent).not.toContain("agent can use ALL tools")
      const save = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.trim() === "Save")!
      expect(save.disabled).toBe(false)
      await act(async () => save.click())
      const writes = vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "PUT")
      expect(writes).toHaveLength(1)
      expect(writes[0][1]?.body).not.toHaveProperty("tool_capabilities")
    } finally {
      await act(async () => root.unmount())
    }
  })
})
