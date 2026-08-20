import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import type { ProviderModelCompat } from "./config.js";

export interface ProviderCompatInput {
  api?: string | null;
  baseUrl?: string | null;
}

/** Raw `model_entries` row shape needed to build a model descriptor. */
export interface ProviderModelRow {
  model_id: string;
  name?: string | null;
  reasoning?: unknown;
  vision?: unknown;
  context_window: number;
  max_tokens: number;
  /** Wire protocol this model speaks. Required; see `resolveModelApi`. */
  api_type?: string | null;
  /** Explicit `maxTokensField` override; NULL/empty = infer. */
  max_tokens_field?: string | null;
  /**
   * Per-model compat overrides as JSON text; NULL = resolve automatically.
   * The escape hatch for a model whose id neither pi's table nor the generation
   * rule reads correctly — see `resolveAnthropicCompat`.
   */
  compat_overrides?: string | null;
}

/**
 * The per-MODEL half of compat resolution.
 *
 * `compat` describes the wire shape of a request, and wire shape is a property
 * of the model, not of the endpoint it happens to be served from: one gateway
 * serves gpt-5 (which rejects `max_tokens`) next to DeepSeek (which requires
 * it). Every caller must therefore say which model it is building for.
 */
export interface ModelCompatInput {
  id: string;
  maxTokensField?: string | null;
  /** Persisted per-model compat overrides (JSON text or object); highest priority. */
  compatOverrides?: unknown;
}

/** The two field names pi can emit — see MaxTokensField below. */
export type MaxTokensField = "max_tokens" | "max_completion_tokens";

export function isValidMaxTokensField(value: unknown): value is MaxTokensField {
  return value === "max_tokens" || value === "max_completion_tokens";
}

/**
 * Whether `modelId` names an OpenAI reasoning family, which rejects the legacy
 * `max_tokens` field and requires `max_completion_tokens`.
 *
 * Same shape as sicore's `isReasoningModel` (sicore/pkg/llm/openai.go), which
 * was added after the identical 400 from the same gateway. This is a NAMING
 * CONVENTION, so it is only the fallback: an explicit `max_tokens_field` on the
 * model row always wins, which is what covers renamed ids on aggregator
 * gateways and families that ship after this code does.
 */
export function looksLikeOpenAiReasoningModel(modelId: string): boolean {
  let id = modelId.trim().toLowerCase();
  // Aggregators namespace ids as `vendor/model`; judge on the model part.
  const slash = id.lastIndexOf("/");
  if (slash >= 0) id = id.slice(slash + 1);
  id = id.replaceAll("-", "");
  return id.startsWith("gpt5") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4");
}

/**
 * Decide which request field carries the output-token cap for one model.
 *
 * Validation is a strict WHITELIST rather than the passthrough used for
 * provider api ids. pi types this field as a two-member union
 * (`pi-coding-agent` model-registry: `Type.Union([max_completion_tokens,
 * max_tokens])`), so an unrecognised value doesn't degrade — it fails the
 * provider's schema and drops the model out of the registry entirely, which
 * surfaces as "model not found" rather than as a field error.
 */
export function resolveMaxTokensField(
  model: ModelCompatInput,
  provider: ProviderCompatInput,
): MaxTokensField {
  const explicit = (model.maxTokensField ?? "").trim();
  if (isValidMaxTokensField(explicit)) return explicit;

  // Anthropic's messages API always names the field `max_tokens`, and pi's
  // anthropic path ignores this setting entirely — never infer a switch there.
  if (!usesChatCompletions(provider) || !looksLikeOpenAiReasoningModel(model.id)) return "max_tokens";
  return "max_completion_tokens";
}

/** Build the model half of a compat input from a raw `model_entries` row. */
export function modelCompatInputFromRow(row: ProviderModelRow): ModelCompatInput {
  return {
    id: row.model_id,
    maxTokensField: row.max_tokens_field,
    compatOverrides: row.compat_overrides,
  };
}

