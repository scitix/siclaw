import { createHash } from "node:crypto";
import type { DefaultResourceLoader, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  EVIDENCE_REVIEW_DEFAULT_PROMPT,
  resolveAgentAllowedTools,
  requireAgentType,
  resolveAgentPromptLayers,
  type AgentType,
} from "./agent-types.js";
import { PROMPT_ASSEMBLY_VERSION, buildSystemPromptAssembly, type PromptAssembly } from "./prompt.js";
import type { DelegationContext, SessionMode } from "./types.js";

export const AGENT_CONTEXT_VERSION = "agent-context/v2" as const;

// This is also exercised against Pi's real discovery implementation. Apply it last:
// inline factories and explicit paths must not bypass the no-discovery switches.
export const evidenceReviewResourceOptions = {
  noContextFiles: true,
  noSkills: true,
  noExtensions: true,
  noPromptTemplates: true,
  additionalSkillPaths: [],
  additionalExtensionPaths: [],
  additionalPromptTemplatePaths: [],
  extensionFactories: [],
  systemPrompt: EVIDENCE_REVIEW_DEFAULT_PROMPT,
  systemPromptOverride: () => EVIDENCE_REVIEW_DEFAULT_PROMPT,
  appendSystemPrompt: [],
  appendSystemPromptOverride: () => [],
  skillsOverride: () => ({ skills: [], diagnostics: [] }),
} satisfies Partial<ConstructorParameters<typeof DefaultResourceLoader>[0]>;

export type HarnessResolution = "resolved" | "unresolved";
export type McpExposure = "configured" | "none";

export interface AgentHarnessPolicy {
  version: typeof AGENT_CONTEXT_VERSION;
  agentType: AgentType;
  resolution: HarnessResolution;
  /** null is the explicit legacy Custom compatibility mode: all built-in tools. */
  allowedTools: string[] | null;
  /** MCP is a resource-binding axis, separate from built-in capability groups. */
  mcpExposure: McpExposure;
  memoryEnabled: boolean;
  includeBundledSkills: boolean;
  includePlatformSkills: boolean;
  includePlanningGuidance: boolean;
  includeSubagentGuidance: boolean;
  includeInfrastructureGuidance: boolean;
  includeOperationalSafety: boolean;
  legacyUnrestrictedCustom: boolean;
}

export interface CompileAgentContextInput {
  agentType?: unknown;
  allowedTools: string[] | null;
  /** False means the runtime could not prove which type/capabilities this Agent owns. */
  harnessResolved?: boolean;
  memoryConfigured: boolean;
  mode: SessionMode;
  agentPrompt?: string;
  interactiveProgress?: boolean;
  /** A conversation owner has a control emitter and an authorized handoff roster. */
  handoffAvailable?: boolean;
  handoffPolicy?: import("../shared/agent-handoff.js").HandoffPolicy;
  systemPromptTemplate?: string;
  delegation?: DelegationContext;
}

export interface AgentContextManifest {
  version: typeof AGENT_CONTEXT_VERSION;
  agentType: AgentType;
  resolution: HarnessResolution;
  mode: SessionMode;
  prompt: {
    chars: number;
    sha256: string;
    assemblyVersion: PromptAssembly["version"];
    layers: Array<{
      id: string;
      owner: string;
      source: string;
      mutable: boolean;
      chars: number;
      sha256: string;
    }>;
  };
  tools: { names: string[]; sha256: string };
  skills: { names: string[]; sha256: string };
  resources: {
    mcpExposure: McpExposure;
    mcpServers: string[];
    knowledgeMounted: boolean;
    memoryEnabled: boolean;
    bundledSkillsEnabled: boolean;
    platformSkillsEnabled: boolean;
  };
  policy: {
    infrastructureGuidance: boolean;
    operationalSafety: boolean;
    planningGuidance: boolean;
    subagentGuidance: boolean;
    legacyUnrestrictedCustom: boolean;
  };
}

export interface CompiledAgentContext {
  systemPrompt: string;
  promptAssembly: PromptAssembly;
  harness: AgentHarnessPolicy;
}

function hasAnyTool(allowedTools: string[] | null, names: readonly string[]): boolean {
  return allowedTools === null || names.some((name) => allowedTools.includes(name));
}

/**
 * Resolve the enforceable runtime policy for one Agent session.
 *
 * This is deliberately fail-closed when the control plane has not resolved the
 * Agent type/capabilities. Prompt wording is never used as a permission gate.
 */
