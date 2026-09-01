import { createHash } from "node:crypto";

import type { AgentType } from "./agent-types.js";
import type { AgentHarnessPolicy, CompiledAgentContext } from "./agent-context.js";
import { CAPABILITY_GROUPS } from "./tool-capabilities.js";

export const PROMPT_INSPECTION_VERSION = "prompt-inspection/v1" as const;
export const PROMPT_DESIGN_STANDARD = "siclaw-prompt-design/v1" as const;

export type PromptInspectionStage = "session_ready" | "provider_wire";
export type PromptDesignStatus = "pass" | "warn" | "fail";

export interface PromptInspectionTool {
  name: string;
  description: string | null;
  toolset: string | null;
  schemaSha256: string;
}

export interface PromptInspectionLayer {
  id: string;
  owner: string;
  source: string;
  mutable: boolean;
  text: string;
  chars: number;
  sha256: string;
}

export interface PromptDesignCheck {
  id: string;
  status: PromptDesignStatus;
  summary: string;
  detail: string;
}

export interface PromptInspection {
  version: typeof PROMPT_INSPECTION_VERSION;
  stage: PromptInspectionStage;
  agentType: AgentType;
  mode: string;
  prompt: { text: string; chars: number; sha256: string };
  layers: PromptInspectionLayer[];
  tools: PromptInspectionTool[];
  skills: string[];
  design: {
    standard: typeof PROMPT_DESIGN_STANDARD;
    verdict: PromptDesignStatus;
    checks: PromptDesignCheck[];
    references: Array<{ title: string; url: string }>;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function inspectTool(value: unknown): PromptInspectionTool | null {
  const root = asRecord(value);
  if (!root) return null;
  const fn = asRecord(root.function) ?? asRecord(root.custom);
  const name = typeof root.name === "string"
    ? root.name
    : typeof fn?.name === "string" ? fn.name : "";
  if (!name) return null;
  const description = typeof root.description === "string"
    ? root.description
    : typeof fn?.description === "string" ? fn.description : null;
  const parameters = root.parameters ?? fn?.parameters ?? root.input_schema ?? fn?.input_schema ?? null;
  return {
    name,
    description,
    toolset: typeof root.toolset === "string" ? root.toolset : null,
    schemaSha256: sha256(JSON.stringify(parameters)),
  };
}

function layer(
  id: string,
  owner: string,
  source: string,
  mutable: boolean,
  text: string,
): PromptInspectionLayer {
  return { id, owner, source, mutable, text, chars: text.length, sha256: sha256(text) };
}

function knownBuiltInToolNames(): Set<string> {
  return new Set(Object.values(CAPABILITY_GROUPS).flat());
}

function mentionedKnownTools(prompt: string): string[] {
  const known = knownBuiltInToolNames();
  const mentions = [...prompt.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((match) => match[1]);
  return [...new Set(mentions.filter((name) => known.has(name)))].sort();
}

function duplicateHeadings(prompt: string): string[] {
  const counts = new Map<string, number>();
  for (const match of prompt.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const heading = match[1].trim().toLowerCase();
    counts.set(heading, (counts.get(heading) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([heading]) => heading).sort();
}

function designChecks(input: {
  prompt: string;
  layers: PromptInspectionLayer[];
  tools: PromptInspectionTool[];
  harness: AgentHarnessPolicy;
}): PromptDesignCheck[] {
  const { prompt, layers, tools, harness } = input;
  const checks: PromptDesignCheck[] = [];
  const add = (id: string, status: PromptDesignStatus, summary: string, detail: string): void => {
    checks.push({ id, status, summary, detail });
  };

  const ids = layers.map((item) => item.id);
  const uniqueIds = new Set(ids);
  add(
    "explicit_layer_ownership",
    uniqueIds.size === ids.length && layers.every((item) => item.owner && item.source) ? "pass" : "fail",
    "Prompt instructions have explicit owners and sources.",
    uniqueIds.size === ids.length ? `${layers.length} layers are uniquely identified.` : "Duplicate or unowned prompt layers were found.",
  );

  const typeContract = layers.find((item) => item.id === "agent_type.contract");
  const typeContractOk = harness.agentType === "custom" ? !typeContract : Boolean(typeContract && !typeContract.mutable);
  add(
    "immutable_agent_type_contract",
    typeContractOk ? "pass" : "fail",
    "Built-in Agent Type behavior is an immutable layer.",
    harness.agentType === "custom"
      ? "Custom has no built-in type contract; its Agent addendum defines the role."
      : typeContractOk ? `${harness.agentType} owns an immutable type contract.` : `${harness.agentType} is missing its immutable contract.`,
  );

  const completionOk = prompt.includes("A progress update is not a completed turn") &&
    prompt.includes("The final response must stand on its own");
  add(
    "completion_semantics",
    completionOk ? "pass" : "fail",
    "Progress and completion are distinct.",
    completionOk ? "The Kernel requires an answer, necessary clarification, insufficient-evidence result, or concrete blocker." : "The prompt can end on a progress-only message.",
  );

  const legacyOverride = layers.some((item) => item.id === "platform.legacy_template_override");
  add(
    "stable_platform_kernel",
    legacyOverride ? "warn" : "pass",
    "Stable platform policy is separated from editable Agent text.",
    legacyOverride ? "A legacy full-template override is active; migrate it to an Agent addendum." : "No full-template override replaces the Platform Kernel.",
  );

  const irrelevantSre = harness.agentType !== "sre" && harness.agentType !== "custom" &&
    (prompt.includes("# SRE Work Policy") || prompt.includes("# Infrastructure Access"));
  add(
    "capability_scoped_guidance",
    irrelevantSre ? "fail" : "pass",
    "Role guidance follows the enforceable harness.",
    irrelevantSre ? `${harness.agentType} received SRE infrastructure guidance.` : `No incompatible SRE guidance is present for ${harness.agentType}.`,
  );

  const toolNames = new Set(tools.map((item) => item.name));
  const missingMentionedTools = mentionedKnownTools(prompt).filter((name) => !toolNames.has(name));
  add(
    "prompt_tool_alignment",
    missingMentionedTools.length === 0 ? "pass" : "fail",
    "Named built-in tools are present in the actual tool surface.",
    missingMentionedTools.length === 0
      ? `${toolNames.size} model-visible tools align with prompt references.`
      : `Prompt names unavailable tools: ${missingMentionedTools.join(", ")}.`,
  );

  if (harness.agentType === "knowledge_qa") {
    const retrievalContract = [
      prompt,
      ...tools.filter((tool) => tool.name === "knowledge_search")
        .map((tool) => tool.description ?? ""),
    ].join("\n");
    const forcesSearch = /must[^\n.]{0,80}`knowledge_search`/i.test(retrievalContract) ||
      /use `knowledge_search` before answering/i.test(retrievalContract);
    const preservesExploration = retrievalContract.includes("optional accelerator") &&
      retrievalContract.includes("Wiki") && retrievalContract.includes("similarity is not proof");
    add(
      "retrieval_below_reasoning",
      !forcesSearch && preservesExploration ? "pass" : "fail",
      "Knowledge retrieval accelerates reasoning instead of replacing it.",
      !forcesSearch && preservesExploration
        ? "Knowledge search remains optional and weak matches return to Wiki exploration."
        : "Knowledge QA is missing the optional-search or Wiki-exploration contract.",
    );
  }

  const duplicates = duplicateHeadings(prompt);
  add(
    "no_duplicate_sections",
    duplicates.length === 0 ? "pass" : "warn",
    "Repeated sections do not dilute instruction priority.",
    duplicates.length === 0 ? "No duplicate Markdown headings were found." : `Repeated headings: ${duplicates.join(", ")}.`,
  );

  const missingDescriptions = tools.filter((item) => !item.description?.trim()).map((item) => item.name);
  add(
    "tool_contract_quality",
    missingDescriptions.length === 0 ? "pass" : "warn",
    "Tool schemas explain their behavior at the tool boundary.",
    missingDescriptions.length === 0 ? "Every model-visible tool has a description." : `Tools without descriptions: ${missingDescriptions.join(", ")}.`,
  );

  add(
    "context_budget_visibility",
    prompt.length <= 20_000 ? "pass" : "warn",
    "Prompt size is visible and bounded by evaluation, not assumed from prose length.",
    `${prompt.length} characters in the effective system prompt${prompt.length > 20_000 ? "; review relevance and end-answer quality." : "."}`,
  );

  return checks;
}

function verdict(checks: PromptDesignCheck[]): PromptDesignStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

/**
 * Build the explicit, sensitive inspection returned only on demand. The normal
 * Agent Context manifest continues to contain hashes and layer metadata only.
 */
export function createPromptInspection(input: {
  context: CompiledAgentContext;
  mode: string;
  effectivePrompt: string;
  stage: PromptInspectionStage;
  tools: readonly unknown[];
  skillNames: readonly string[];
}): PromptInspection {
  const baseLayers = input.context.promptAssembly.layers.map((item) =>
    layer(item.id, item.owner, item.source, item.mutable, item.text));
  const layers = [...baseLayers];
  if (input.effectivePrompt.startsWith(input.context.systemPrompt)) {
    const runtime = input.effectivePrompt.slice(input.context.systemPrompt.length);
    if (runtime) {
      layers.push(layer(
        "runtime.composed_context",
        "runtime",
        "pi ResourceLoader (profile, Wiki, citations, context files, Skills, cwd)",
        false,
        runtime,
      ));
    }
  } else {
    layers.push(layer(
      "provider.effective_prompt",
      "provider",
      "final provider payload",
      false,
      input.effectivePrompt,
    ));
  }

  const tools = input.tools.map(inspectTool).filter((item): item is PromptInspectionTool => Boolean(item));
  const checks = designChecks({
    prompt: input.effectivePrompt,
    layers,
    tools,
    harness: input.context.harness,
  });

  return {
    version: PROMPT_INSPECTION_VERSION,
    stage: input.stage,
    agentType: input.context.harness.agentType,
    mode: input.mode,
    prompt: {
      text: input.effectivePrompt,
      chars: input.effectivePrompt.length,
      sha256: sha256(input.effectivePrompt),
    },
    layers,
    tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
    skills: [...new Set(input.skillNames)].sort(),
    design: {
      standard: PROMPT_DESIGN_STANDARD,
      verdict: verdict(checks),
      checks,
      references: [
        {
          title: "OpenAI model optimization guidance: lean prompts, relevant tools, representative evals",
          url: "https://developers.openai.com/api/docs/guides/latest-model",
        },
        {
          title: "OpenAI Codex harness guidance: lifecycle, context, tools, boundaries, and results",
          url: "https://developers.openai.com/blog/codex-as-a-platform",
        },
        {
          title: "OpenAI Codex open-source prompt and typed context assembly",
          url: "https://github.com/openai/codex",
        },
        {
          title: "xAI Grok Build open-source agent contracts and completion requirements",
          url: "https://github.com/xai-org/grok-build",
        },
      ],
    },
  };
}
