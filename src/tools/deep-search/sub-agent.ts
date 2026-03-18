/**
 * Deep Search Sub-Agent — pi-agent based implementation.
 *
 * Each sub-agent is an independent pi-agent session with:
 * - Full skill knowledge (auto-loaded from skills/core/ and skills/extension/)
 * - read + restricted bash + node_exec tools
 * - Budget control via event subscription
 * - Progress events bridged to parent
 *
 * Skills are loaded once and shared across all sub-agent sessions.
 * llmComplete (Phase 2/4) still uses raw chat API for single-call efficiency.
 */
import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  readTool,
  loadSkillsFromDir,
  formatSkillsForPrompt,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createRestrictedBashTool } from "../restricted-bash.js";
import { createNodeExecTool } from "../node-exec.js";
import type { KubeconfigRef } from "../../core/agent-factory.js";
import { getDefaultLlm, type ProviderModelCompat } from "../../core/config.js";
import type { Evidence, TraceStep } from "./types.js";
import {
  LLM_COMPLETE_MAX_TOKENS,
  BUDGET_ABORT_TIMEOUT_MS,
  EVIDENCE_MAX_OUTPUT,
  EVIDENCE_HEAD_CHARS,
  EVIDENCE_TAIL_CHARS,
} from "./types.js";

// --- Shared infrastructure (initialized once) ---

let cachedSkillsPrompt: string | null = null;
let sharedAuthStorage: AuthStorage | null = null;
let sharedModelRegistry: ModelRegistry | null = null;

function getSkillsPrompt(): string {
  if (cachedSkillsPrompt === null) {
    const { skills: coreSkills } = loadSkillsFromDir({ dir: "skills/core", source: "deep-search" });
    const { skills: extSkills } = loadSkillsFromDir({ dir: "skills/extension", source: "deep-search" });
    cachedSkillsPrompt = formatSkillsForPrompt([...coreSkills, ...extSkills]) || "";
  }
  return cachedSkillsPrompt;
}

function getSharedAuth(): AuthStorage {
  if (!sharedAuthStorage) sharedAuthStorage = AuthStorage.create();
  return sharedAuthStorage;
}

function getSharedModelRegistry(): ModelRegistry {
  if (!sharedModelRegistry) {
    const configPath = path.resolve(process.cwd(), ".siclaw", "config", "settings.json");
    const modelsJson = fs.existsSync(configPath) ? configPath : undefined;
    sharedModelRegistry = new ModelRegistry(getSharedAuth(), modelsJson);
  }
  return sharedModelRegistry;
}

// --- Public interfaces (unchanged for engine.ts compatibility) ---

export interface SubAgentResult {
  textOutput: string;
  evidence: Evidence[];
  callsUsed: number;
  trace: TraceStep[];
}

export interface SubAgentOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  api?: string;
  kubeconfigRef?: KubeconfigRef;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export type ProgressEvent =
  | { type: "phase"; phase: string; detail?: string }
  | { type: "llm_call"; iteration: number; maxCalls: number; hypothesisId?: string }
  | { type: "tool_exec"; tool: string; command: string; callsUsed: number; maxCalls: number; hypothesisId?: string }
  | { type: "tool_result"; tool: string; command: string; output: string; hypothesisId?: string }
  | { type: "llm_text"; text: string; hypothesisId?: string }
  | { type: "budget_exhausted"; callsUsed: number; hypothesisId?: string }
  | { type: "hypothesis"; id: string; status: string; confidence: number; text?: string };

// --- Session factory ---

/**
 * Create a lightweight pi-agent session for sub-agent use.
 * - In-memory session (no persistence)
 * - Shared auth/model registry
 * - Skills auto-loaded but included via systemPrompt (not loader scanning)
 * - read + restricted bash + node_exec tools only
 */
async function createSubAgentSession(systemPrompt: string, options?: SubAgentOptions): Promise<AgentSession> {
  const fullPrompt = systemPrompt + "\n\n" + getSkillsPrompt();

  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => fullPrompt,
    noSkills: true,       // Already in system prompt
    noExtensions: true,   // Sub-agent needs no extensions
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();

  const registry = getSharedModelRegistry();

  // Register dynamic provider from main session's llmConfigRef (gateway mode).
  // ModelRegistry is a singleton and registerProvider is idempotent (same name overwrites).
  let dynamicModel: ReturnType<ModelRegistry["find"]>;
  if (options?.baseUrl && options?.apiKey && options?.model) {
    const providerName = "dp-dynamic";
    registry.registerProvider(providerName, {
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      api: options.api ?? "openai-completions",
      models: [{
        id: options.model,
        name: options.model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
      }],
    });
    dynamicModel = registry.find(providerName, options.model);
  }

  const { session } = await createAgentSession({
    model: dynamicModel ?? undefined,
    tools: [readTool],
    customTools: [createRestrictedBashTool(options?.kubeconfigRef), createNodeExecTool(options?.kubeconfigRef)],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    authStorage: getSharedAuth(),
    modelRegistry: registry,
  });

  return session;
}

