/**
 * OpenInference semantic-convention constants + the single content-redaction
 * out-gate for the trace recorder.
 *
 * Two responsibilities, both centralised here so the recorder never hand-writes
 * a bare attribute string or a redaction rule:
 *   1. Curated attribute keys + span-kind values, sourced from
 *      `@arizeai/openinference-semantic-conventions` (Phoenix and Langfuse both
 *      understand these). No literals like "llm.token_count.prompt" in the recorder.
 *   2. `redactForExport()` — the ONLY path content takes before it lands on a
 *      span, gated by `sendContent`. Redaction REUSES the shared content
 *      sanitizer (`redactSensitiveContent`, which itself applies the
 *      kubectl-sanitize SENSITIVE_* patterns) — rules are never copied here.
 */

import {
  SemanticConventions,
  OpenInferenceSpanKind,
} from "@arizeai/openinference-semantic-conventions";
import { redactSensitiveContent } from "../../tools/infra/output-sanitizer.js";

/** OpenInference span-kind attribute values (AGENT / CHAIN / LLM / TOOL / …). */
export const SpanKind = OpenInferenceSpanKind;

/**
 * Curated subset of OpenInference attribute keys used by the recorder. Sourced
 * from the package so a convention bump propagates without edits here.
 */
export const Attr = {
  spanKind: SemanticConventions.OPENINFERENCE_SPAN_KIND,
  sessionId: SemanticConventions.SESSION_ID,
  userId: SemanticConventions.USER_ID,
  metadata: SemanticConventions.METADATA,
  llmModelName: SemanticConventions.LLM_MODEL_NAME,
  llmProvider: SemanticConventions.LLM_PROVIDER,
  llmFinishReason: SemanticConventions.LLM_FINISH_REASON,
  tokenPrompt: SemanticConventions.LLM_TOKEN_COUNT_PROMPT,
  tokenCompletion: SemanticConventions.LLM_TOKEN_COUNT_COMPLETION,
  tokenTotal: SemanticConventions.LLM_TOKEN_COUNT_TOTAL,
  tokenCacheRead: SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ,
  tokenCacheWrite: SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE,
  cost: SemanticConventions.LLM_COST_TOTAL,
  toolName: SemanticConventions.TOOL_NAME,
  toolParameters: SemanticConventions.TOOL_PARAMETERS,
  inputValue: SemanticConventions.INPUT_VALUE,
  outputValue: SemanticConventions.OUTPUT_VALUE,
} as const;

/**
 * Which content slot a value occupies. Retained for call-site documentation; all
 * kinds are redacted uniformly (see redactForExport) — no kind is trusted-clean.
 */
export type ContentKind = "llm_input" | "llm_output" | "tool_args" | "tool_result";

/**
 * Hard ceiling on any single content attribute, in characters. Caps trace bloat
 * (a 100KB tool result or pasted log would otherwise choke the backend's UI).
 */
const MAX_CONTENT_CHARS = 8000;

/**
 * Budgets for the tool-definition builder — see
 * docs/design/2026-07-08-langfuse-tool-instrumentation.md "Serialization-safety
 * contract". Per-tool: a tool whose serialized `parameters` exceeds this drops
 * its parameters (keeps name+description). Total: tools are included in order
 * until this many chars are used (whole tools only), bounding one span's payload.
 */
const DEFAULT_PARAM_BUDGET = 4000;
const DEFAULT_TOOLS_TOTAL_BUDGET = 24000;

/** JSON-serialise non-string values without ever throwing (circular/BigInt/etc.). */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Truncate to MAX_CONTENT_CHARS with a visible marker. MUST be applied only
 * AFTER redaction: capping first could slice through the middle of a secret and
 * defeat the pattern matcher, leaking a partial credential.
 */
function capContent(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) return text;
  return `${text.slice(0, MAX_CONTENT_CHARS)}… [+${text.length - MAX_CONTENT_CHARS} chars]`;
}

/**
 * The ONLY content-redaction out-gate. Non-string values are JSON.stringify'd
 * first (tool args are objects, results are arrays), then redaction runs on the
 * serialized text. Pattern matching on serialized text catches key/value
 * secrets; deeply-nested or base64-wrapped secrets may slip through — this is a
 * documented residual risk, not a guarantee.
 *
 * ALL kinds — including `tool_result` — are redacted. The "model never reads
 * unsanitized output" invariant only covers cmd-exec / script-exec (which run
 * `postExecSecurity` / `redactSensitiveContent`); MCP-tool and query-tool results
 * reach the recorder with no sanitizer call, so a trusted-skip for tool_result
 * would ship their secrets raw once `sendContent` is enabled. Redaction is
 * idempotent, so re-redacting already-sanitized cmd-exec output is harmless.
 * `kind` is retained for call-site documentation (it no longer branches).
 *
 * Every return path is length-capped (capContent) as the LAST step — after any
 * redaction — so no path can emit unbounded content and capping never bisects a
 * secret.
 */
