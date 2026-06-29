import type { BrainModelInfo, BrainProviderResponse, BrainSession, PromptMedia } from "./brain-session.js";

export type ModelRouteFailureKind =
  | "billing"
  | "rate_limit"
  | "timeout"
  | "overloaded"
  | "server_error"
  | "model_not_found"
  | "network"
  | "empty_response"
  | "context_overflow"
  | "user_abort"
  | "content_policy"
  | "tool_error"
  | "auth"
  | "format_error"
  | "unknown";

export type ModelRouteCooldownMsByKind = Partial<Record<ModelRouteFailureKind, number>>;
export type ModelRouteFallbackBlockedReason = "tool_execution";

export interface ModelRouteCandidate {
  provider: string;
  modelId: string;
  label?: string;
  modelConfig?: Record<string, unknown>;
}

export interface ModelRoutePolicy {
  enabled?: boolean;
  strategy?: "ordered_fallback";
  candidates?: ModelRouteCandidate[];
  cooldownMsByKind?: ModelRouteCooldownMsByKind;
  fallbackOn?: ModelRouteFailureKind[];
  noFallbackOn?: ModelRouteFailureKind[];
}

export interface ModelRouteAttempt {
  attempt: number;
  candidateKey: string;
  provider: string;
  modelId: string;
  startedAt: number;
  finishedAt?: number;
  success?: boolean;
  failureKind?: ModelRouteFailureKind;
  failureSource?: "prompt_error" | "message_end" | "setup";
  fallbackBlockedReason?: ModelRouteFallbackBlockedReason;
  errorMessage?: string;
}