/**
 * Extract text content from agent messages.
 */
function extractTextFromMessages(messages: AgentMessage[]): string {
  // Walk backwards to find the last assistant message with text
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && "role" in msg && msg.role === "assistant" && "content" in msg) {
      const content = msg.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const textParts = content
          .filter((c: any) => c.type === "text" && c.text)
          .map((c: any) => c.text);
        if (textParts.length > 0) return textParts.join("\n");
      }
    }
  }
  return "";
}

/**
 * Extract command string from tool call args.
 */
function extractCommand(args: any): string {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return (parsed.command as string) ?? args;
    } catch {
      return args;
    }
  }
  return (args?.command as string) ?? JSON.stringify(args ?? {});
}

/**
 * Extract a structured trace from session messages.
 * Captures every LLM reasoning step and tool call for debug/analysis.
 */
function extractTrace(messages: AgentMessage[]): TraceStep[] {
  const trace: TraceStep[] = [];

  for (const msg of messages) {
    // AgentMessage is a complex union — use runtime checks via any
    const m = msg as any;
    if (!m || !m.role) continue;

    if (m.role === "assistant" && m.content != null) {
      const content = m.content;
      if (typeof content === "string" && content.trim()) {
        trace.push({ type: "llm_reasoning", content });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "text" && part.text?.trim()) {
            trace.push({ type: "llm_reasoning", content: part.text });
          } else if (part.type === "tool_use") {
            const cmd = extractCommand(part.input);
            trace.push({
              type: "tool_call",
              content: `${part.name}: ${cmd}`,
              tool: part.name,
              command: cmd,
            });
          }
        }
      }
    } else if ((m.role === "tool" || m.role === "toolResult") && m.content != null) {
      const content = m.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = content
          .filter((c: any) => c.type === "text" && c.text)
          .map((c: any) => c.text)
          .join("\n");
      }
      if (text) {
        trace.push({ type: "tool_result", content: text });
      }
    }
  }

  return trace;
}

/**
 * Extract text output from a tool result event.
 */
function extractToolOutput(result: any): string {
  if (!result) return "";
  const content = result.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text" && c.text)
      .map((c: any) => c.text)
      .join("\n");
  }
  return JSON.stringify(result).slice(0, 200);
}

/**
 * Extract a brief interpretation from tool output (first meaningful line).
 * Used to populate evidence.interpretation so reports show useful summaries.
 */
function extractBriefInterpretation(output: string): string {
  if (!output) return "";
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("...[truncated]"));
  if (lines.length === 0) return "";
  const first = lines[0];
  return first.length > 120 ? first.slice(0, 117) + "..." : first;
}

// --- Main sub-agent runner ---

/**
 * Run a sub-agent with an independent pi-agent session.
 *
 * Creates a full pi-agent with skill knowledge, budget control,
 * and progress events. When tool budget is exhausted, steers
 * the agent to output its conclusion immediately.
 */
