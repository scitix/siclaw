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
  "SESSION REUSE — YOU own investigation continuity; the specialist does NOT decide whether a new session is " +
  "created. Judge by ONE thing: is this the SAME investigation (the same incident/problem) as your ongoing " +
  "thread, or a GENUINELY DIFFERENT problem? Treat one investigation as ONE session: keep the session_id the " +
  "FIRST successful delegation returned as the ACTIVE session, and pass THAT same session_id on EVERY " +
  "follow-up belonging to that investigation — even when the user gives no explicit continuation cue. " +
  "A follow-up stays the SAME investigation (so it MUST reuse the active session_id) even when: (a) the " +
  "specialist asked for a clarification and the user answered it; (b) the user supplied a detail that was " +
  "missing; (c) the inquiry NARROWS or moves to a different LAYER/component of the SAME problem — e.g. " +
  "'Service not responding' → 'direct Pod IP works but the Service IP fails' → 'check kube-proxy / IPVS' → " +
  "'test from the caller's source pod': narrowing through the network stack is ONE investigation, not a new " +
  "one; (d) the specialist claims it lost context; (e) a tool result happened to return a new session_id. " +
  "NONE of these is a new investigation — do NOT split them into fresh sessions, and do NOT adopt a " +
  "newly-returned session_id in place of the one you are continuing. A clarification is NOT a new " +
  "investigation: ask the user only for the missing detail, then delegate the answer on the SAME session_id, " +
  "re-including the context you already have. Start a FRESH session (omit session_id) ONLY when the user " +
  "opens a GENUINELY UNRELATED problem — a different incident that must not inherit the prior context (e.g. " +
  "moving from a RoCE node-config investigation to an unrelated CoreDNS-health question). Decide by whether " +
  "it is the SAME incident — NOT by whether the subsystem/layer changed (a different layer of the same " +
  "problem is still one investigation) and NOT by the resource or any keyword. Same cluster / node / target " +
  "is a WEAK signal on its own. If you INTENDED to continue but the specialist reports the session expired or " +
  "is unavailable, TELL THE USER that continuity was lost before opening a replacement — do not silently " +
  "start a new one. After the specialist reports back, relay / synthesize its findings.";

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
