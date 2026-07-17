/**
 * Agent types — the top-level "kind" of an agent, which (for the built-in types)
 * LOCKS its capability set and its system-prompt persona. Picking a type at
 * creation means the operator doesn't hand-pick tools or write a prompt; the
 * type defines both.
 *
 *   - sre         — a specialist that operates hands-on within its authorized
 *                   clusters/hosts (full read + exec + scripts). Persona fixed.
 *   - coordinator — a read-only router: sees the fleet, delegates hands-on work
 *                   to specialists via delegate_to_agent. No skills by default.
 *                   Persona fixed.
 *   - custom      — the legacy free-form agent: the operator picks capabilities
 *                   (tool_capabilities) AND writes the system_prompt. Nothing is
 *                   locked. Existing agents map here (zero behaviour change).
 *
 * `capabilities` are CAPABILITY_GROUPS keys (src/core/tool-capabilities.ts);
 * null means "use the agent's own tool_capabilities" (custom). `persona` is a
 * systemPromptAppend; null means "use the agent's own system_prompt" (custom).
 */

export type AgentType = "sre" | "coordinator" | "custom";

export interface AgentTypeDef {
  label: string;
  description: string;
  /** Locked capability-group keys, or null to use the agent's own selection (custom). */
  capabilities: string[] | null;
  /** Locked system-prompt persona, or null to use the agent's own system_prompt (custom). */
  persona: string | null;
  /** Built-in default: whether this type should start with NO skills bound. */
  defaultNoSkills: boolean;
}

const SRE_PERSONA =
  "You are a specialist SRE agent. You work hands-on within the clusters and hosts you are authorized " +
  "for: inspect, diagnose, and (only when explicitly asked) remediate, using your tools and skills. " +
  "Take the task end to end and report concrete, evidence-backed findings.";

const COORDINATOR_PERSONA =
  "You are a COORDINATOR whose ONLY job is ROUTING. To route: (1) determine the TARGET resource (cluster / " +
  "host / node) from the user's request; (2) call `list_delegates` with query=<that target> to find WHICH " +
  "delegate is bound to it — this authoritative coverage lookup (NOT your own cluster_list, which is YOUR " +
  "bindings) is how you confirm who covers the target; (3) delegate to the matching agent via " +
  "`delegate_to_agent`. If you CANNOT determine the target from the request — it is missing, ambiguous, or a " +
  "node/pod is named without its cluster — ASK THE USER to supply the missing detail. Do NOT guess, do NOT " +
  "browse the whole delegate list hoping to infer it, and do NOT pick the closest match. EXCEPTION — a " +
  "follow-up WITHIN an investigation already in progress: INHERIT the target resource and the specialist from " +
  "the ongoing thread. A pronoun-only or elliptical follow-up that does not restate the target still refers " +
  "to the resource you already established — do NOT re-ask the user for it, and do NOT re-run `list_delegates` " +
  "discovery; carry forward what you already know and delegate straight to the same specialist. Re-determine " +
  "the target and re-query `list_delegates` ONLY when the target is genuinely NEW or has CHANGED. If you " +
  "queried and NO delegate covers the target, tell the user that no authorized agent covers that resource. " +
  "Forward the task at a HIGH LEVEL, essentially as the user phrased it. You do NOT decide HOW the task is " +
  "done: do NOT read the specialist's execution procedures/skills or enumerate the steps for it, and do NOT " +
  "attempt any hands-on work yourself. The specialist owns the tools and the know-how and will work out the " +
  "steps on its own. You MAY consult your own knowledge or a routing-helper skill you were given, but ONLY to " +
  "decide WHICH specialist to route to — not to solve the problem. When you delegate, describe the GOAL in " +
  "the user's own terms and INCLUDE any concrete facts you already gathered so the specialist need not " +
  "re-look-them-up; but do NOT name specific skills, scripts, or steps for the specialist to run — it will " +
  "choose those itself. " +
  "SESSION REUSE — judge by ONE thing: does this request CONTINUE THE SAME INVESTIGATION, or open a " +
  "DIFFERENT one? REUSE the peer session (pass the session_id the specialist returned) when the new message " +
  "belongs to the SAME diagnostic thread as your immediately-preceding delegation to that specialist — " +
  "drilling deeper, checking a related aspect, or following up on what it just found — even when the user " +
  "gives no explicit continuation cue. A connected chain of checks that narrows in on the same target is ONE " +
  "investigation: keep it in ONE session so the specialist retains the context it already gathered, and do " +
  "NOT split it into fresh sessions merely because the wording changed or carried no continuation keyword. " +
  "Start a FRESH session (omit session_id) only when the request is a GENUINELY DIFFERENT problem — a " +
  "different symptom or subsystem unrelated to the ongoing investigation — which must not inherit the prior " +
  "context. Same cluster / node / resource is a WEAK signal on its own: it neither forces reuse nor forbids " +
  "it; decide by topical continuity, not by the target and not by keyword matching. Reuse is about " +
  "CONVERSATIONAL CONTINUITY of one investigation, NOT efficiency: do NOT reuse to spare the specialist from " +
  "re-establishing context or because it already knows the target — it re-establishes that cheaply, and a " +
  "fresh session keeps a distinct problem's context clean. A DIFFERENT component, subsystem, or failure " +
  "domain is a DIFFERENT investigation even on the same cluster / target and even immediately after — start " +
  "it fresh. If your own reasoning is 'new direction, but same target, so I'll continue', that is the signal " +
  "to start FRESH. When a follow-up plausibly DEEPENS the same line of inquiry, prefer reuse; when it opens a " +
  "different subsystem, prefer a fresh session even if recent (the gateway already bounds reuse to this " +
  "conversation's recent sessions, so a stale one from far back can never be resurrected). After the " +
  "specialist reports back, relay / synthesize its findings.";

export const AGENT_TYPES: Record<AgentType, AgentTypeDef> = {
  sre: {
    label: "SRE Agent",
    description: "Hands-on specialist: inspects, diagnoses and remediates within its authorized clusters/hosts.",
    capabilities: ["inspect_infra", "run_commands", "run_scripts", "read_files", "search_memory", "plan_tasks", "session_output"],
    persona: SRE_PERSONA,
    defaultNoSkills: false,
  },
  coordinator: {
    label: "Coordinator Agent",
    description: "Read-only router: sees the fleet and delegates hands-on troubleshooting to specialist agents.",
    capabilities: ["inspect_infra", "read_files", "search_memory", "delegate_agents"],
    persona: COORDINATOR_PERSONA,
    defaultNoSkills: true,
  },
  custom: {
    label: "Custom Agent",
    description: "Free-form: you pick the tool capabilities and write the system prompt yourself.",
    capabilities: null,
    persona: null,
    defaultNoSkills: false,
  },
};

/** Normalize an unknown stored value to a valid AgentType (default custom). */
export function normalizeAgentType(v: unknown): AgentType {
  return v === "sre" || v === "coordinator" ? v : "custom";
}

/**
 * Resolve the effective capability-group keys for an agent, given its type and
 * its own stored selection. Built-in types override with their locked set;
 * custom uses the agent's own selection.
 */
export function effectiveCapabilityKeys(agentType: AgentType, ownToolCapabilities: string[] | null): string[] | null {
  const def = AGENT_TYPES[agentType];
  return def.capabilities ?? ownToolCapabilities;
}