export async function runSubAgent(
  systemPrompt: string,
  userMessage: string,
  maxCalls: number,
  options?: SubAgentOptions,
  onProgress?: ProgressCallback,
  forceOutputPrompt?: string,
): Promise<SubAgentResult> {
  const session = await createSubAgentSession(systemPrompt, options);
  const evidence: Evidence[] = [];
  let callsUsed = 0;
  let budgetExhausted = false;
  let sessionFinished = false;
  let abortTimer: ReturnType<typeof setTimeout> | null = null;

  // Track in-flight tool calls for evidence collection
  const inflightTools = new Map<string, { tool: string; command: string }>();

  // Subscribe to events for budget control + progress.
  // subscribe() returns an unsubscribe function — used for clean teardown.
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    // Guard: ignore events after session is finished
    if (sessionFinished) return;

    switch (event.type) {
      case "tool_execution_start": {
        const command = extractCommand(event.args);
        inflightTools.set(event.toolCallId, { tool: event.toolName, command });
        callsUsed++;

        // Skip read tool from budget counting (reading SKILL.md is free)
        if (event.toolName === "read") {
          callsUsed--;
          return;
        }

        onProgress?.({
          type: "tool_exec",
          tool: event.toolName,
          command: command.slice(0, 100),
          callsUsed,
          maxCalls,
        });

        // Budget enforcement: steer for graceful verdict, then abort after timeout
        if (callsUsed >= maxCalls && !budgetExhausted) {
          budgetExhausted = true;
          onProgress?.({ type: "budget_exhausted", callsUsed });
          // Steer the agent to output verdict immediately
          if (forceOutputPrompt) {
            session.steer(forceOutputPrompt).catch(() => {});
          }
          // Safety net: force abort if LLM ignores steer
          abortTimer = setTimeout(() => {
            if (!sessionFinished) {
              session.abort().catch(() => {});
            }
          }, BUDGET_ABORT_TIMEOUT_MS);
        }
        break;
      }

      case "tool_execution_end": {
        const inflight = inflightTools.get(event.toolCallId);
        if (!inflight || inflight.tool === "read") return;

        const output = extractToolOutput(event.result);
        onProgress?.({
          type: "tool_result",
          tool: inflight.tool,
          command: inflight.command.slice(0, 60),
          output: output.slice(0, 100),
        });

        evidence.push({
          tool: inflight.tool,
          command: inflight.command,
          output: output.length > EVIDENCE_MAX_OUTPUT
            ? output.slice(0, EVIDENCE_HEAD_CHARS) + "\n...[truncated]...\n" + output.slice(-EVIDENCE_TAIL_CHARS)
            : output,
          interpretation: event.isError
            ? "Tool execution failed"
            : extractBriefInterpretation(output),
        });
        inflightTools.delete(event.toolCallId);
        break;
      }

      case "message_end": {
        // Capture LLM text output for progress
        if ("role" in event.message && event.message.role === "assistant") {
          const content = event.message.content;
          let text = "";
          if (typeof content === "string") text = content;
          else if (Array.isArray(content)) {
            text = content
              .filter((c: any) => c.type === "text" && c.text)
              .map((c: any) => c.text)
              .join(" ");
          }
          if (text) {
            onProgress?.({ type: "llm_text", text: text.slice(0, 200) });
          }
        }
        break;
      }

      case "turn_start": {
        onProgress?.({ type: "llm_call", iteration: callsUsed, maxCalls });
        break;
      }
    }
  });

  const SUB_AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  let raceTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOutByRace = false;
  let finalText = "";
  let trace: TraceStep[] = [];

  try {
    // Run the investigation with a timeout to prevent indefinite hangs
    await Promise.race([
      session.prompt(userMessage),
      new Promise<never>((_, reject) => {
        raceTimer = setTimeout(() => {
          timedOutByRace = true;
          reject(new Error("Sub-agent timed out after 5 minutes"));
        }, SUB_AGENT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    // Mark finished first — guards against events from abort/dispose
    sessionFinished = true;

    // Clear timers to prevent leaked rejections after successful completion
    if (raceTimer) clearTimeout(raceTimer);
    if (abortTimer) clearTimeout(abortTimer);

    // Unsubscribe from events before dispose to prevent orphan events
    unsubscribe();

    // If timed out, abort the still-running session.prompt() to stop
    // burning CPU/resources on a result nobody will read
    if (timedOutByRace) {
      session.abort().catch(() => {});
    }

    // Extract output before dispose — session state is cleared on dispose
    finalText = extractTextFromMessages(session.state.messages);
    trace = extractTrace(session.state.messages);

    // Dispose session (removes internal listeners, frees resources)
    // Now guaranteed to run on both success and error/timeout paths
    session.dispose();
  }

  return { textOutput: finalText, evidence, callsUsed, trace };
}

// --- Simple LLM completion (kept as raw API for Phase 2/4 efficiency) ---

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ToolCallDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface ChatCompletionOptions {
  tools?: ToolCallDef[];
  tool_choice?: { type: "function"; function: { name: string } } | "auto" | "required";
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
}

/**
 * Resolve LLM config from explicit options → settings.json default.
 */
function resolveConfig(options?: SubAgentOptions) {
  const llm = getDefaultLlm();
  return {
    model: options?.model ?? llm?.model?.id ?? "",
    apiKey: options?.apiKey ?? llm?.apiKey ?? "",
    baseUrl: options?.baseUrl ?? llm?.baseUrl ?? "",
    compat: llm?.model?.compat,
  };
}

async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<ChatCompletionResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body: Record<string, unknown> = { model, messages, max_tokens: LLM_COMPLETE_MAX_TOKENS };
  if (options?.tools) body.tools = options.tools;
  if (options?.tool_choice) body.tool_choice = options.tool_choice;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`LLM API error ${response.status}: ${errText.slice(0, 500)}`);
  }

  return (await response.json()) as ChatCompletionResponse;
}

/**
 * Simple LLM completion (no tools). Used for hypothesis generation and conclusion.
 */
export async function llmComplete(
  systemPrompt: string | undefined,
  userMessage: string,
  options?: SubAgentOptions,
  onProgress?: ProgressCallback,
): Promise<string> {
  const { model, apiKey, baseUrl } = resolveConfig(options);

  if (!apiKey) throw new Error("API key not configured. Configure providers in .siclaw/config/settings.json.");
  if (!model) throw new Error("Model not configured. Configure a default model in .siclaw/config/settings.json.");
  if (!baseUrl) throw new Error("Base URL not configured. Configure a provider in .siclaw/config/settings.json.");

  onProgress?.({ type: "llm_call", iteration: 0, maxCalls: 0 });

  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: userMessage });

  const response = await chatCompletion(baseUrl, apiKey, model, messages);
  const text = response.choices[0]?.message?.content ?? "";
  onProgress?.({ type: "llm_text", text: text.slice(0, 200) });
  return text;
}

