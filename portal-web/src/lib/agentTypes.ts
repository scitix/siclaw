// Agent types — UI mirror of src/core/agent-types.ts. Built-in types (sre,
// coordinator) LOCK the capability set + persona: the operator picks the type
// and does not hand-pick tools or write a prompt. `custom` is the free-form
// legacy agent (pick capabilities + write the system prompt). Keep the keys and
// the capability lists in sync with the backend registry.

export type AgentTypeKey = "sre" | "coordinator" | "custom"

export interface AgentTypeOption {
  key: AgentTypeKey
  label: string
  description: string
  /** Locked capability-group keys (read-only in the UI), or null for custom. */
  capabilities: string[] | null
  /** True when the persona/system-prompt is built-in and not user-editable. */
  lockedPrompt: boolean
  /** True when this type starts with no skills bound. */
  defaultNoSkills: boolean
}

export const AGENT_TYPES: AgentTypeOption[] = [
  {
    key: "sre",
    label: "SRE Agent",
    description: "Hands-on specialist: inspects, diagnoses and remediates within its authorized clusters/hosts.",
    capabilities: ["inspect_infra", "run_commands", "run_scripts", "read_files", "search_memory", "plan_tasks", "session_output"],
    lockedPrompt: true,
    defaultNoSkills: false,
  },
  {
    key: "coordinator",
    label: "Coordinator Agent",
    description: "Read-only router: sees the fleet and delegates hands-on troubleshooting to specialist agents.",
    capabilities: ["inspect_infra", "read_files", "search_memory", "delegate_agents"],
    lockedPrompt: true,
    defaultNoSkills: true,
  },
  {
    key: "custom",
    label: "Custom Agent",
    description: "Free-form: pick the tool capabilities and write the system prompt yourself.",
    capabilities: null,
    lockedPrompt: false,
    defaultNoSkills: false,
  },
]

export function agentTypeOption(key: string | null | undefined): AgentTypeOption {
  return AGENT_TYPES.find((t) => t.key === key) ?? AGENT_TYPES[AGENT_TYPES.length - 1] // default: custom
}
