// Agent types — UI mirror of src/core/agent-types.ts. Built-in types lock the
// capability set and provide an initial prompt, but every agent's persisted
// prompt remains editable by the portal admin.

export type AgentTypeKey = "sre" | "coordinator" | "knowledge_qa" | "custom"

export interface AgentTypeOption {
  key: AgentTypeKey
  label: string
  description: string
  /** Locked capability-group keys (read-only in the UI), or null for custom. */
  capabilities: string[] | null
  /** True when this type starts with no skills bound. */
  defaultNoSkills: boolean
}

export const AGENT_TYPES: AgentTypeOption[] = [
  {
    key: "sre",
    label: "SRE Agent",
    description: "Hands-on specialist: inspects, diagnoses and remediates within its authorized clusters/hosts.",
    capabilities: ["inspect_infra", "run_commands", "run_scripts", "read_files", "write_sandbox", "search_memory", "plan_tasks", "spawn_subagents", "session_output"],
    defaultNoSkills: false,
  },
  {
    key: "coordinator",
    label: "Coordinator Agent",
    description: "Answers knowledge questions from its skills/knowledge base and routes hands-on troubleshooting to specialist agents.",
    capabilities: ["read_files", "delegate_agents"],
    defaultNoSkills: true,
  },
  {
    key: "knowledge_qa",
    label: "Knowledge Q&A Agent",
    description: "Researches bound knowledge bases and answers with synthesized, source-backed information.",
    capabilities: ["read_files"],
    defaultNoSkills: true,
  },
  {
    key: "custom",
    label: "Custom Agent",
    description: "Free-form capabilities with the same editable prompt field as every agent type.",
    capabilities: null,
    defaultNoSkills: false,
  },
]

export function agentTypeOption(key: string | null | undefined): AgentTypeOption {
  return AGENT_TYPES.find((t) => t.key === key) ?? AGENT_TYPES[AGENT_TYPES.length - 1] // default: custom
}
