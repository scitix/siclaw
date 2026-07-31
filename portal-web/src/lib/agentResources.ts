export interface AgentResourceBindingIds {
  cluster_ids: string[]
  host_ids: string[]
  skill_ids: string[]
  mcp_server_ids: string[]
  channel_ids: string[]
  knowledge_repo_ids: string[]
  delegate_agent_ids: string[]
}

function normalizedIds(ids: string[]): string[] {
  return [...new Set(ids)].sort()
}

export function diffAgentResourceBindings(
  previous: AgentResourceBindingIds,
  next: AgentResourceBindingIds,
): Partial<AgentResourceBindingIds> {
  const changed: Partial<AgentResourceBindingIds> = {}

  for (const key of Object.keys(previous) as Array<keyof AgentResourceBindingIds>) {
    const before = normalizedIds(previous[key])
    const after = normalizedIds(next[key])
    if (before.length !== after.length || before.some((id, index) => id !== after[index])) {
      changed[key] = after
    }
  }

  return changed
}