export function resolveAgentHarness(
  input: Omit<CompileAgentContextInput, "mode" | "agentPrompt" | "systemPromptTemplate"> & { mode?: SessionMode },
): AgentHarnessPolicy {
  const agentType = requireAgentType(input.agentType);
  const resolution: HarnessResolution = input.harnessResolved === false ? "unresolved" : "resolved";
  // null is unrestricted only for an explicit Custom Agent. Built-in types own
  // locked capability groups, so direct/compiler callers that have not already
  // expanded them still receive the type's concrete allow-list rather than all
  // tools. This keeps the compiler boundary aligned with Gateway/LocalSpawner.
  const resolvedTools = input.allowedTools === null && agentType !== "custom"
    ? resolveAgentAllowedTools(agentType, null)
    : input.allowedTools;
  // task_report is part of the automated-task transport contract, not an
  // Agent's ordinary interactive capability set. Grant it only in task mode so
  // CRON_SECTION never instructs any Agent Type to call an unavailable tool.
  const modeTools = input.mode === "task" && Array.isArray(resolvedTools) && !resolvedTools.includes("task_report")
    ? [...resolvedTools, "task_report"]
    : resolvedTools;
  // Ownership transfer is a conversation transport capability for every type.
  // The factory proves emitter/roster/owner availability; unresolved harnesses
  // still fail closed. This grants no command, delegation, or resource access.
  const conversationTools = ["web", "channel", "task"].includes(input.mode ?? "web") && input.handoffAvailable && !input.delegation
    && Array.isArray(modeTools)
    ? [...new Set([...modeTools, "transfer_to_agent", "search_handoff_targets"])]
    : modeTools;
  const allowedTools = resolution === "resolved" && agentType !== "evidence_review" ? conversationTools : [];
  const legacyUnrestrictedCustom = resolution === "resolved" && agentType === "custom" && allowedTools === null;

  const canOperate = hasAnyTool(allowedTools, [
    "bash", "node_exec", "pod_exec", "host_exec",
    "node_script", "pod_script", "local_script", "host_script",
  ]);

  return {
    version: AGENT_CONTEXT_VERSION,
    agentType,
    resolution,
    allowedTools,
    // MCP servers are already scoped by the runtime's resolved configuration.
    // They are an explicit resource-binding axis, not names that can be placed
    // in a static built-in capability group. Siclaw currently receives no
    // trustworthy read/write or binding-source metadata with which to narrow
    // this set further. An unresolved context fails closed.
    mcpExposure: resolution === "resolved" && agentType !== "evidence_review" ? "configured" : "none",
    memoryEnabled:
      resolution === "resolved" &&
      input.memoryConfigured &&
      hasAnyTool(allowedTools, ["memory_search", "memory_get"]),
    includeBundledSkills:
      resolution === "resolved" &&
      canOperate,
    includePlatformSkills:
      resolution === "resolved" &&
      hasAnyTool(allowedTools, ["write", "edit", "skill_preview"]),
    includePlanningGuidance:
      resolution === "resolved" &&
      hasAnyTool(allowedTools, ["task_create", "task_update", "task_list", "task_get"]),
    includeSubagentGuidance:
      resolution === "resolved" &&
      hasAnyTool(allowedTools, ["spawn_subagent"]),
    includeInfrastructureGuidance:
      resolution === "resolved" &&
      (agentType === "sre" || agentType === "custom") &&
      hasAnyTool(allowedTools, ["cluster_list", "host_list"]),
    includeOperationalSafety:
      resolution === "resolved" &&
      (agentType === "sre" || (agentType === "custom" && canOperate)),
    legacyUnrestrictedCustom,
  };
}

