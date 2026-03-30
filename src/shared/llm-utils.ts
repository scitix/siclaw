/**
 * General-purpose LLM utilities — OpenAI-compatible chat completion.
 *
 * Extracted from deep-search/sub-agent.ts so that foundational modules
 * (memory/) can use LLM calls without depending on workflow tool internals.
 */
import { getDefaultLlm } from "../core/config.js";

// ── Constants ───────────────────────────────────────────────────────

const LLM_COMPLETE_MAX_TOKENS = 4096;

// ── Public types ────────────────────────────────────────────────────

export interface LlmOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LlmProgressCallback = (event: any) => void;

// ── Internal types ──────────────────────────────────────────────────

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

// ── Internal helpers ────────────────────────────────────────────────

function resolveConfig(options?: LlmOptions) {
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

// ── Public API ──────────────────────────────────────────────────────

/**
 * Simple LLM completion (no tools).
 */
export async function llmComplete(
  systemPrompt: string | undefined,
  userMessage: string,
  options?: LlmOptions,
  onProgress?: LlmProgressCallback,
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
            return null;
          }
        }
      }
    }
  }

  return null;
}

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
  options?: LlmOptions,
  onProgress?: LlmProgressCallback,
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