export interface ModelRouteState {
  activeCandidateKey?: string;
  activeCandidateSource?: "auto" | "user";
  cooldowns: Record<string, number>;
  attempts: ModelRouteAttempt[];
  lastSwitchReason?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

export type ModelRouteEvent =
  | {
      type: "model_route_start";
      strategy: "ordered_fallback";
      candidateCount: number;
      activeCandidateKey?: string;
      primaryCandidateKey: string;
      primaryProvider: string;
      primaryModelId: string;
    }
  | {
      type: "model_route_attempt";
      attempt: number;
      candidateKey: string;
      provider: string;
      modelId: string;
      status: "started" | "failed";
      failureKind?: ModelRouteFailureKind;
      fallbackBlockedReason?: ModelRouteFallbackBlockedReason;
      errorMessage?: string;
    }
  | {
      type: "model_route_switch";
      attempt: number;
      fromCandidateKey: string;
      toCandidateKey: string;
      fromProvider: string;
      fromModelId: string;
      toProvider: string;
      toModelId: string;
      failureKind: ModelRouteFailureKind;
      errorMessage?: string;
      cooldownUntil?: number;
    }
  | {
      type: "model_route_success";
      attempt: number;
      candidateKey: string;
      provider: string;
      modelId: string;
      isFallback: boolean;
      primaryCandidateKey: string;
      recoveredFromCandidateKey?: string;
      recoveredFromProvider?: string;
      recoveredFromModelId?: string;
    }
  | {
      type: "model_route_exhausted";
      attempt: number;
      candidateKey?: string;
      failureKind?: ModelRouteFailureKind;
      fallbackBlockedReason?: ModelRouteFallbackBlockedReason;
      errorMessage?: string;
    }
  | {
      type: "model_route_aborted";
      attempt: number;
      candidateKey?: string;
      errorMessage?: string;
    }
  | {
      // The primary candidate streamed live and then failed — tell consumers to
      // discard whatever this attempt already rendered/buffered before the next
      // candidate streams in. Only emitted when the failed attempt actually
      // emitted visible output (a setup failure before the first token emits
      // nothing, so no rollback is needed).
      type: "model_route_rollback";
      attempt: number;
      candidateKey: string;
      failureKind: ModelRouteFailureKind;
    };

export interface ModelRouteRunResult {
  success: boolean;
  exhausted: boolean;
  attempted: ModelRouteAttempt[];
  activeCandidateKey?: string;
  finalFailureKind?: ModelRouteFailureKind;
  finalErrorMessage?: string;
}

export interface RunPromptWithModelRoutingOptions {
  emitEvent?: (event: ModelRouteEvent) => void;
  emitBrainEvent?: (event: unknown) => void;
  onStateChange?: (state: ModelRouteState) => void;
  /** Polled between attempts so a user Stop landing in the switch window halts the chain. */
  shouldAbort?: () => boolean;
  /**
   * Stream the primary candidate's events live (vs. buffering every attempt
   * until it wins). Defaults to true — an interactive turn should feel like no
   * routing at all on the happy path, with a model_route_rollback recovering a
   * failed live primary. Set false for background/synthetic turns that have no
   * live viewer and persist by collecting brain events: there, a live failed
   * attempt would leak into the persisted turn, and buffering costs nothing.
   */
  optimisticPrimaryStream?: boolean;
  now?: () => number;
}

interface AttemptFailure {
  kind: ModelRouteFailureKind;
  source: ModelRouteAttempt["failureSource"];
  message?: string;
  thrown?: unknown;
  providerResponse?: BrainProviderResponse;
}

interface AssistantMessageLike {
  role?: string;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  provider?: unknown;
  model?: unknown;
  diagnostics?: unknown;
}

export interface ModelRouteFailureSignal {
  errorMessage?: string;
  stopReason?: string;
  provider?: string;
  modelId?: string;
  status?: number;
  headers?: Record<string, string>;
  diagnostics?: unknown;
}

interface AttemptResult {
  failure: AttemptFailure | null;
  checkpoint: unknown;
  events: unknown[];
  hadToolExecution: boolean;
  // True when this attempt emitted at least one brain event live (rather than
  // buffering it). A live attempt that then fails needs a rollback so the next
  // candidate doesn't stack its output on top of the failed one's.
  emittedLive: boolean;
}

const ATTEMPT_HISTORY_LIMIT = 20;
const HEADER_COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000;

const DEFAULT_COOLDOWN_MS_BY_KIND: Record<ModelRouteFailureKind, number> = {
  billing: 60 * 60 * 1000,
  rate_limit: 60 * 1000,
  timeout: 2 * 60 * 1000,
  overloaded: 60 * 1000,
  server_error: 2 * 60 * 1000,
  model_not_found: 10 * 60 * 1000,
  network: 2 * 60 * 1000,
  empty_response: 30 * 1000,
  context_overflow: 0,
  user_abort: 0,
  content_policy: 0,
  tool_error: 0,
  auth: 0,
  format_error: 0,
  unknown: 0,
};

const DEFAULT_FALLBACK_ON = new Set<ModelRouteFailureKind>([
  "billing",
  "rate_limit",
  "timeout",
  "overloaded",
  "server_error",
  "model_not_found",
  "network",
  "empty_response",
]);

const DEFAULT_NO_FALLBACK_ON = new Set<ModelRouteFailureKind>([
  "context_overflow",
  "user_abort",
  "content_policy",
  "tool_error",
  "auth",
  "format_error",
  "unknown",
]);

export function candidateKey(candidate: Pick<ModelRouteCandidate, "provider" | "modelId">): string {
  return `${encodeURIComponent(candidate.provider)}/${encodeURIComponent(candidate.modelId)}`;
}

export function createModelRouteState(): ModelRouteState {
  return { cooldowns: {}, attempts: [] };
}

export function normalizeModelRouteState(value: unknown): ModelRouteState {
  if (!isRecord(value)) return createModelRouteState();
  const cooldowns = isRecord(value.cooldowns)
    ? Object.fromEntries(
        Object.entries(value.cooldowns)
          .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
      )
    : {};
  const attempts = Array.isArray(value.attempts)
    ? value.attempts
        .filter(isRecord)
        .map((attempt) => normalizeAttempt(attempt))
        .filter((attempt): attempt is ModelRouteAttempt => attempt !== null)
        .slice(-ATTEMPT_HISTORY_LIMIT)
    : [];
  return {
    activeCandidateKey: typeof value.activeCandidateKey === "string" ? value.activeCandidateKey : undefined,
    activeCandidateSource: value.activeCandidateSource === "auto" || value.activeCandidateSource === "user"
      ? value.activeCandidateSource
      : undefined,
    cooldowns,
    attempts,
    lastSwitchReason: typeof value.lastSwitchReason === "string" ? value.lastSwitchReason : undefined,
    lastSuccessAt: typeof value.lastSuccessAt === "number" ? value.lastSuccessAt : undefined,
    lastFailureAt: typeof value.lastFailureAt === "number" ? value.lastFailureAt : undefined,
  };
}

export function isModelRoutePolicyEnabled(policy: unknown): policy is ModelRoutePolicy {
  if (!isRecord(policy)) return false;
  if (policy.enabled !== true) return false;
  if (policy.strategy && policy.strategy !== "ordered_fallback") return false;
  return normalizeCandidates(policy.candidates).length > 0;
}

export function shouldUseModelRouteRunner(policy: unknown, state: ModelRouteState): policy is ModelRoutePolicy {
  if (!isModelRoutePolicyEnabled(policy)) return false;
  return normalizeCandidates(policy.candidates).length > 1 && state.activeCandidateSource !== "user";
}

/**
 * Resolve the policy actually handed to {@link runPromptWithModelRouting} so that
 * EVERY prompt flows through one entry (no separate `brain.prompt()` path).
 *
 * - Real multi-candidate routing (`shouldUseModelRouteRunner`) → the configured
 *   policy, unchanged.
 * - Otherwise (routing off, single candidate, or a user-pinned model) → a
 *   single-candidate policy built from the CURRENT model. The runner then streams
 *   that one candidate live (optimistic primary), never falls back, and still
 *   emits `model_route_start` + `model_route_success(isFallback:false)` — so every
 *   turn carries its model identity on one event channel for downstream
 *   collection, while the UX is identical to a bare prompt.
 *
 * The single candidate intentionally omits `modelConfig`: the model is already
 * pinned by the caller's setup, so `runAttempt`'s `modelNeedsUpdate` guard skips
 * a redundant `setModel` (which would otherwise drop applied runtime params).
 *
 * Returns `undefined` only when there is no current model — the runner's own
 * guard then falls back to a bare `brain.prompt`.
 */
export function resolveEffectivePolicy(
  configured: ModelRoutePolicy | undefined,
  state: ModelRouteState,
  currentModel: { provider: string; id: string } | undefined,
): ModelRoutePolicy | undefined {
  if (shouldUseModelRouteRunner(configured, state)) return configured;
  if (!currentModel) return undefined;
  return {
    enabled: true,
    strategy: "ordered_fallback",
    candidates: [{ provider: currentModel.provider, modelId: currentModel.id }],
  };
}

export function normalizeModelRoutePolicy(policy: unknown): ModelRoutePolicy | undefined {
  if (!isRecord(policy)) return undefined;
  if (policy.enabled !== true && policy.enabled !== false) return undefined;

  const candidates = normalizeCandidates(policy.candidates);
  if (policy.enabled === true && candidates.length === 0) return undefined;

  const normalized: ModelRoutePolicy = {
    enabled: policy.enabled,
    strategy: "ordered_fallback",
  };
  if (candidates.length > 0) normalized.candidates = candidates;
  const cooldownMsByKind = normalizeCooldownMsByKind(policy.cooldownMsByKind);
  if (Object.keys(cooldownMsByKind).length > 0) normalized.cooldownMsByKind = cooldownMsByKind;
  const fallbackOn = normalizeFailureKinds(policy.fallbackOn);
  if (fallbackOn.length > 0) normalized.fallbackOn = fallbackOn;
  const noFallbackOn = normalizeFailureKinds(policy.noFallbackOn);
  if (noFallbackOn.length > 0) normalized.noFallbackOn = noFallbackOn;
  return normalized;
}

export function normalizeCandidates(candidates: unknown): ModelRouteCandidate[] {
  if (!Array.isArray(candidates)) return [];
  const seen = new Set<string>();
  const normalized: ModelRouteCandidate[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate.provider !== "string" || candidate.provider.trim() === "") continue;
    if (typeof candidate.modelId !== "string" || candidate.modelId.trim() === "") continue;
    const next: ModelRouteCandidate = {
      provider: candidate.provider.trim(),
      modelId: candidate.modelId.trim(),
      label: typeof candidate.label === "string" ? candidate.label : undefined,
      modelConfig: isRecord(candidate.modelConfig) ? candidate.modelConfig : undefined,
    };
    const key = candidateKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(next);
  }
  return normalized;
}