/** Compile the stable system prompt and enforceable policy for one session. */
export function compileAgentContext(input: CompileAgentContextInput): CompiledAgentContext {
  const harness = resolveAgentHarness(input);
  if (harness.agentType === "evidence_review") {
    const promptAssembly: PromptAssembly = {
      version: PROMPT_ASSEMBLY_VERSION,
      text: EVIDENCE_REVIEW_DEFAULT_PROMPT,
      legacyTemplateOverride: false,
      layers: [{
        id: "agent_type.contract",
        owner: "agent_type",
        source: "src/core/agent-types.ts#EVIDENCE_REVIEW_DEFAULT_PROMPT",
        mutable: false,
        text: EVIDENCE_REVIEW_DEFAULT_PROMPT,
      }],
    };
    return { systemPrompt: promptAssembly.text, promptAssembly, harness };
  }
  const agentPrompt = resolveAgentPromptLayers(harness.agentType, input.agentPrompt);
  const handoffContract = ["web", "channel", "task"].includes(input.mode ?? "web") && input.handoffAvailable && !input.delegation
    && harness.resolution === "resolved"
    ? "Conversation ownership: transfer_to_agent is available for this main conversation. " +
      "When another authorized destination is better suited to continue the user's request, use its " +
      "coverage evidence from search_handoff_targets to transfer ownership. Query the exact cluster name/ID or host name/ID/IP when known; otherwise search configured capabilities. Do not infer resource ownership from Agent names. General role guidance to route " +
      "work to a specialist uses this ownership transfer for the main request; reserve delegation for " +
      "independent subtasks whose results you need back. Handle requests within your own capabilities " +
      "yourself. Do not guess an ambiguous destination, cycle between agents, or transfer merely to " +
      "repeat an answer. Not knowing an answer is not a reason to transfer: identify a concrete " +
      "capability or resource the destination has that can advance the request. If nobody suitable is " +
      "available, explain what remains unresolved and ask for the specific missing information or access. " +
      "Before returning to an agent that already participated, identify new verified evidence and why it " +
      "enables that agent to proceed. This does not grant you additional execution or resource permissions."
    : undefined;
  const handoffClosure = input.handoffPolicy && (input.handoffPolicy.remaining === 0 || !input.handoffAvailable) && !input.delegation
    ? (input.handoffPolicy.remaining === 0
        ? "Further conversation transfers are disabled for this request. "
        : "No eligible authorized transfer destination is available for this request. ") +
      "Continue within your own capabilities. " +
      "Use the available history and verified results to answer the user in their language. If unresolved, " +
      "explain the concrete limitation and ask for specific missing information or access. Do not claim " +
      "success, repeat failed checks without a new basis, or delegate the main request to bypass this limit."
    : undefined;
  const promptAssembly = buildSystemPromptAssembly({
    mode: input.mode,
    interactiveProgress: input.interactiveProgress ?? (input.mode === "web" && !input.delegation),
    templateOverride: input.systemPromptTemplate,
    agentTypePrompt: [agentPrompt.typeContract, handoffContract, handoffClosure].filter(Boolean).join("\n\n") || undefined,
    agentAddendum: agentPrompt.addendum,
    memoryEnabled: harness.memoryEnabled,
    includeInfrastructureGuidance: harness.includeInfrastructureGuidance,
    includeOperationalSafety: harness.includeOperationalSafety,
    includeSkillAuthoring: harness.includePlatformSkills,
    includePlanningGuidance: harness.includePlanningGuidance,
    includeSubagentGuidance: harness.includeSubagentGuidance,
  });
  return { systemPrompt: promptAssembly.text, promptAssembly, harness };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Build the non-sensitive audit record for the exact session context assembled
 * by Siclaw. The provider-payload hook may add a later, wire-level observation;
 * this manifest is the deterministic compiler output and model-visible tools.
 */
export function createAgentContextManifest(input: {
  context: CompiledAgentContext;
  mode: SessionMode;
  tools: readonly Pick<ToolDefinition, "name">[];
  skillNames: readonly string[];
  mcpServerNames: readonly string[];
  knowledgeMounted: boolean;
}): AgentContextManifest {
  const toolNames = sortedUnique(input.tools.map((tool) => tool.name));
  const skillNames = sortedUnique(input.skillNames);
  const mcpServerNames = sortedUnique(input.mcpServerNames);
  const { harness, systemPrompt, promptAssembly } = input.context;
  return {
    version: AGENT_CONTEXT_VERSION,
    agentType: harness.agentType,
    resolution: harness.resolution,
    mode: input.mode,
    prompt: {
      chars: systemPrompt.length,
      sha256: sha256(systemPrompt),
      assemblyVersion: promptAssembly.version,
      layers: promptAssembly.layers.map((layer) => ({
        id: layer.id,
        owner: layer.owner,
        source: layer.source,
        mutable: layer.mutable,
        chars: layer.text.length,
        sha256: sha256(layer.text),
      })),
    },
    tools: { names: toolNames, sha256: sha256(JSON.stringify(toolNames)) },
    skills: { names: skillNames, sha256: sha256(JSON.stringify(skillNames)) },
    resources: {
      mcpExposure: harness.mcpExposure,
      mcpServers: mcpServerNames,
      knowledgeMounted: input.knowledgeMounted,
      memoryEnabled: harness.memoryEnabled,
      bundledSkillsEnabled: harness.includeBundledSkills,
      platformSkillsEnabled: harness.includePlatformSkills,
    },
    policy: {
      infrastructureGuidance: harness.includeInfrastructureGuidance,
      operationalSafety: harness.includeOperationalSafety,
      planningGuidance: harness.includePlanningGuidance,
      subagentGuidance: harness.includeSubagentGuidance,
      legacyUnrestrictedCustom: harness.legacyUnrestrictedCustom,
    },
  };
}