/**
 * Judged on the RESOLVED api. Callers pass the model's own protocol (see
 * `buildProviderModelDescriptor`), so on a mixed gateway this answers per model
 * rather than per endpoint.
 */
function usesChatCompletions(provider: ProviderCompatInput): boolean {
  return normalizeProviderApi(provider.api) === "openai-completions";
}

/**
 * Map legacy provider api names to the pi-ai API-provider registry's canonical
 * ids. pi looks a model's `api` up in its registry verbatim ("anthropic" is a
 * provider slug there, not an api — only "anthropic-messages" is registered),
 * so any legacy value reaching a model config fails the whole turn with
 * "No API provider registered for api: …". Portal DB rows and settings.json
 * written before this mapping existed carry the legacy names; normalizing at
 * read time keeps them working without a data migration.
 */
const LEGACY_API_ALIASES: Record<string, string> = {
  anthropic: "anthropic-messages",
  openai: "openai-completions",
};

export function normalizeProviderApi(api: string | null | undefined): string {
  const raw = (api ?? "").trim();
  if (!raw) return "openai-completions";
  return LEGACY_API_ALIASES[raw.toLowerCase()] ?? raw;
}

/**
 * What to store in `model_entries.max_tokens` when nobody supplied a real value
 * — neither the operator nor the provider's own `/models` listing.
 *
 * The previous default, 65536, is above the real ceiling of models that are in
 * use: pi's own Anthropic table puts claude-haiku-4-5, claude-opus-4-5 and
 * claude-sonnet-4-5 at 64000. On the Claude protocol pi sends this value
 * verbatim as `max_tokens`, and Anthropic rejects a request that exceeds the
 * model's ceiling rather than clamping it — so the default that is meant to keep
 * a request valid was what made it invalid.
 *
 * This is pi's own number, deliberately: when pi builds a model from a config
 * file it applies `modelDef.maxTokens ?? 16384` (and `contextWindow ?? 128000`,
 * which is where this table's context_window default already comes from). Its
 * dynamic `registerProvider` path — the one every Portal-managed provider takes
 * — passes the field through without that default, which is separately how an
 * absent value reaches the Claude protocol as no `max_tokens` at all.
 *
 * Matching the number rather than picking our own means an unset field behaves
 * exactly as it would have on pi's other path, and there is one value to keep in
 * sync instead of a per-protocol table of our own invention. The cost is real
 * and accepted: a model whose true ceiling is 128000 is held to 16384 until
 * someone fills the field in — a truncated answer, not a failed turn.
 *
 * A real value always beats this, so writers should read the provider listing
 * first (see `provider-model-listing.ts`) and reach for this only as the floor.
 */
export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_CONTEXT_WINDOW = 128000;

// ── Anthropic-protocol compat ────────────────────────────────────────────────

/**
 * The compat keys we resolve for the Anthropic protocol.
 *
 * A WHITELIST at both ends. Reading: an override naming anything else is
 * ignored, so a typo cannot reach pi. Writing: only these are emitted, so this
 * never becomes a passthrough for whatever a control plane invents.
 */
export const ANTHROPIC_COMPAT_KEYS = ["forceAdaptiveThinking", "supportsTemperature"] as const;
export type AnthropicCompatKey = (typeof ANTHROPIC_COMPAT_KEYS)[number];
export type AnthropicCompat = Partial<Record<AnthropicCompatKey, boolean>>;