function candidateInputSet(candidate: ModelRouteCandidate): Set<string> {
  const models = candidate.modelConfig?.models;
  if (!Array.isArray(models)) return new Set();
  const exactModel = models.find((model) => isRecord(model) && model.id === candidate.modelId);
  const model = exactModel ?? models.find(isRecord);
  if (!isRecord(model) || !Array.isArray(model.input)) return new Set();
  return new Set(model.input.filter((input): input is string => typeof input === "string"));
}

export function requiredInputsForPromptMedia(media?: PromptMedia): string[] {
  const required: string[] = [];
  if (media?.images && media.images.length > 0) required.push("image");
  if (media?.files && media.files.length > 0) required.push("pdf");
  return required;
}

export function candidateSupportsPromptMedia(candidate: ModelRouteCandidate, media?: PromptMedia): boolean {
  const required = requiredInputsForPromptMedia(media);
  if (required.length === 0) return true;
  const inputs = candidateInputSet(candidate);
  return required.every((input) => inputs.has(input));
}

export function filterCandidatesForPromptMedia(candidates: ModelRouteCandidate[], media?: PromptMedia): ModelRouteCandidate[] {
  const required = requiredInputsForPromptMedia(media);
  if (required.length === 0) return candidates;
  return candidates.filter((candidate) => candidateSupportsPromptMedia(candidate, media));
}

/**
 * Does the model selected for this prompt declare `image` input support? Used by
 * `AgentBoxClient` to gate text-URL image resolution: only resolve URLs into
 * vision images when a capable model exists; otherwise leave the URL as plain
 * text (no fail-closed).
 *
 * Enabled routing: image-capable if ANY candidate declares image — in the
 * fallback-runner path, media filtering routes a turn-with-images only to such a
 * candidate. NOTE: this is an OPTIMISTIC, gateway-side guess; it cannot see the
 * session's user-pinned candidate (held in the AgentBox modelRouteState), so a
 * pinned text-primary + vision-fallback turn can still reach the single-model
 * preflight and fail closed (documented residual edge — see DESIGN risk table).
 * Disabled routing: candidates won't be used → judge by the single model + its
 * modelConfig instead.
 * No model info: conservatively false (do not resolve URLs).
 */
export function modelOptionsSupportImageInput(opts: {
  modelProvider?: string;
  modelId?: string;
  modelConfig?: unknown;
  modelRouting?: ModelRoutePolicy;
}): boolean {
  const candidates = isModelRoutePolicyEnabled(opts.modelRouting)
    ? normalizeCandidates(opts.modelRouting?.candidates)
    : [];
  if (candidates.length > 0) {
    return candidates.some((candidate) => candidateInputSet(candidate).has("image"));
  }
  if (opts.modelProvider && opts.modelId && isRecord(opts.modelConfig)) {
    return candidateInputSet({
      provider: opts.modelProvider,
      modelId: opts.modelId,
      modelConfig: opts.modelConfig,
    }).has("image");
  }
  return false;
}

export function unsupportedPromptMediaMessage(media?: PromptMedia): string {
  const required = requiredInputsForPromptMedia(media);
  if (required.length === 0) return "No model route candidate is available for this prompt.";
  return `No ${required.join("+")}-capable model route candidate is available for this input.`;
}

export function markModelRouteUserSelection(
  state: ModelRouteState,
  candidate: Pick<ModelRouteCandidate, "provider" | "modelId">,
): void {
  state.activeCandidateKey = candidateKey(candidate);
  state.activeCandidateSource = "user";
  state.cooldowns = {};
  state.lastSwitchReason = "user_selection";
}

export function clearModelRouteUserSelectionIfDifferent(
  state: ModelRouteState,
  candidate: Pick<ModelRouteCandidate, "provider" | "modelId">,
): boolean {
  if (state.activeCandidateSource !== "user") return false;
  if (state.activeCandidateKey === candidateKey(candidate)) return false;
  state.activeCandidateKey = undefined;
  state.activeCandidateSource = undefined;
  state.cooldowns = {};
  state.lastSwitchReason = "request_model_override";
  return true;
}

export function classifyModelRouteFailure(errorMessage?: string, stopReason?: string): ModelRouteFailureKind;
export function classifyModelRouteFailure(signal?: ModelRouteFailureSignal): ModelRouteFailureKind;
export function classifyModelRouteFailure(
  input?: string | ModelRouteFailureSignal,
  stopReason?: string,
): ModelRouteFailureKind {
  const signal = typeof input === "object" && input !== null
    ? input
    : { errorMessage: input, stopReason };
  const reason = signal.stopReason?.toLowerCase() ?? "";
  const status = signal.status;
  const message = collectFailureSignalText(signal).toLowerCase();
  const combined = `${reason} ${status ?? ""} ${message}`;

  const userAbortPattern = /\buser[-_ ]?aborted\b|\bcancelled by user\b|\buser abort\b|\baborted by user\b/;
  const transportAbortPattern = /\b(?:connection|request|socket|network|upstream|transport|stream)\s+aborted\b/;
  if (userAbortPattern.test(combined) || (reason === "aborted" && !transportAbortPattern.test(message))) {
    return "user_abort";
  }
  if (
    /context_length_exceeded|context length|context window|maximum context|max context|too many tokens|prompt too long|request_too_large|token limit|input length/.test(combined)
  ) {
    return "context_overflow";
  }

  if (/\b401\b|unauthorized|invalid api key|no api key|missing api key|authentication failed|authentication/i.test(combined)) {
    return "auth";
  }
  // Anchor on phrases real providers emit (OpenAI/Azure content filter,
  // Anthropic usage policy, Gemini SAFETY blocks). Bare "policy" / "blocked" /
  // "safety" intercepted unrelated errors here ("blocked by upstream proxy")
  // and mislabeled them as content_policy, which is a no-fallback kind.
  if (
    /content[_ -]?(?:filter|policy|moderation)|finish_reason:\s*content_filter|content management policy|usage policy|policy violation|moderation|blocked (?:due to|by) (?:safety|content|policy)|safety (?:filter|system|setting|rating|violation)/.test(combined)
  ) {
    return "content_policy";
  }

  if (isBillingLike(combined, status)) {
    return "billing";
  }
  if (/\b403\b|forbidden|permission denied/.test(combined)) {
    return "auth";
  }
  if (
    status === 429
    || /rate.?limit|too many requests|throttl(?:e|ed|ing)|requests per minute|tokens per minute|try again in|retry after|retry-after|\b429\b/.test(combined)
  ) {
    return "rate_limit";
  }
  if (/timed? out|timeout|deadline exceeded/.test(combined)) {
    return "timeout";
  }
  if (status === 529 || /overloaded|overloaded_error|capacity exceeded|temporarily overloaded/.test(combined)) {
    return "overloaded";
  }
  if (
    status === 404
    || /model.?service.*(?:not.?available|not.?exists?|not.?found)|model.*(?:not.?available|not.?exists?|not.?found)|deployment.*not.?found/.test(combined)
  ) {
    return "model_not_found";
  }
  if (
    (status !== undefined && [500, 502, 503, 504].includes(status))
    || /\b500\b|\b502\b|\b503\b|\b504\b|service.?unavailable|server.?error|internal.?error/.test(combined)
  ) {
    return "server_error";
  }
  if (/network|connection|request aborted|socket hang up|fetch failed|reset before headers|upstream|terminated|econnreset|enotfound|eai_again|stream ended|ended without|http2/.test(combined)) {
    return "network";
  }
  if (status === 400 || /\b400\b|invalid_request|bad request|schema|unsupported|invalid parameter|invalid model|validation error|format/.test(combined)) {
    return "format_error";
  }
  return "unknown";
}

