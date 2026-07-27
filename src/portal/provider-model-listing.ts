/**
 * Listing a provider's models over its own API, so an operator doesn't have to
 * type model ids by hand.
 *
 * There is no formal standard here. `GET {base_url}/models` is a de facto one —
 * vLLM, Ollama, LM Studio, and the aggregator gateways all implement it — but
 * only `data[].id` can be relied on. `owned_by` is in the OpenAI spec yet
 * implementations vary wildly ("openai" / "system" / "library" / an org name /
 * absent), and context window and max tokens are not in the spec at all. So the
 * parser is defensive throughout: anything missing degrades to a default rather
 * than failing the listing. Anthropic's native /v1/models is a different schema
 * that happens to carry the extra fields, so that branch fills more in.
 *
 * Providers that expose neither shape (Azure OpenAI's
 * /openai/deployments?api-version=… being the notable one) simply fail the
 * fetch; manual entry stays available.
 */

import { isBlockedIpLiteral } from "./tracing-exporters.js";

/** One row offered to the operator in the import dialog. */
export interface ListedModel {
  id: string;
  name?: string;
  /** Pre-filled protocol for the row; "" = inherit the provider. */
  suggested_api_type: string;
  /**
   * Set when the row looks like a Claude model on an OpenAI-protocol provider —
   * a case the dialog flags but does not decide. See `looksLikeClaudeModel`.
   */
  protocol_hint?: "claude";
  context_window?: number;
  max_tokens?: number;
  vision?: boolean;
  reasoning?: boolean;
}

/**
 * Whether a listing entry looks like a Claude model. A HINT ONLY — it must not
 * drive `suggested_api_type`.
 *
 * The tempting inference (`/claude/i` ⇒ anthropic-messages) is wrong as often
 * as it is right, and the two cases are indistinguishable from the listing:
 *
 *   - scitix's gateway (api_type=openai-completions) serves `claude-sonnet-5`
 *     over the CLAUDE protocol — it needs the override.
 *   - OpenRouter / LiteLLM / one-api (also openai-completions) serve
 *     `anthropic/claude-3.5-sonnet` over the OPENAI protocol — an override
 *     there makes the model 404 on every turn.
 *
 * Guessing wrong costs a completely dead model with a confusing protocol error;
 * not guessing costs one dropdown click. So the row defaults to inherit and the
 * dialog surfaces this hint next to it.
 *
 * `owned_by` is only a tiebreaker; too many gateways return a constant there
 * ("system", "library", an org name) for it to carry weight alone.
 */
export function looksLikeClaudeModel(id: string, ownedBy?: unknown): boolean {
  if (/claude/i.test(id)) return true;
  return typeof ownedBy === "string" && ownedBy.trim().toLowerCase() === "anthropic";
}

function asPositiveInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function pick(entry: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (entry[k] !== undefined && entry[k] !== null) return entry[k];
  }
  return undefined;
}

/**
 * Context window from whichever vendor extension the gateway happens to use.
 *
 * The OpenAI listing spec has no such field, but leaving it unknown means the
 * import falls back to a flat 128000 — and `context_window` is load-bearing:
 * `ensureContextForModelPrompt` rejects a turn in PREFLIGHT when the estimate
 * exceeds it, so a model with a real 1M window declared at 128K starts refusing
 * long sessions siclaw-side, before the provider ever sees them. Any real value
 * beats the default, so we read the common extensions.
 */
function extractContextWindow(entry: Record<string, unknown>): number | undefined {
  // OpenRouter: context_length · vLLM: max_model_len · assorted gateways:
  // max_context_length / context_size / max_input_tokens.
  return asPositiveInt(pick(
    entry,
    "context_length", "max_model_len", "max_context_length", "context_size",
    "context_window", "max_input_tokens",
  ));
}

/** Max output tokens, same vendor-extension treatment. */
function extractMaxTokens(entry: Record<string, unknown>): number | undefined {
  const direct = asPositiveInt(pick(entry, "max_output_tokens", "max_completion_tokens", "max_tokens"));
  if (direct !== undefined) return direct;
  // OpenRouter nests it under top_provider.
  const top = entry.top_provider;
  if (typeof top === "object" && top !== null) {
    return asPositiveInt(pick(top as Record<string, unknown>, "max_completion_tokens", "max_output_tokens"));
  }
  return undefined;
}

/**
 * Image support, when the gateway says so. OpenRouter exposes
 * `architecture.input_modalities: ["text","image"]` (older builds:
 * `architecture.modality: "text+image->text"`). Undefined when unknown — the
 * import then leaves vision off, which is the safe direction: an unmarked
 * vision model is merely excluded from image routing, whereas a wrongly-marked
 * one takes image traffic it cannot serve.
 */
