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
import { createRestrictedBashTool } from "../../cmd-exec/restricted-bash.js";
import { createNodeExecTool } from "../../cmd-exec/node-exec.js";
import type { KubeconfigRef } from "../../../core/agent-factory.js";
import type { Evidence, TraceStep } from "./types.js";
import {
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

/**
 * Get auto-formatted skills prompt for phases that use llmComplete.
 * Used by hypothesis generation (Phase 2) which needs skill paths
 * for suggestedTools but doesn't use a pi-agent session.
 */
export function getFormattedSkillsPrompt(): string {
  return getSkillsPrompt();
}