function isBillingLike(combined: string, status?: number): boolean {
  const hasResetHint = /try again in|resets? at|reset in|retry after|retry-after/.test(combined);
  const usageLimitWithReset = /usage limit/.test(combined) && hasResetHint;
  const paymentRequiredWithReset = status === 402 && hasResetHint;
  if (usageLimitWithReset) return false;
  if (paymentRequiredWithReset) return false;
  return status === 402
    || /gousagelimiterror|freeusagelimiterror|monthly usage limit|usage_not_included|available balance|insufficient[_ -]?quota|credit balance|credits? exhausted|quota exceeded|out of budget|out of funds|billing|balance_depleted/.test(combined);
}

function collectFailureSignalText(signal: ModelRouteFailureSignal): string {
  const parts: string[] = [];
  pushString(parts, signal.errorMessage);
  pushString(parts, signal.stopReason);
  pushString(parts, signal.provider);
  pushString(parts, signal.modelId);
  if (signal.status !== undefined) parts.push(String(signal.status));
  if (signal.headers) {
    pushHeader(parts, signal.headers, "retry-after");
    pushHeader(parts, signal.headers, "retry-after-ms");
    pushHeader(parts, signal.headers, "x-ratelimit-reset");
    pushHeader(parts, signal.headers, "x-ratelimit-reset-requests");
    pushHeader(parts, signal.headers, "x-ratelimit-reset-tokens");
  }
  collectDiagnosticText(signal.diagnostics, parts);
  return parts.join(" ");
}

function collectDiagnosticText(value: unknown, parts: string[]): void {
  if (!Array.isArray(value)) return;
  for (const diagnostic of value) {
    if (!isRecord(diagnostic)) continue;
    pushString(parts, diagnostic.type);
    const error = diagnostic.error;
    if (isRecord(error)) {
      pushString(parts, error.name);
      pushString(parts, error.message);
      if (typeof error.code === "string" || typeof error.code === "number") parts.push(String(error.code));
    }
  }
}

function pushHeader(parts: string[], headers: Record<string, string>, key: string): void {
  const value = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
  if (value) parts.push(`${key}: ${value}`);
}

function pushString(parts: string[], value: unknown): void {
  if (typeof value === "string" && value.trim() !== "") parts.push(value);
}

export function shouldFallbackForKind(kind: ModelRouteFailureKind, policy: ModelRoutePolicy): boolean {
  const noFallbackOn = normalizeFailureKindSet(policy.noFallbackOn);
  if (noFallbackOn.has(kind)) return false;

  const fallbackOn = normalizeFailureKindSet(policy.fallbackOn);
  if (fallbackOn.size > 0) return fallbackOn.has(kind);

  if (DEFAULT_NO_FALLBACK_ON.has(kind)) return false;
  return DEFAULT_FALLBACK_ON.has(kind);
}

function shouldTryNextCandidateForFailure(failure: AttemptFailure, policy: ModelRoutePolicy): boolean {
  if (failure.kind === "context_overflow" && failure.source === "setup") {
    return !normalizeFailureKindSet(policy.noFallbackOn).has("context_overflow");
  }
  return shouldFallbackForKind(failure.kind, policy);
}