export function redactForExport(value: unknown, kind: ContentKind): string {
  void kind;
  const text = typeof value === "string" ? value : safeStringify(value);
  return capContent(redactSensitiveContent(text));
}

/**
 * Build a content attribute object, gated by `sendContent`. Returns `{}` when
 * the gate is closed (the v1 default) so callers can spread unconditionally:
 *   span.setAttributes({ ...contentAttribute(Attr.inputValue, text, "llm_input", sendContent) })
 * Nullish values also yield `{}` so empty slots never produce a key.
 */
export function contentAttribute(
  attrKey: string,
  value: unknown,
  kind: ContentKind,
  sendContent: boolean,
): Record<string, string> {
  if (!sendContent) return {};
  if (value === undefined || value === null) return {};
  return { [attrKey]: redactForExport(value, kind) };
}

/**
 * Build the `output.value` JSON for an assistant turn that requested tool calls,
 * in OpenAI Chat shape — see
 * docs/design/2026-07-08-langfuse-tool-instrumentation.md "Instrumentation
 * contract". Tool names + call ids are unconditional (metadata); arguments and
 * the assistant free text are gated by `sendContent` ("Metadata-vs-content
 * boundary").
 *
 * Returns undefined when there are no tool calls, so the caller can fall back to
 * the plain-text output.value path. The `arguments` key is ALWAYS present (empty
 * string when gated) — Langfuse's OpenAI detection requires `"arguments" in fn`.
 */
export function toolCallsOutputValue(
  calls: { id?: string; name: string; args?: unknown }[],
  text: string | undefined,
  sendContent: boolean,
): string | undefined {
  if (calls.length === 0) return undefined;
  const toolCalls = calls.map((c, i) => ({
    // `||` not `??`: an empty-string id is synthesized too, so Langfuse's
    // id-based dedup never collapses distinct calls with blank ids.
    id: c.id || `call_${i}`,
    type: "function",
    function: {
      name: c.name,
      arguments:
        sendContent && c.args !== undefined && c.args !== null
          ? redactForExport(c.args, "tool_args")
          : "",
    },
  }));
  const envelope: Record<string, unknown> = { tool_calls: toolCalls };
  if (sendContent && text) envelope.content = redactForExport(text, "llm_output");
  return safeStringify(envelope);
}

/**
 * Build the `input.value` JSON carrying available tool definitions, in OpenAI
 * request shape — see the design doc "Instrumentation contract". Names,
 * descriptions and parameter schemas are all unconditional metadata (static,
 * config-derived). Always-valid JSON per the "Serialization-safety contract": a
 * tool whose serialized `parameters` exceeds `paramBudget` drops its parameters;
 * tools are included in order until `totalBudget` is reached (whole tools only),
 * with at least the first tool always kept.
 */
export function toolDefinitionsInputValue(
  tools: { name: string; description?: string; parameters?: unknown }[],
  opts?: { paramBudget?: number; totalBudget?: number },
): string | undefined {
  if (tools.length === 0) return undefined;
  const paramBudget = opts?.paramBudget ?? DEFAULT_PARAM_BUDGET;
  const totalBudget = opts?.totalBudget ?? DEFAULT_TOOLS_TOTAL_BUDGET;
  const fns: unknown[] = [];
  let used = 0;
  for (const t of tools) {
    const fn: Record<string, unknown> = { name: t.name };
    if (t.description) fn.description = capContent(t.description);
    if (t.parameters !== undefined && t.parameters !== null) {
      // Strict JSON.stringify (NOT safeStringify): only include parameters that
      // genuinely serialize AND fit the budget. safeStringify would mask a
      // circular/BigInt throw as a short "[object Object]" and let the
      // unserializable value through, which then breaks the whole envelope's
      // JSON — violating the "always valid JSON" invariant.
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(t.parameters);
      } catch {
        serialized = undefined;
      }
      if (serialized !== undefined && serialized.length <= paramBudget) fn.parameters = t.parameters;
    }
    const entry = { type: "function", function: fn };
    const entryLen = safeStringify(entry).length;
    // Always keep the first tool; stop once a further tool would exceed the total.
    if (fns.length > 0 && used + entryLen > totalBudget) break;
    used += entryLen;
    fns.push(entry);
  }
  if (fns.length === 0) return undefined;
  return safeStringify({ tools: fns });
}
