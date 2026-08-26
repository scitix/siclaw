import { createHash } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  effectiveAgentPrompt,
  effectiveCapabilityKeys,
  requireAgentType,
  type AgentType,
} from "./agent-types.js";
import { buildSystemPrompt } from "./prompt.js";
import { resolveCapabilities } from "./tool-capabilities.js";
import type { DelegationContext, SessionMode } from "./types.js";

export const AGENT_CONTEXT_VERSION = "agent-context/v1" as const;

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
  systemPromptTemplate?: string;
  delegation?: DelegationContext;
}

export interface AgentContextManifest {
  version: typeof AGENT_CONTEXT_VERSION;
  agentType: AgentType;
  resolution: HarnessResolution;
  mode: SessionMode;
  prompt: { chars: number; sha256: string };
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
export function resolveAgentHarness(input: Omit<CompileAgentContextInput, "mode" | "agentPrompt" | "systemPromptTemplate">): AgentHarnessPolicy {
  const agentType = requireAgentType(input.agentType);
  const resolution: HarnessResolution = input.harnessResolved === false ? "unresolved" : "resolved";
  // null is unrestricted only for an explicit Custom Agent. Built-in types own
  // locked capability groups, so direct/compiler callers that have not already
  // expanded them still receive the type's concrete allow-list rather than all
  // tools. This keeps the compiler boundary aligned with Gateway/LocalSpawner.
  const resolvedTools = input.allowedTools === null && agentType !== "custom"
    ? (resolveCapabilities(effectiveCapabilityKeys(agentType, null)) ?? [])
    : input.allowedTools;
  const allowedTools = resolution === "resolved" ? resolvedTools : [];
  const delegatedReadOnly = input.delegation?.readOnly === true;
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
    // this set further. Unresolved and delegated-read-only contexts fail closed.
    mcpExposure: resolution === "resolved" && !delegatedReadOnly ? "configured" : "none",
    memoryEnabled:
      resolution === "resolved" &&
      input.memoryConfigured &&
      !delegatedReadOnly &&
      hasAnyTool(allowedTools, ["memory_search", "memory_get"]),
    includeBundledSkills:
      resolution === "resolved" &&
      !delegatedReadOnly &&
      canOperate,
    includePlatformSkills:
      resolution === "resolved" &&
      !delegatedReadOnly &&
      hasAnyTool(allowedTools, ["write", "edit", "skill_preview"]),
    includePlanningGuidance:
      resolution === "resolved" &&
      hasAnyTool(allowedTools, ["task_create", "task_update", "task_list", "task_get"]),
    includeSubagentGuidance:
      resolution === "resolved" &&
      !delegatedReadOnly &&
      hasAnyTool(allowedTools, ["spawn_subagent"]),
    includeInfrastructureGuidance:
      resolution === "resolved" &&
      (agentType === "sre" || agentType === "custom") &&
      hasAnyTool(allowedTools, ["cluster_list", "host_list"]),
    includeOperationalSafety:
      resolution === "resolved" &&
      !delegatedReadOnly &&
      (agentType === "sre" || (agentType === "custom" && canOperate)),
    legacyUnrestrictedCustom,
  };
}

/** Compile the stable system prompt and enforceable policy for one session. */
export function compileAgentContext(input: CompileAgentContextInput): CompiledAgentContext {
  const harness = resolveAgentHarness(input);
  const agentPrompt = effectiveAgentPrompt(harness.agentType, input.agentPrompt);
  const systemPrompt = buildSystemPrompt({
    mode: input.mode,
    templateOverride: input.systemPromptTemplate,
    agentPrompt,
    memoryEnabled: harness.memoryEnabled,
    includeInfrastructureGuidance: harness.includeInfrastructureGuidance,
    includeOperationalSafety: harness.includeOperationalSafety,
    includeSkillAuthoring: harness.includePlatformSkills,
    includePlanningGuidance: harness.includePlanningGuidance,
    includeSubagentGuidance: harness.includeSubagentGuidance,
  });
  return { systemPrompt, harness };
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
  const { harness, systemPrompt } = input.context;
  return {
    version: AGENT_CONTEXT_VERSION,
    agentType: harness.agentType,
    resolution: harness.resolution,
    mode: input.mode,
    prompt: { chars: systemPrompt.length, sha256: sha256(systemPrompt) },
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