export async function runPromptWithModelRouting(
  brain: BrainSession,
  text: string,
  policy: ModelRoutePolicy | undefined,
  state: ModelRouteState,
  options: RunPromptWithModelRoutingOptions = {},
  media?: PromptMedia,
): Promise<ModelRouteRunResult> {
  if (!isModelRoutePolicyEnabled(policy)) {
    await brain.prompt(text, media);
    return { success: true, exhausted: false, attempted: [] };
  }

  // Media-capability filtering narrows a genuine CHOICE: with ≥2 candidates, drop
  // those that can't take the prompt's media so a fallback never lands on one. A
  // single candidate has nothing to choose between — run it and let the provider
  // (and the caller's media preflight) decide, matching the pre-unification
  // bare-prompt path. A candidate synthesized from the current model carries no
  // modelConfig, so it would otherwise be filtered out for lack of declared inputs.
  const allCandidates = normalizeCandidates(policy.candidates);
  const candidates = allCandidates.length > 1
    ? filterCandidatesForPromptMedia(allCandidates, media)
    : allCandidates;
  if (requiredInputsForPromptMedia(media).length > 0 && candidates.length === 0) {
    return {
      success: false,
      exhausted: true,
      attempted: [],
      activeCandidateKey: state.activeCandidateKey,
      finalFailureKind: "format_error",
      finalErrorMessage: unsupportedPromptMediaMessage(media),
    };
  }
  const primaryCandidate = candidates[0]!;
  const primaryCandidateKey = candidateKey(primaryCandidate);
  const emitEvent = options.emitEvent ?? (() => {});
  const emitBrainEvent = options.emitBrainEvent ?? (() => {});
  const optimisticPrimaryStream = options.optimisticPrimaryStream !== false;
  const now = options.now ?? (() => Date.now());
  const attempted: ModelRouteAttempt[] = [];

  // Cooling candidates are deprioritized, not excluded: when every fresh
  // candidate fails, trying a cooling one as a last resort still beats
  // failing the whole turn with an untried candidate on the bench. Partition
  // against a single timestamp so a cooldown expiring mid-evaluation cannot
  // drop a candidate from both halves.
  const orderingNow = now();
  pruneExpiredCooldowns(state, orderingNow);
  const freshCandidates = candidates.filter((candidate) => !isCandidateCooling(state, candidate, orderingNow));
  const coolingCandidates = candidates.filter((candidate) => isCandidateCooling(state, candidate, orderingNow));
  const ordered = [...freshCandidates, ...coolingCandidates];

  emitEvent({
    type: "model_route_start",
    strategy: "ordered_fallback",
    candidateCount: candidates.length,
    activeCandidateKey: state.activeCandidateKey,
    primaryCandidateKey,
    primaryProvider: primaryCandidate.provider,
    primaryModelId: primaryCandidate.modelId,
  });

  let finalFailure: AttemptFailure | undefined;
  for (let i = 0; i < ordered.length; i++) {
    const candidate = ordered[i];
    // A user Stop can land in the switch window (cooldown persist, checkpoint
    // restore, setModel are all awaited) where no brain.prompt is in flight to
    // absorb it — poll the abort signal so the cancelled prompt is not re-run
    // on the next candidate.
    if (i > 0 && options.shouldAbort?.()) {
      const abortMessage = "Prompt aborted between fallback attempts.";
      state.lastSwitchReason = "user_abort";
      options.onStateChange?.(state);
      // A user stop is not exhaustion — emit a dedicated event so a future
      // consumer cannot render "all candidates failed" for a manual Stop.
      emitEvent({
        type: "model_route_aborted",
        attempt: i,
        candidateKey: attempted[attempted.length - 1]?.candidateKey,
        errorMessage: abortMessage,
      });
      return {
        success: false,
        exhausted: false,
        attempted,
        activeCandidateKey: state.activeCandidateKey,
        finalFailureKind: "user_abort",
        finalErrorMessage: abortMessage,
      };
    }
    const key = candidateKey(candidate);
    const startedAt = now();
    const attempt: ModelRouteAttempt = {
      attempt: i + 1,
      candidateKey: key,
      provider: candidate.provider,
      modelId: candidate.modelId,
      startedAt,
    };
    attempted.push(attempt);
    emitEvent({
      type: "model_route_attempt",
      attempt: attempt.attempt,
      candidateKey: key,
      provider: candidate.provider,
      modelId: candidate.modelId,
      status: "started",
    });

    // The primary candidate (first ordered attempt) streams live so a healthy
    // session feels identical to running without routing. Fallback candidates
    // buffer (until their own first tool call) — once we've already had to
    // switch once, replaying a clean attempt beats a second live-then-rollback
    // flicker. Background/synthetic turns opt out (optimisticPrimaryStream) and
    // buffer every attempt, since a live failed attempt would leak into the
    // turn they persist from collected events.
    const streamFromStart = optimisticPrimaryStream && i === 0;
    const attemptResult = await runAttempt(brain, text, candidate, emitBrainEvent, streamFromStart, media);
    const failure = attemptResult.failure;
    attempt.finishedAt = now();

    if (!failure) {
      attempt.success = true;
      const previousActiveCandidateKey = state.activeCandidateKey;
      const recoveredFrom = previousActiveCandidateKey && previousActiveCandidateKey !== key && key === primaryCandidateKey
        ? findCandidateByKey(candidates, previousActiveCandidateKey)
        : undefined;
      // A success proves the candidate healthy again — drop any cooldown left
      // over from a run that used it as a last resort while still cooling.
      delete state.cooldowns[key];
      // A manual pin (PUT /model) can land while this runner is in flight;
      // the run's outcome must not clobber that explicit user choice.
      if (state.activeCandidateSource !== "user") {
        state.activeCandidateKey = key;
        state.activeCandidateSource = "auto";
      }
      state.lastSuccessAt = attempt.finishedAt;
      recordAttempt(state, attempt);
      options.onStateChange?.(state);
      emitEvent({
        type: "model_route_success",
        attempt: attempt.attempt,
        candidateKey: key,
        provider: candidate.provider,
        modelId: candidate.modelId,
        isFallback: key !== primaryCandidateKey,
        primaryCandidateKey,
        recoveredFromCandidateKey: recoveredFrom ? previousActiveCandidateKey : undefined,
        recoveredFromProvider: recoveredFrom?.provider,
        recoveredFromModelId: recoveredFrom?.modelId,
      });
      flushBrainEvents(attemptResult.events, emitBrainEvent);
      return {
        success: true,
        exhausted: false,
        attempted,
        activeCandidateKey: key,
      };
    }

    finalFailure = failure;
    attempt.success = false;
    attempt.failureKind = failure.kind;
    attempt.failureSource = failure.source;
    attempt.errorMessage = failure.message;
    if (attemptResult.hadToolExecution) attempt.fallbackBlockedReason = "tool_execution";
    state.lastFailureAt = attempt.finishedAt;
    recordAttempt(state, attempt);

    emitEvent({
      type: "model_route_attempt",
      attempt: attempt.attempt,
      candidateKey: key,
      provider: candidate.provider,
      modelId: candidate.modelId,
      status: "failed",
      failureKind: failure.kind,
      fallbackBlockedReason: attempt.fallbackBlockedReason,
      errorMessage: failure.message,
    });

    const nextCandidate = ordered[i + 1];
    const willSwitch = Boolean(nextCandidate)
      && !attempt.fallbackBlockedReason
      && shouldTryNextCandidateForFailure(failure, policy);
    // Record the cooldown for every failure that carries one, not only when
    // switching: a terminal failure (last candidate, tool-blocked, or
    // no-fallback kind) still marks the candidate unhealthy for the NEXT
    // turn's ordering. Only the switch path clears a stale cooldown — a
    // terminal zero-cooldown failure (e.g. user_abort) keeps what it had.
    const cooldownUntil = cooldownUntilForFailure(failure, policy, now());
    if (cooldownUntil) state.cooldowns[key] = cooldownUntil;
    else if (willSwitch) delete state.cooldowns[key];
    if (!willSwitch) {
      flushBrainEvents(attemptResult.events, emitBrainEvent);
      state.lastSwitchReason = failure.kind;
      options.onStateChange?.(state);
      emitEvent({
        type: "model_route_exhausted",
        attempt: attempt.attempt,
        candidateKey: key,
        failureKind: failure.kind,
        fallbackBlockedReason: attempt.fallbackBlockedReason,
        errorMessage: failure.message,
      });

      // A setup failure (model_not_found, context preflight, setModel throw)
      // produced ZERO brain events, and this branch returns instead of
      // throwing — the HTTP caller logs the turn as complete. Without a
      // terminal brain event the chat client renders an empty turn: no
      // answer, no error bubble (clients build error bubbles from an
      // assistant message_end with stopReason "error", the same shape a
      // failed LLM call emits in-band). Synthesize that message so the
      // failure is visible end-to-end.
      if (failure.source === "setup") {
        emitBrainEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: failure.message ?? `Model routing failed: all candidates exhausted (${failure.kind})`,
          },
        });
      }

      if (failure.source === "prompt_error") {
        throw normalizeThrownError(failure);
      }

      return {
        success: false,
        exhausted: true,
        attempted,
        activeCandidateKey: state.activeCandidateKey,
        finalFailureKind: failure.kind,
        finalErrorMessage: failure.message,
      };
    }

    state.lastSwitchReason = failure.kind;
    options.onStateChange?.(state);
    try {
      await restorePromptCheckpoint(brain, attemptResult.checkpoint);
    } catch (err) {
      const message = errorMessage(err);
      emitEvent({
        type: "model_route_exhausted",
        attempt: attempt.attempt,
        candidateKey: key,
        failureKind: "unknown",
        errorMessage: `Failed to restore prompt checkpoint before fallback: ${message}`,
      });
      throw err;
    }
    // The failed attempt streamed live output (a live primary, or a buffered
    // candidate that went live after a tool call) — tell consumers to discard
    // it before the next candidate streams in, so the transcript and DB don't
    // stack the dead attempt under the winning one. A failure before the first
    // token emitted nothing (emittedLive=false) and needs no rollback.
    if (attemptResult.emittedLive) {
      emitEvent({
        type: "model_route_rollback",
        attempt: attempt.attempt,
        candidateKey: key,
        failureKind: failure.kind,
      });
    }
    emitEvent({
      type: "model_route_switch",
      attempt: attempt.attempt,
      fromCandidateKey: key,
      toCandidateKey: candidateKey(nextCandidate),
      fromProvider: candidate.provider,
      fromModelId: candidate.modelId,
      toProvider: nextCandidate.provider,
      toModelId: nextCandidate.modelId,
      failureKind: failure.kind,
      errorMessage: failure.message,
      cooldownUntil,
    });
  }

  return {
    success: false,
    exhausted: true,
    attempted,
    activeCandidateKey: state.activeCandidateKey,
    finalFailureKind: finalFailure?.kind,
    finalErrorMessage: finalFailure?.message,
  };
}

