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
 * Which content slot a value occupies. Drives redaction policy:
 *   - tool_result: model-side pipeline already sanitized it → recorded as-is.
 *   - everything else: run the shared content redactor.
 */
export type ContentKind = "llm_input" | "llm_output" | "tool_args" | "tool_result";

/** Cumulative token deltas (post − pre) for one prompt, mapped onto the ROOT span. */
export interface TokenDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * Hard ceiling on any single content attribute, in characters. Caps trace bloat
 * (a 100KB tool result or pasted log would otherwise choke the backend's UI).
 */
const MAX_CONTENT_CHARS = 8000;

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
 * `tool_result` is NOT re-redacted: the value handed to us is already the
 * model-side sanitized output (the "model never reads unsanitized output"
 * invariant), so re-running redaction would be redundant.
 *
 * Every return path is length-capped (capContent) as the LAST step — after any
 * redaction — so no path can emit unbounded content and capping never bisects a
 * secret.
 */
export function redactForExport(value: unknown, kind: ContentKind): string {
  const text = typeof value === "string" ? value : safeStringify(value);
  if (kind === "tool_result") return capContent(text);
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
 * Map a per-prompt token delta onto OpenInference `llm.token_count.*` attributes.
 * Only positive deltas are emitted (a no-op turn writes nothing).
 */
export function tokenCountAttributes(delta: TokenDelta): Record<string, number> {
  const attrs: Record<string, number> = {};
  if (delta.input > 0) attrs[Attr.tokenPrompt] = delta.input;
  if (delta.output > 0) attrs[Attr.tokenCompletion] = delta.output;
  if (delta.total > 0) attrs[Attr.tokenTotal] = delta.total;
  if (delta.cacheRead > 0) attrs[Attr.tokenCacheRead] = delta.cacheRead;
  if (delta.cacheWrite > 0) attrs[Attr.tokenCacheWrite] = delta.cacheWrite;
  return attrs;
}
