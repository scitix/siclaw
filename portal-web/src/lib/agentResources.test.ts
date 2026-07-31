import { describe, expect, it } from "vitest"
import { diffAgentResourceBindings, type AgentResourceBindingIds } from "./agentResources"

function bindings(overrides: Partial<AgentResourceBindingIds> = {}): AgentResourceBindingIds {
  return {
    cluster_ids: [],
    host_ids: [],
    skill_ids: [],
    mcp_server_ids: [],
    channel_ids: [],
    knowledge_repo_ids: [],
    delegate_agent_ids: [],
    ...overrides,
  }
}

describe("diffAgentResourceBindings", () => {
  it("returns no update when only id order differs", () => {
    expect(diffAgentResourceBindings(
      bindings({ cluster_ids: ["c1", "c2"], skill_ids: ["s1"] }),
      bindings({ cluster_ids: ["c2", "c1"], skill_ids: ["s1"] }),
    )).toEqual({})
  })

  it("returns only the resource types that actually changed", () => {
    expect(diffAgentResourceBindings(
      bindings({ cluster_ids: ["c1"], mcp_server_ids: ["m1"] }),
      bindings({ cluster_ids: ["c1", "c2"], mcp_server_ids: ["m1"], delegate_agent_ids: ["a2"] }),
    )).toEqual({
      cluster_ids: ["c1", "c2"],
      delegate_agent_ids: ["a2"],
    })
  })
})
