import { createHash } from "node:crypto";

export interface ModelEnvelopeManifest {
  system: { chars: number; sha256: string };
  tools: { names: string[]; schemaSha256: string };
  markers: {
    sreIdentity: boolean;
    infrastructureGuidance: boolean;
    operationalSafety: boolean;
    memoryGuidance: boolean;
    planningGuidance: boolean;
    subagentGuidance: boolean;
  };
}

/**
 * Sensitive in-memory view used only by the explicit prompt inspection path.
 * Never serialize this into ordinary logs, traces, or sync-status payloads.
 */
export interface ModelEnvelopeInspection {
  systemPrompt: string;
  toolSchemas: unknown[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const record = part as Record<string, unknown>;
    return typeof record.text === "string" ? record.text : "";
  }).filter(Boolean).join("\n");
}

function instructionMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const message = item as Record<string, unknown>;
    if (message.role !== "system" && message.role !== "developer") continue;
    const text = textContent(message.content);
    if (text) out.push(text);
  }
  return out;
}

function toolName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const tool = value as Record<string, unknown>;
  if (typeof tool.name === "string") return tool.name;
  if (tool.function && typeof tool.function === "object") {
    const fn = tool.function as Record<string, unknown>;
    if (typeof fn.name === "string") return fn.name;
  }
  if (tool.custom && typeof tool.custom === "object") {
    const custom = tool.custom as Record<string, unknown>;
    if (typeof custom.name === "string") return custom.name;
  }
  return undefined;
}

/**
 * Inspect the final provider payload after every payload-rewrite hook.
 * Supports the common Anthropic, Chat Completions, and Responses shapes. Only
 * hashes, lengths, names, and known-section booleans leave this module; prompt
 * and user content stay private.
 */
export function inspectModelEnvelope(payload: unknown): ModelEnvelopeManifest {
  const inspection = extractModelEnvelopeInspection(payload);
  const system = inspection.systemPrompt;
  const toolSchemas = inspection.toolSchemas;
  const names = [...new Set(toolSchemas.map(toolName).filter((name): name is string => Boolean(name)))].sort();

  return {
    system: { chars: system.length, sha256: sha256(system) },
    tools: { names, schemaSha256: sha256(JSON.stringify(toolSchemas)) },
    markers: {
      sreIdentity: system.includes("specialist SRE agent"),
      infrastructureGuidance: system.includes("# SRE Work Policy") || system.includes("# Infrastructure Access"),
      operationalSafety: system.includes("# Operational Safety"),
      memoryGuidance: system.includes("# Memory — Search On Demand"),
      planningGuidance: system.includes("making a plan with `task_create` is your FIRST move"),
      subagentGuidance: system.includes("make **one `spawn_subagent` call"),
    },
  };
}

/** Extract only model-visible system instructions and tool schemas. */
export function extractModelEnvelopeInspection(payload: unknown): ModelEnvelopeInspection {
  const record = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const instructions: string[] = [];

  const directSystem = textContent(record.system);
  if (directSystem) instructions.push(directSystem);
  if (typeof record.instructions === "string" && record.instructions) {
    instructions.push(record.instructions);
  }
  instructions.push(...instructionMessages(record.messages));
  instructions.push(...instructionMessages(record.input));

  return {
    systemPrompt: instructions.join("\n\n"),
    toolSchemas: Array.isArray(record.tools) ? record.tools : [],
  };
}