/**
 * What to assume for a model id pi's bundled table does not know.
 *
 * **Deliberately the opposite of pi's own defaults** (`forceAdaptiveThinking`
 * false, `supportsTemperature` true). pi's defaults are the backward-compatible
 * choice for a hand-written config file that may predate any of this; what
 * arrives here is a LIVE model id a control plane just bound, and the two
 * populations fail in opposite directions:
 *
 *   - pi's table is a release snapshot, so it necessarily lags the API. The lag
 *     window is exactly when a model is newly launched — the moment an operator
 *     is most likely to add it. Defaulting to the legacy shape there fails on
 *     day one, which is what produced the `claude-opus-5` 400: pi 0.80.7 knows
 *     14 claude ids and that is not one of them.
 *   - the set of models REQUIRING adaptive is open and growing; the set that
 *     only accepts the legacy shape is closed and shrinking.
 *
 * The residual risk is the inverse: a pre-4.6 model renamed by an aggregator so
 * neither the table nor the generation rule below recognises it would be sent
 * adaptive and 400 the other way. That is what `compat_overrides` is for — and
 * why this is a default, not a hardcoded answer.
 */
const LATEST_ANTHROPIC_COMPAT: Required<AnthropicCompat> = {
  forceAdaptiveThinking: true,
  supportsTemperature: false,
};

/** Explicit legacy shape, for an id whose generation is known to predate 4.6. */
const LEGACY_ANTHROPIC_COMPAT: Required<AnthropicCompat> = {
  forceAdaptiveThinking: false,
  supportsTemperature: true,
};

/** First Claude generation whose API requires adaptive thinking. */
const ADAPTIVE_THINKING_SINCE = { major: 4, minor: 6 };

/** Strip an aggregator's `vendor/` namespace, as `looksLikeOpenAiReasoningModel` does. */
function bareModelId(modelId: string): string {
  const id = modelId.trim().toLowerCase();
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * pi's own answer for this model, if its bundled table has one — the authority,
 * and the reason this is a lookup rather than a table of ours. Also covers the
 * legacy models whose entry has NO compat at all: absent means pi's defaults,
 * which for them are correct, so a miss here is not the same as "unknown".
 */
export function builtinAnthropicCompat(modelId: string): AnthropicCompat | undefined {
  const table = ANTHROPIC_MODELS as Record<string, { compat?: Record<string, unknown> } | undefined>;
  const entry = table[modelId.trim()] ?? table[bareModelId(modelId)];
  if (!entry) return undefined;
  return pickAnthropicCompat(entry.compat ?? {});
}

/**
 * Whether an id names a Claude generation older than adaptive thinking.
 *
 * A generation RULE, not a model list: `claude-sonnet-4-5` and
 * `claude-3-7-sonnet` are legacy, `claude-opus-4-6` and `claude-opus-5` are not,
 * and nothing has to be added here when a new model ships. That is the whole
 * point — mirroring pi's per-model table is what we are avoiding.
 *
 * Only a CONFIDENT read counts. An id with no recognisable generation returns
 * false and takes the latest-generation default, because "I cannot tell" must
 * not be answered with "then assume the shape that is being retired".
 */
export function looksLikeLegacyAnthropicThinking(modelId: string): boolean {
  const id = bareModelId(modelId);
  if (!id.includes("claude")) return false;
  // claude-2, claude-instant-*: unambiguously pre-adaptive.
  if (/(^|[^0-9])claude-(2|instant)([^0-9]|$)/.test(id)) return true;
  // Generation digits, either order: claude-3-7-sonnet / claude-sonnet-4-5.
  const match = /claude-(?:[a-z]+-)?(\d+)(?:-(\d+))?/.exec(id);
  if (!match) return false;
  const major = Number(match[1]);
  if (!Number.isFinite(major)) return false;
  if (major !== ADAPTIVE_THINKING_SINCE.major) return major < ADAPTIVE_THINKING_SINCE.major;
  // Same major: a MISSING minor means .0, not "unknown". `claude-opus-4` and
  // `claude-sonnet-4` are real ids, are pre-adaptive, and are absent from pi's
  // 0.80.7 table — reading them as the current generation would force adaptive
  // and 400 them in the opposite direction.
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isFinite(minor)) return false;
  return minor < ADAPTIVE_THINKING_SINCE.minor;
}