function extractVision(entry: Record<string, unknown>): boolean | undefined {
  const arch = entry.architecture;
  if (typeof arch !== "object" || arch === null) return undefined;
  const a = arch as Record<string, unknown>;
  const modalities = a.input_modalities;
  if (Array.isArray(modalities)) {
    return modalities.some((m) => typeof m === "string" && m.toLowerCase() === "image");
  }
  if (typeof a.modality === "string") return /image/i.test(a.modality.split("->")[0] ?? "");
  return undefined;
}

/** True when the Anthropic capability tree marks a leaf supported. */
function capabilitySupported(capabilities: unknown, ...keyPath: string[]): boolean | undefined {
  let node: unknown = capabilities;
  for (const key of keyPath) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node !== "object" || node === null) return undefined;
  const supported = (node as Record<string, unknown>).supported;
  return typeof supported === "boolean" ? supported : undefined;
}

/**
 * Parse an OpenAI-compatible `{object:"list", data:[{id, owned_by}]}` body.
 * Entries without a usable `id` are skipped rather than erroring — a single
 * malformed row must not lose the operator the whole listing.
 */
export function parseOpenAiModelList(body: unknown): ListedModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: ListedModel[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    const displayName = typeof entry.name === "string" ? entry.name.trim() : "";
    // Always inherit — the provider speaks chat-completions and we cannot tell
    // from the listing whether this particular model is an exception.
    out.push({
      id,
      ...(displayName && displayName !== id ? { name: displayName } : {}),
      suggested_api_type: "",
      ...(looksLikeClaudeModel(id, entry.owned_by) ? { protocol_hint: "claude" as const } : {}),
      context_window: extractContextWindow(entry),
      max_tokens: extractMaxTokens(entry),
      vision: extractVision(entry),
    });
  }
  return out;
}

/**
 * Parse Anthropic's native `{data:[{id, display_name, max_input_tokens,
 * max_tokens, capabilities}]}` body. The extra fields are best-effort: older
 * API versions predate max_input_tokens/capabilities entirely.
 */
export function parseAnthropicModelList(body: unknown): ListedModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: ListedModel[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    const displayName = typeof entry.display_name === "string" ? entry.display_name.trim() : "";
    out.push({
      id,
      ...(displayName ? { name: displayName } : {}),
      // Inherit, even though this endpoint is definitionally Anthropic-protocol:
      // writing an override equal to the provider's own value would pin these
      // rows if the provider is later repointed at a different gateway, while
      // a manually-added sibling would follow. Inheritance is the same
      // behaviour today and the correct one tomorrow.
      suggested_api_type: "",
      context_window: asPositiveInt(entry.max_input_tokens),
      max_tokens: asPositiveInt(entry.max_tokens),
      vision: capabilitySupported(entry.capabilities, "image_input"),
      reasoning: capabilitySupported(entry.capabilities, "thinking"),
    });
  }
  return out;
}

/**
 * SSRF guard for provider listing. Same literal-address denylist the tracing
 * exporter probe uses, with loopback permitted: `http://localhost:11434/v1`
 * (Ollama) is a legitimate provider base_url and the runtime already dials that
 * exact host for chat/completions, so proxying one GET does not widen the
 * attack surface — and only an admin can set base_url. Cloud metadata
 * (169.254.0.0/16, fe80::/10) stays blocked in every literal spelling.
 */
export function providerFetchSsrfGuard(rawUrl: string): { ok: boolean; error?: string } {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid base URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `Unsupported protocol: ${u.protocol} (only http/https)` };
  }
  const host = u.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (isBlockedIpLiteral(host, { allowLoopback: true })) {
    return { ok: false, error: `Blocked host (link-local/metadata): ${host}` };
  }
  return { ok: true };
}

/**
 * `{base_url}/models`, matching how the runtime builds
 * `{base_url}/chat/completions`.
 *
 * The Anthropic listing paginates with a default page size of 20 and a maximum
 * of 1000 — without an explicit limit a provider with more than 20 models is
 * silently truncated, with nothing in the response telling the operator that
 * the newest models are missing. The OpenAI shape is unpaginated and ignores
 * the parameter.
 */
export function buildModelListUrl(baseUrl: string, api?: string): string {
  const base = `${baseUrl.replace(/\/+$/, "")}/models`;
  return api === "anthropic-messages" ? `${base}?limit=1000` : base;
}

/**
 * Accept an api id only if it looks like one. Deliberately NOT an enum: pi
 * registers new api ids (openai-responses, …) and siclaw must not need a
 * release to use them. But an unconstrained string reaches pi's registry
 * verbatim and only fails at turn time with "No API provider registered for
 * api: …" — the very error this whole change exists to remove — and anything
 * over 50 chars overflows the column mid-transaction.
 */
export function isValidApiType(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,49}$/.test(value);
}