/**
 * Get auto-formatted skills prompt for phases that use llmComplete.
 * Used by hypothesis generation (Phase 2) which needs skill paths
 * for suggestedTools but doesn't use a pi-agent session.
 */
export function getFormattedSkillsPrompt(): string {
  return getSkillsPrompt();
}

// --- JSON extraction (used by llmCompleteWithTool fallback and engine.ts) ---

/**
 * Extract JSON from LLM output using multi-layer fallback:
 * 1. Direct JSON.parse
 * 2. Fenced code block (```json ... ```)
 * 3. Balanced brace matching (first complete top-level object)
 */
export function extractJSON(text: string): string | null {
  // 1. Direct parse — LLM sometimes returns pure JSON
  try {
    JSON.parse(text);
    return text;
  } catch {
    // continue to next strategy
  }

  // 2. Fenced code block
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      JSON.parse(fenceMatch[1]);
      return fenceMatch[1];
    } catch {
      // fence content wasn't valid JSON, continue
    }
  }

  // 3. Balanced brace extraction — find first complete top-level { ... }
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            // Balanced braces but not valid JSON, give up
            return null;
          }
        }
      }
    }
  }

  return null;
}

// --- LLM completion with function calling (tool_use) ---

/**
 * LLM completion with function calling (tool_use) for structured output.
 *
 * Tries OpenAI function calling first. Falls back to extractJSON() on the
 * text content if the provider ignores the tools parameter or returns no
 * tool_calls.
 *
 * When `supportsToolUse` is false in provider compat config, skips function
 * calling entirely and goes straight to llmComplete() + extractJSON().
 */
export async function llmCompleteWithTool<T>(
  systemPrompt: string | undefined,
  userMessage: string,
  toolName: string,
  toolDescription: string,
  toolSchema: Record<string, unknown>,
  options?: SubAgentOptions,
  onProgress?: ProgressCallback,
): Promise<{ toolArgs: T | null; textContent: string }> {
  const { model, apiKey, baseUrl, compat } = resolveConfig(options);

  if (!apiKey) throw new Error("API key not configured. Configure providers in .siclaw/config/settings.json.");
  if (!model) throw new Error("Model not configured. Configure a default model in .siclaw/config/settings.json.");
  if (!baseUrl) throw new Error("Base URL not configured. Configure a provider in .siclaw/config/settings.json.");

  // If provider doesn't support tool_use, fall back to plain completion + extractJSON
  if (compat?.supportsToolUse === false) {
    const text = await llmComplete(systemPrompt, userMessage, options, onProgress);
    const jsonStr = extractJSON(text);
    if (jsonStr) {
      try {
        return { toolArgs: JSON.parse(jsonStr) as T, textContent: text };
      } catch { /* fall through */ }
    }
    return { toolArgs: null, textContent: text };
  }

  onProgress?.({ type: "llm_call", iteration: 0, maxCalls: 0 });

  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: userMessage });

  const toolDef: ToolCallDef = {
    type: "function",
    function: { name: toolName, description: toolDescription, parameters: toolSchema },
  };

  const response = await chatCompletion(baseUrl, apiKey, model, messages, {
    tools: [toolDef],
    tool_choice: { type: "function", function: { name: toolName } },
  });

  const choice = response.choices[0];
  const textContent = choice?.message?.content ?? "";
  onProgress?.({ type: "llm_text", text: textContent.slice(0, 200) });

  // Primary path: extract from tool_calls
  const toolCall = choice?.message?.tool_calls?.[0];
  if (toolCall?.function?.arguments) {
    try {
      return { toolArgs: JSON.parse(toolCall.function.arguments) as T, textContent };
    } catch {
      // Malformed tool_call JSON — fall through to text extraction
    }
  }

  // Fallback: provider returned no tool_calls, try extractJSON on text content
  if (textContent) {
    const jsonStr = extractJSON(textContent);
    if (jsonStr) {
      try {
        return { toolArgs: JSON.parse(jsonStr) as T, textContent };
      } catch { /* fall through */ }
    }
  }

  return { toolArgs: null, textContent };
}