function pickAnthropicCompat(source: Record<string, unknown>): AnthropicCompat {
  const out: AnthropicCompat = {};
  for (const key of ANTHROPIC_COMPAT_KEYS) {
    if (typeof source[key] === "boolean") out[key] = source[key] as boolean;
  }
  return out;
}

/**
 * Parse a persisted `compat_overrides` value. Unknown keys and non-booleans are
 * dropped rather than rejected: this is a read path, and a value written by a
 * newer build must not take a model out of service here.
 */
export function parseAnthropicCompatOverrides(raw: unknown): AnthropicCompat {
  if (raw === null || raw === undefined || raw === "") return {};
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return {}; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return pickAnthropicCompat(value as Record<string, unknown>);
}

/**
 * Resolve the Anthropic-protocol compat for one model, in priority order:
 *
 *   1. the operator's per-model override — always wins, and is the documented
 *      way to opt out (pi's own docstring: "Set to `false` to opt out");
 *   2. pi's bundled table — authoritative where it has an answer;
 *   3. a generation rule, then the latest-generation default.
 *
 * Only keys not answered by a higher priority fall through, so an override of
 * one key does not discard pi's answer for the other.
 */
export function resolveAnthropicCompat(modelId: string, overrides?: unknown): Required<AnthropicCompat> {
  const explicit = parseAnthropicCompatOverrides(overrides);
  const builtin = builtinAnthropicCompat(modelId);
  const base = builtin
    ? { ...LEGACY_ANTHROPIC_COMPAT, ...builtin }
    : looksLikeLegacyAnthropicThinking(modelId) ? LEGACY_ANTHROPIC_COMPAT : LATEST_ANTHROPIC_COMPAT;
  return { ...base, ...explicit };
}

function usesAnthropicMessages(provider: ProviderCompatInput): boolean {
  return normalizeProviderApi(provider.api) === "anthropic-messages";
}

/**
 * Fill in the Anthropic compat keys a provider CONFIG left unstated, per model.
 *
 * `buildProviderModelDescriptor` only covers configs this repo assembles from
 * `model_entries`. A control plane that answers `config.getModelBinding` itself
 * supplies the whole `modelConfig` — compat included — and the runtime forwards
 * it verbatim, so none of that function runs on the path most production traffic
 * takes. That is not a hypothetical split: it is why the same
 * `"thinking.type.enabled" is not supported` 400 survived being "fixed" in the
 * descriptor, and why `maxTokensField` had to be fixed twice, once on each side.
 *
 * So the resolution happens again HERE, at the last point both paths share
 * before pi is handed the config. Only keys the config does not state are
 * filled: an explicit value — including `false` — is the caller's decision and
 * always wins, which is exactly what pi's own docstring documents `false` for.
 *
 * Returns a copy; the caller's object belongs to the control plane and is not
 * ours to mutate.
 */
export function withResolvedModelCompat<T>(config: T): T {
  if (!config || typeof config !== "object") return config;
  const cfg = config as unknown as Record<string, unknown>;
  const models = cfg.models;
  if (!Array.isArray(models)) return config;
  const providerApi = typeof cfg.api === "string" ? cfg.api : undefined;
  let changed = false;
  const nextModels = models.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const model = entry as Record<string, unknown>;
    const id = typeof model.id === "string" ? model.id : "";
    if (!id) return entry;
    const api = normalizeProviderApi(typeof model.api === "string" ? model.api : providerApi);
    if (api !== "anthropic-messages") return entry;
    const stated = (model.compat && typeof model.compat === "object" && !Array.isArray(model.compat)
      ? model.compat
      : {}) as Record<string, unknown>;
    const resolved = resolveAnthropicCompat(id);
    const merged: Record<string, unknown> = { ...stated };
    let touched = false;
    for (const key of ANTHROPIC_COMPAT_KEYS) {
      if (typeof stated[key] === "boolean") continue;
      merged[key] = resolved[key];
      touched = true;
    }
    if (!touched) return entry;
    changed = true;
    return { ...model, compat: merged };
  });
  if (!changed) return config;
  return { ...cfg, models: nextModels } as unknown as T;
}