async function runAttempt(
  brain: BrainSession,
  text: string,
  candidate: ModelRouteCandidate,
  emitBrainEvent: (event: unknown) => void,
  streamFromStart: boolean,
  media?: PromptMedia,
): Promise<AttemptResult> {
  const checkpoint = brain.createPromptCheckpoint?.();
  let lastProviderResponse: BrainProviderResponse | undefined;
  const unsubscribeProviderResponse = brain.captureProviderResponse?.((response) => {
    if (response.provider && response.provider !== candidate.provider) return;
    if (response.modelId && response.modelId !== candidate.modelId) return;
    lastProviderResponse = response;
  });
  let model: BrainModelInfo | undefined;
  try {
    if (candidate.modelConfig && brain.registerProvider) {
      brain.registerProvider(candidate.provider, candidate.modelConfig);
    }
    model = brain.findModel(candidate.provider, candidate.modelId);
    if (!model) {
      unsubscribeProviderResponse?.();
      return {
        checkpoint,
        events: [],
        hadToolExecution: false,
        emittedLive: false,
        failure: {
          kind: "model_not_found",
          source: "setup",
          message: `Model not found: ${candidate.provider}/${candidate.modelId}`,
          providerResponse: lastProviderResponse,
        },
      };
    }
    if (modelNeedsUpdate(brain.getModel(), model)) {
      await brain.setModel(model);
    }
  } catch (err) {
    const message = errorMessage(err);
    unsubscribeProviderResponse?.();
    return {
      checkpoint,
      events: [],
      hadToolExecution: false,
      emittedLive: false,
      failure: {
        kind: classifyModelRouteFailure({
          errorMessage: message,
          provider: candidate.provider,
          modelId: candidate.modelId,
          status: lastProviderResponse?.status,
          headers: lastProviderResponse?.headers,
        }),
        source: "setup",
        message,
        thrown: err,
        providerResponse: lastProviderResponse,
      },
    };
  }

  let lastAssistantMessage: AssistantMessageLike | null = null;
  // Brain events stay buffered (invisible to the SSE consumer) only while a
  // fallback retry could still discard them silently. Buffering ends as soon as
  // discarding is no longer free:
  //   • streamFromStart — the PRIMARY candidate streams live from its first
  //     event, so the common (success) path feels exactly like no routing at
  //     all. A live primary that then fails is recovered by the caller with a
  //     model_route_rollback telling consumers to drop what it rendered.
  //   • the first tool execution — it blocks fallback for good (#312), so from
  //     there buffering buys no atomicity. Flush the prefix and go live.
  const events: unknown[] = [];
  let streaming = streamFromStart;
  let emittedLive = false;
  let hadToolExecution = false;
  const unsubscribe = brain.subscribe((event: unknown) => {
    if (streaming) {
      emitBrainEvent(event);
      emittedLive = true;
    } else {
      events.push(event);
      if (isToolExecutionEvent(event)) {
        streaming = true;
        flushBrainEvents(events, emitBrainEvent);
        events.length = 0;
        emittedLive = true;
      }
    }
    if (isToolExecutionEvent(event)) hadToolExecution = true;
    if (!isRecord(event) || event.type !== "message_end") return;
    const message = event.message;
    if (isRecord(message) && message.role === "assistant") {
      lastAssistantMessage = message;
    }
  });

  try {
    const preflight = model
      ? await brain.ensureContextForModelPrompt?.(model, text)
      : undefined;
    if (preflight && !preflight.ok) {
      return {
        checkpoint,
        events,
        hadToolExecution,
        emittedLive,
        failure: {
          kind: "context_overflow",
          source: "setup",
          message: preflight.errorMessage ?? `Context preflight failed for ${candidate.provider}/${candidate.modelId}`,
          providerResponse: lastProviderResponse,
        },
      };
    }
    await brain.prompt(text, media);
  } catch (err) {
    const message = errorMessage(err);
    return {
      checkpoint,
      events,
      hadToolExecution,
      emittedLive,
      failure: {
        kind: classifyModelRouteFailure({
          errorMessage: message,
          provider: candidate.provider,
          modelId: candidate.modelId,
          status: lastProviderResponse?.status,
          headers: lastProviderResponse?.headers,
        }),
        source: "prompt_error",
        message,
        thrown: err,
        providerResponse: lastProviderResponse,
      },
    };
  } finally {
    unsubscribe();
    unsubscribeProviderResponse?.();
  }

  return {
    checkpoint,
    events,
    hadToolExecution,
    emittedLive,
    failure: failureFromAssistantMessage(lastAssistantMessage, candidate, lastProviderResponse),
  };
}

