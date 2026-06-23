// Frontend catalog of tool capability groups, mirroring the backend
// CAPABILITY_GROUPS in src/core/tool-capabilities.ts. The backend is the source
// of truth for the resolution; this copy only adds human-readable labels +
// descriptions for the UI. The `tools` arrays must stay in sync with the
// backend (capability groups are stable code constants — update both together).
//
// Semantics (backend): an agent stores the selected group KEYS in its
// `tool_capabilities` field. null / empty = unrestricted (all tools, the
// backward-compatible default). A non-null, non-empty selection restricts the
// agent to the union of those groups' tools. MCP tools are exempt (governed by
// the agent_mcp_servers binding).

export interface CapabilityGroup {
  key: string
  name: string
  description: string
  tools: string[]
}

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  { key: "read_files", name: "Read files", description: "Read & search files and knowledge pages", tools: ["read", "grep", "find", "ls"] },
  { key: "write_sandbox", name: "Write & author skills", description: "Write/edit scratch files and author skills (sandboxed to user-data)", tools: ["write", "edit", "skill_preview"] },
  { key: "inspect_infra", name: "Inspect infrastructure", description: "Read-only probes of clusters and hosts", tools: ["cluster_list", "cluster_probe", "host_list", "resolve_pod_netns"] },
  { key: "run_commands", name: "Run commands", description: "Execute whitelisted shell commands (kubectl read-only)", tools: ["bash", "node_exec", "pod_exec", "host_exec"] },
  { key: "run_scripts", name: "Run scripts", description: "Execute scripts on node / pod / host", tools: ["node_script", "pod_script", "local_script", "host_script"] },
  { key: "search_memory", name: "Search memory", description: "Semantic search over long-term memory", tools: ["memory_search", "memory_get"] },
  { key: "plan_tasks", name: "Plan tasks", description: "Create and track a task ledger", tools: ["task_create", "task_update", "task_list", "task_get"] },
  { key: "spawn_subagents", name: "Spawn sub-agents", description: "Fan out work to sub-agents (privilege amplification)", tools: ["spawn_subagent", "task_output", "job_stop"] },
  { key: "scheduling", name: "Scheduling", description: "Manage scheduled / recurring runs", tools: ["manage_schedule"] },
  { key: "session_output", name: "Session output", description: "Report findings, post channel updates & submit feedback", tools: ["task_report", "save_feedback", "channel_update"] },
]

/** Total distinct tools across the selected group keys (for the UI summary). */
export function countToolsForSelection(selected: Set<string>): number {
  const tools = new Set<string>()
  for (const g of CAPABILITY_GROUPS) {
    if (selected.has(g.key)) g.tools.forEach((t) => tools.add(t))
  }
  return tools.size
}

/**
 * Coerce a stored tool_capabilities value to a Set of known group keys.
 *
 * The agent REST API decodes JSON-in-TEXT columns (agent-api `decodeAgentRow`),
 * so `tool_capabilities` normally arrives as a decoded array. This coercer stays
 * tolerant of the raw JSON-string form too — defense in depth against any path
 * that hasn't been decoded (and the historical bug it fixed: an undecoded string
 * made the edit page echo "unrestricted", which a save would then persist,
 * wiping the restriction). Accept both the wire-string and already-parsed array.
 * Unknown / malformed values degrade to an empty Set — this is a
 * tolerant boundary coercion (signature is `unknown`), so a bad DB value must
 * not crash the render; the swallowed parse error is intentional here.
 */
export function toCapabilitySet(value: unknown): Set<string> {
  let parsed: unknown = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      return new Set()
    }
  }
  if (!Array.isArray(parsed)) return new Set()
  const known = new Set(CAPABILITY_GROUPS.map((g) => g.key))
  return new Set(parsed.filter((k): k is string => typeof k === "string" && known.has(k)))
}