/**
 * The wire protocol a model speaks.
 *
 * This is a PER-MODEL attribute — one endpoint can serve OpenAI-protocol and
 * Claude-protocol models side by side, so there is no meaningful provider-wide
 * answer and `model_entries.api_type` is required. `provider.api` remains only
 * as a read-time floor for rows written before the column was backfilled (a
 * legacy SQLite file, where the NOT NULL tightening is a no-op).
 */
export function resolveModelApi(
  row: ProviderModelRow,
  provider: ProviderCompatInput,
): string {
  return normalizeProviderApi((row.api_type ?? "").trim() || provider.api);
}


function isOfficialOpenAIBaseUrl(baseUrl?: string | null): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * `model` is REQUIRED, not optional. `maxTokensField` was a per-provider
 * constant for most of this repo's life, which is exactly how a per-model
 * attribute ended up hardcoded: the function that decided it could not see
 * which model it was deciding for. Making the parameter mandatory turns a new
 * call site that hasn't thought about it into a compile error.
 */
export function defaultProviderModelCompat(
  provider: ProviderCompatInput,
  model: ModelCompatInput,
): Required<
  Pick<ProviderModelCompat, "supportsDeveloperRole" | "supportsUsageInStreaming" | "maxTokensField">
> & AnthropicCompat {
  return {
    supportsDeveloperRole: usesChatCompletions(provider) && isOfficialOpenAIBaseUrl(provider.baseUrl),
    supportsUsageInStreaming: true,
    // Always emitted, never omitted: omitting hands the decision back to pi's
    // own base-URL heuristic, and this value is precisely what we mean to state
    // explicitly.
    maxTokensField: resolveMaxTokensField(model, provider),
    // Protocol-scoped: pi reads both of these ONLY on the anthropic-messages
    // path, so emitting them elsewhere is noise that also invites the wrong
    // question of them ("does this OpenAI model support temperature?").
    ...(usesAnthropicMessages(provider) ? resolveAnthropicCompat(model.id, model.compatOverrides) : {}),
  };
}

/**
 * Build a single `ProviderModelConfig` descriptor from a `model_entries` row.
 *
 * This is the SINGLE place that translates the persisted `vision` boolean into
 * the runtime `input` capability list, and the single place that resolves a
 * model's wire protocol. Keeping it centralized prevents the
 * descriptor-construction drift that hardcoded `input: ["text"]` causes across
 * the (6+) production paths that hydrate model bindings — a vision model whose
 * `input` was missed would have its image request silently filtered by
 * model-routing's `filterCandidatesForPromptMedia`.
 *
 * `api` is ALWAYS emitted. pi would fall back to the provider's value if the
 * key were absent, but protocol is a per-model property here, so stating it
 * explicitly is what keeps the two layers from disagreeing — and it means
 * nothing downstream has to reason about which layer won.
 *
 * `compat` derives from that same api: compat describes the wire protocol
 * (`supportsDeveloperRole` keys off chat-completions, `maxTokensField` is
 * protocol-shaped), so it is per-model for the same reason.
 */
export function buildProviderModelDescriptor(
  row: ProviderModelRow,
  provider: ProviderCompatInput,
) {
  const api = resolveModelApi(row, provider);
  return {
    id: row.model_id,
    name: row.name ?? row.model_id,
    api,
    reasoning: !!row.reasoning,
    input: (row.vision ? ["text", "image"] : ["text"]) as string[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: row.context_window,
    maxTokens: row.max_tokens,
    // `api` (already resolved per-model), not `provider.api`: every compat
    // field describes the wire protocol, so both halves must agree on which
    // protocol this particular model speaks.
    compat: defaultProviderModelCompat({ api, baseUrl: provider.baseUrl }, modelCompatInputFromRow(row)),
  };
}