async function restorePromptCheckpoint(brain: BrainSession, checkpoint: unknown): Promise<void> {
  await brain.restorePromptCheckpoint?.(checkpoint);
}

function flushBrainEvents(events: unknown[], emitBrainEvent: (event: unknown) => void): void {
  for (const event of events) emitBrainEvent(event);
}

function isToolExecutionEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") return true;
  if (event.type !== "message_end" || !isRecord(event.message)) return false;
  return event.message.role === "toolResult";
}

function failureFromAssistantMessage(
  message: AssistantMessageLike | null,
  candidate: ModelRouteCandidate,
  providerResponse?: BrainProviderResponse,
): AttemptFailure | null {
  if (!message) {
    return {
      kind: "empty_response",
      source: "message_end",
      message: "No assistant response was emitted.",
      providerResponse,
    };
  }

  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
  const messageError = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
  if (stopReason === "error") {
    return {
      kind: classifyModelRouteFailure({
        errorMessage: messageError,
        stopReason,
        provider: typeof message.provider === "string" ? message.provider : candidate.provider,
        modelId: typeof message.model === "string" ? message.model : candidate.modelId,
        status: providerResponse?.status,
        headers: providerResponse?.headers,
        diagnostics: message.diagnostics,
      }),
      source: "message_end",
      message: messageError,
      providerResponse,
    };
  }
  if (stopReason === "aborted") {
    // Route through the classifier instead of hardcoding user_abort: it
    // distinguishes a transport-level abort ("connection aborted") — which
    // should fall back — from a genuine user stop.
    return {
      kind: classifyModelRouteFailure({
        errorMessage: messageError,
        stopReason,
        provider: typeof message.provider === "string" ? message.provider : candidate.provider,
        modelId: typeof message.model === "string" ? message.model : candidate.modelId,
        status: providerResponse?.status,
        headers: providerResponse?.headers,
        diagnostics: message.diagnostics,
      }),
      source: "message_end",
      message: messageError,
      providerResponse,
    };
  }
  if (!assistantHasContent(message)) {
    return {
      kind: "empty_response",
      source: "message_end",
      message: messageError ?? "Assistant response was empty.",
      providerResponse,
    };
  }
  return null;
}

function assistantHasContent(message: AssistantMessageLike): boolean {
  const content = message.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!isRecord(block)) return false;
    if (block.type === "text") return typeof block.text === "string" && block.text.trim().length > 0;
    return block.type === "toolCall";
  });
}

function modelNeedsUpdate(current: BrainModelInfo | undefined, next: BrainModelInfo): boolean {
  return !current
    || current.id !== next.id
    || current.provider !== next.provider
    || current.reasoning !== next.reasoning
    || current.contextWindow !== next.contextWindow
    || current.maxTokens !== next.maxTokens;
}

function recordAttempt(state: ModelRouteState, attempt: ModelRouteAttempt): void {
  state.attempts.push({ ...attempt });
  if (state.attempts.length > ATTEMPT_HISTORY_LIMIT) {
    state.attempts.splice(0, state.attempts.length - ATTEMPT_HISTORY_LIMIT);
  }
}

function pruneExpiredCooldowns(state: ModelRouteState, now: number): void {
  for (const [key, until] of Object.entries(state.cooldowns)) {
    if (!Number.isFinite(until) || until <= now) delete state.cooldowns[key];
  }
}

function isCandidateCooling(state: ModelRouteState, candidate: ModelRouteCandidate, now: number): boolean {
  const cooldownUntil = state.cooldowns[candidateKey(candidate)];
  return typeof cooldownUntil === "number" && cooldownUntil > now;
}

function findCandidateByKey(candidates: ModelRouteCandidate[], key: string): ModelRouteCandidate | undefined {
  return candidates.find((candidate) => candidateKey(candidate) === key);
}

function cooldownUntilForFailure(failure: AttemptFailure, policy: ModelRoutePolicy, now: number): number | undefined {
  // Prefer a provider-signalled delay over our per-kind default. The structured
  // Retry-After / X-RateLimit-Reset header is the cleanest source, but pi-ai
  // currently drops the SDK error's response headers before they reach routing
  // (it keeps only error.message), so for real errors the only retry-after that
  // survives is the one some providers bury in the error body text. Fold both in
  // and take the longest hint; fall back to the per-kind default when neither is
  // present.
  const headerMs = cooldownMsFromProviderHeaders(failure.providerResponse?.headers, now);
  const messageMs = cooldownMsFromMessage(failure.message);
  const signalledMs = maxDefined(headerMs, messageMs);
  const cooldownMs = signalledMs ?? cooldownMsForFailure(failure.kind, policy);
  return cooldownMs > 0 ? now + cooldownMs : undefined;
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return defined.length > 0 ? Math.max(...defined) : undefined;
}

function cooldownMsForFailure(kind: ModelRouteFailureKind, policy: ModelRoutePolicy): number {
  const explicit = normalizeCooldownMsByKind(policy.cooldownMsByKind)[kind];
  return explicit ?? DEFAULT_COOLDOWN_MS_BY_KIND[kind] ?? 0;
}

function cooldownMsFromProviderHeaders(headers: Record<string, string> | undefined, now: number): number | undefined {
  if (!headers) return undefined;
  const candidates = [
    parseDurationHeader(headers["retry-after-ms"], "ms"),
    parseRetryAfterHeader(headers["retry-after"], now),
    parseResetHeader(headers["x-ratelimit-reset"], now),
    parseResetHeader(headers["x-ratelimit-reset-requests"], now),
    parseResetHeader(headers["x-ratelimit-reset-tokens"], now),
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  if (candidates.length === 0) return undefined;
  return clampHeaderCooldownMs(Math.max(...candidates));
}

function cooldownMsFromMessage(message: string | undefined): number | undefined {
  if (!message) return undefined;
  // Some providers put the retry delay in the error body text — e.g. OpenAI's
  // "Please try again in 1.5s" — which is the only retry-after that survives
  // once pi-ai discards the SDK error's response headers. Anchor on an explicit
  // retry hint AND require a recognised time unit with a trailing word boundary,
  // so prose like "try again in 2 more steps" or an unrelated number (token
  // counts, request ids, rate-limit ceilings) is never mistaken for a delay. The
  // matched token is parsed by the same helper the Retry-After header uses.
  const match = /(?:try again in|retry[\s-]?after|retry in)\s*[:=~]?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)(?![a-z])/i.exec(message);
  if (!match) return undefined;
  const durationMs = parseDurationHeader(`${match[1]}${match[2]}`);
  return durationMs !== undefined && durationMs > 0 ? clampHeaderCooldownMs(durationMs) : undefined;
}

function parseRetryAfterHeader(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const durationMs = parseDurationHeader(value, "s");
  if (durationMs !== undefined) return durationMs;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - now) : undefined;
}

function parseResetHeader(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const durationMs = parseDurationHeader(value);
  if (durationMs !== undefined) return durationMs;
  const numeric = Number(value.trim());
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  if (numeric >= 1_000_000_000_000) return Math.max(0, numeric - now);
  if (numeric >= 1_000_000_000) return Math.max(0, numeric * 1000 - now);
  return numeric * 1000;
}

function parseDurationHeader(value: string | undefined, defaultUnit?: "ms" | "s"): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const unitMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i);
  if (unitMatch) {
    const amount = Number(unitMatch[1]);
    const unit = unitMatch[2].toLowerCase();
    if (!Number.isFinite(amount)) return undefined;
    if (unit.startsWith("ms") || unit.startsWith("millisecond")) return amount;
    if (unit === "s" || unit.startsWith("sec")) return amount * 1000;
    if (unit === "m" || unit.startsWith("min")) return amount * 60 * 1000;
    if (unit === "h" || unit.startsWith("hr") || unit.startsWith("hour")) return amount * 60 * 60 * 1000;
  }
  const numeric = Number(trimmed);
  if (!defaultUnit) return undefined;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return defaultUnit === "ms" ? numeric : numeric * 1000;
}

function clampHeaderCooldownMs(value: number): number {
  return Math.min(Math.max(0, Math.ceil(value)), HEADER_COOLDOWN_MAX_MS);
}

function normalizeCooldownMsByKind(value: unknown): ModelRouteCooldownMsByKind {
  if (!isRecord(value)) return {};
  const normalized: ModelRouteCooldownMsByKind = {};
  for (const [rawKind, cooldownMs] of Object.entries(value)) {
    const kind = normalizeFailureKind(rawKind);
    if (!kind) continue;
    if (typeof cooldownMs !== "number" || !Number.isFinite(cooldownMs) || cooldownMs < 0) continue;
    normalized[kind] = cooldownMs;
  }
  return normalized;
}

function normalizeFailureKindSet(kinds: unknown): Set<ModelRouteFailureKind> {
  return new Set(normalizeFailureKinds(kinds));
}

function normalizeFailureKinds(kinds: unknown): ModelRouteFailureKind[] {
  if (!Array.isArray(kinds)) return [];
  const seen = new Set<ModelRouteFailureKind>();
  const normalized: ModelRouteFailureKind[] = [];
  for (const rawKind of kinds) {
    const kind = normalizeFailureKind(rawKind);
    if (!kind || seen.has(kind)) continue;
    seen.add(kind);
    normalized.push(kind);
  }
  return normalized;
}

function normalizeFailureKind(value: unknown): ModelRouteFailureKind | undefined {
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "quota":
      return "billing";
    case "provider_5xx":
      return "server_error";
    case "model_unavailable":
      return "model_not_found";
    case "policy_block":
      return "content_policy";
    case "invalid_request":
      return "format_error";
    case "billing":
    case "rate_limit":
    case "timeout":
    case "overloaded":
    case "server_error":
    case "model_not_found":
    case "network":
    case "empty_response":
    case "context_overflow":
    case "user_abort":
    case "content_policy":
    case "tool_error":
    case "auth":
    case "format_error":
    case "unknown":
      return value;
    default:
      return undefined;
  }
}

function normalizeAttempt(value: Record<string, unknown>): ModelRouteAttempt | null {
  if (typeof value.candidateKey !== "string") return null;
  if (typeof value.provider !== "string") return null;
  if (typeof value.modelId !== "string") return null;
  if (typeof value.startedAt !== "number") return null;
  return {
    attempt: typeof value.attempt === "number" ? value.attempt : 0,
    candidateKey: value.candidateKey,
    provider: value.provider,
    modelId: value.modelId,
    startedAt: value.startedAt,
    finishedAt: typeof value.finishedAt === "number" ? value.finishedAt : undefined,
    success: typeof value.success === "boolean" ? value.success : undefined,
    failureKind: normalizeFailureKind(value.failureKind),
    failureSource: value.failureSource === "prompt_error" || value.failureSource === "message_end" || value.failureSource === "setup"
      ? value.failureSource
      : undefined,
    errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : undefined,
  };
}

function normalizeThrownError(failure: AttemptFailure): Error {
  if (failure.thrown instanceof Error) return failure.thrown;
  return new Error(failure.message ?? failure.kind);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
