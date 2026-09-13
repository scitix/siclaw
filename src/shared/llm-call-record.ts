/**
 * One measured LLM call — the P0 metering record.
 *
 * Design contract (see docs/design/2026-09-12-token-cost-analysis.zh-CN.md §7.8.2b):
 *
 *   Provenance is RECORDED AT THE POINT OF PRODUCTION, never inferred afterwards.
 *
 * That rule exists because four different code paths can produce an all-zero
 * usage object, and they are indistinguishable once written:
 *
 *   1. pi initialises `usage` to all-zero BEFORE the request leaves
 *      (`openai-responses.js:94-101`, stopReason "pending" at that moment) — and a
 *      call that never gets usage back can still settle as `stop`, so the stop
 *      reason does not identify it.
 *   2. A rehydrated transcript fills `ZERO_USAGE` (`session-rehydrate.ts`). This is
 *      NOT only a handoff path: eviction, or simply missing local history after a
 *      pod restart, rebuilds from the control plane too — and rebuilt messages can
 *      sit in the same session as later real calls, so a per-SESSION verdict is
 *      always wrong. Marking is per-record.
 *   3. `Math.max(0, …)` clamping of a derived input figure
 *      (`openai-responses-shared.js:445`).
 *   4. A genuine zero — `cache_read = 0` is a perfectly ordinary answer.
 *
 * Hence `null` and `0` mean different things here and must never be folded
 * together: `0` is a reported zero, `null` is "not reported".
 *
 * WHERE `reported_fields` MUST COME FROM
 * -------------------------------------
 * From observing the provider's RAW response, not from pi's normalised `usage`.
 * Two reasons, both measured rather than reasoned:
 *
 *   - pi's `Usage` declares input/output/cacheRead/cacheWrite as REQUIRED and
 *     zero-fills them before the request goes out, so "reported 0" and "never
 *     reported" are identical at the streamFn boundary.
 *   - `reasoning?` is optional in the type, and its doc comment says providers
 *     that do not report it leave it undefined — but a fixture reporting only
 *     `input_tokens=17` came back with reasoning set to `0`. The optionality is
 *     NOT a usable signal; deriving provenance from it would misreport.
 *
 * The supported path is a per-call `options.fetch` (a public pi input) that
 * observes the raw SSE bytes and passes them through untouched. A transport not
 * yet wired that way records `unknown` rather than a guess.
 *
 * A derived figure that comes out impossible (reasoning > output, cache > input)
 * is reported as `null` plus a `UsageInconsistency`, never clamped to 0 — the
 * clamp is precisely how the upstream adapter loses the same evidence.
 */

/** How complete the provider's usage report was for this call. */
export type UsageStatus =
  /** Every field this API is contracted to report was present. */
  | "reported"
  /** Some contracted fields present, others absent. */
  | "partial"
  /** The provider reported nothing; what is stored is an SDK placeholder. */
  | "missing"
  /** Provenance could not be established — never treat as zero. */
  | "unknown";

/** Where the usage numbers on this record came from. */
export type UsageSource =
  /** Read off the provider's response. */
  | "provider"
  /** The SDK's pre-request zero object; the provider never reported. */
  | "sdk_default"
  /** Reconstructed from the control plane; original record no longer exists. */
  | "rehydrated"
  /** Historical record with no provenance marker. */
  | "unknown";

/** Usage fields a provider may report. `reported_fields` holds the subset actually seen. */
export type UsageField =
  | "input"
  | "output"
  | "reasoning"
  | "cache_read"
  | "cache_write";

/**
 * What each wire protocol is contracted to report.
 *
 * `required` — present on a healthy response from that API. A missing one means
 *   the report really is incomplete.
 * `extension` — NOT part of the standard response shape; some compatible
 *   implementations add it. Absent means "does not apply here", which is a
 *   different thing from "unknown", and must not drag a healthy call to
 *   `partial` or poison a derivation.
 *
 * Deliberately NOT "all five for everybody": standard OpenAI `ResponseUsage`
 * has no cache-write figure at all, so requiring one marks every ordinary
 * Responses call `partial`. An api_type absent from this table yields `unknown`
 * rather than a guess — see `resolveUsageStatus`.
 *
 * Correct these against observed traffic; do not extend speculatively.
 */
export interface UsageFieldContract {
  required: readonly UsageField[];
  extension: readonly UsageField[];
}

export const USAGE_FIELD_CONTRACTS: Readonly<Record<string, UsageFieldContract>> = {
  // Standard ResponseUsage: input_tokens, input_tokens_details.cached_tokens,
  // output_tokens, output_tokens_details.reasoning_tokens. No cache-write field —
  // pi reads one only because Anthropic-compatible gateways may supply it.
  "openai-responses": {
    required: ["input", "output", "reasoning", "cache_read"],
    extension: ["cache_write"],
  },
  // anthropic-messages.js:409-413 reads input_tokens, cache_read_input_tokens,
  // cache_creation_input_tokens and output. Reasoning is not a separate field.
  "anthropic-messages": {
    required: ["input", "output", "cache_read", "cache_write"],
    extension: [],
  },
  "openai-completions": {
    required: ["input", "output"],
    // cache_write must appear even though this protocol never sends one:
    // omitting it left the field neither required nor an extension, so an absent
    // value read as "unknown" and returned null from every derivation on an
    // otherwise healthy call.
    extension: ["cache_read", "cache_write"],
  },
};

/**
 * What a correlation id can hold — `root_request_id` and `parent_call_id`, both
 * VARCHAR(64).
 *
 * A turn id is normally a UUID, but it is caller-supplied at the Runtime
 * boundary, so an over-long one is possible. The producer stores NULL rather than
 * a prefix: a truncated id would silently join calls from different requests,
 * which is worse than admitting we could not carry the correlation. Losing a
 * correlation must never cost the measurement itself.
 */
export const MAX_CORRELATION_ID_LENGTH = 64;

/**
 * Which part of the product spent this call.
 *
 * A CLOSED registry, not a free string, for the reason `session-origin.ts`
 * documents from experience: a second spelling of the same workload splits an
 * aggregate SILENTLY — the total still adds up, one bucket is just short, and
 * nothing errors. Adding a workload is an edit HERE, which is a compile error
 * at every producer rather than a comment nobody reads.
 *
 * It is carried by the PRODUCER and never derived at the receiver. Session
 * origin answers this only for calls that HAVE a session; a compile box or any
 * other non-conversational caller arrives with no session identity at all, and
 * the receiver has no way to tell a knowledge compile from a feedback
 * classification.
 *
 * `unattributed` is a real member, not a default to fall into: a producer that
 * has not been taught its workload must be VISIBLE as such. Folding it into
 * `conversation` would let a whole new subsystem show up as conversation growth.
 */
export const LLM_WORKLOADS = [
  "conversation",
  "analysis",
  "knowledge_compile",
  "unattributed",
] as const;

export type LlmWorkload = (typeof LLM_WORKLOADS)[number];

export function isLlmWorkload(value: unknown): value is LlmWorkload {
  return typeof value === "string" && (LLM_WORKLOADS as readonly string[]).includes(value);
}

/** Snapshot of the request as sent — the evidence cache and pruning checks read. */
export interface LlmRequestSnapshot {
  /**
   * Value sent as `prompt_cache_key`.
   *
   * ABSENT (undefined) = the request was never inspected.
   * `null` = inspected, and the field was not present.
   * These are different facts; conflating them would let "we did not look" read
   * as "the runtime sent no cache key".
   */
  prompt_cache_key?: string | null;
  /**
   * Which cache-retention shape actually went out.
   *
   * ABSENT = not inspected. `null` = inspected and NEITHER field was sent, which
   * is the ordinary case for pi's default `short`.
   */
  cache_retention_sent?: "none" | "24h" | "ttl_30m" | null;
  /** Thinking level, max tokens, and anything else that changes request shape. */
  model_settings: Record<string, unknown>;
  /** null = the sent request carried no system prompt (distinct from unknown). */
  system_sha256: string | null;
  tools_sha256: string;
  /**
   * Fingerprint of the history prefix as sent. A change here between adjacent
   * calls of one prompt is what distinguishes "history was rewritten/pruned"
   * from "history merely grew".
   */
  history_prefix_sha256: string;
  history_message_count: number;
  /**
   * Hash of the complete serialized request body as sent.
   *
   * The definitive cache-stability signal: `system_sha256` and `tools_sha256`
   * are derived from the SDK's input context, which `onPayload` can still
   * rewrite. When present, these fields describe the ACTUAL request; absent
   * means the body could not be inspected. Hashes only — no content is stored.
   */
  payload_sha256?: string;
}

export interface LlmCallRecord {
  /** Contradictions found among the reported figures; empty when consistent. */
  inconsistencies?: UsageInconsistency[];

  // ── Identity ──────────────────────────────────────────────────────────────
  /**
   * Stable id for ONE real call's lifecycle. Delivery retries deduplicate on it.
   * Not derivable from round/attempt: `round` restarts per prompt and is 0 for
   * aux calls, so those two cannot identify a call.
   */
  call_id: string;
  session_id: string;
  /** One accepted prompt execution — spans its agent rounds, aux calls and route retries. */
  prompt_id: string;
  /** Root request, linking a parent and the sub-agents it spawned. */
  root_request_id: string | null;
  /** The call that spawned this sub-agent, when this record belongs to one. */
  parent_call_id: string | null;

  /**
   * Which part of the product spent this. See {@link LLM_WORKLOADS} for why it
   * is a closed set and why it travels with the producer.
   */
  workload: LlmWorkload;

  // ── Classification (diagnostic only — never used as identity) ─────────────
  kind: "agent" | "aux";
  /** 1-based within the prompt; 0 for aux. Resets every prompt. */
  round: number;
  /** Model-routing attempt. */
  attempt: number;
  /** Transport-level retries folded into this call; they do NOT mint new call_ids. */
  network_attempts: number;

  // ── Model ─────────────────────────────────────────────────────────────────
  provider: string;
  model_id: string;
  api_type: string;

  // ── Usage — provider values as reported, never normalised ─────────────────
  usage_status: UsageStatus;
  usage_source: UsageSource;
  reported_fields: UsageField[];
  /**
   * Provider's raw input figure. NOTE the protocols disagree on what it covers:
   * under openai-responses it INCLUDES cached and cache-write tokens, under
   * anthropic-messages it does not. Store raw; derive with `inputTokensUncached`.
   */
  input_tokens_total: number | null;
  /** Provider's raw output figure — includes reasoning where the protocol nests it. */
  output_tokens_total: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;

  // ── Request measurement — three separate yardsticks, none substitutes ─────
  /** Bytes actually put on the wire. */
  payload_bytes: number | null;
  /** Local estimate, for budgeting only. */
  payload_tokens_estimated: number | null;
  request_snapshot: LlmRequestSnapshot;

  // ── Timing ────────────────────────────────────────────────────────────────
  request_at: string;
  response_end_at: string;
  /** For round 1 this is setup time, NOT the gap since the user's last message. */
  since_prev_ms: number | null;

  // ── Attribution ───────────────────────────────────────────────────────────
  org_id: string;
  user_id: string | null;
  agent_id: string;
  agent_type: string;
  session_origin: string;

  /** Left null for P0: unit prices are unverified, and a wrong price is worse than none. */
  cost_micros: null;
}

/**
 * Decide `usage_status` from what the provider actually reported.
 *
 * `reported` requires every field this api_type is contracted to report — not
 * all five, since no protocol reports all five. An unknown api_type cannot be
 * judged, so it stays `unknown` instead of being guessed into `reported`.
 *
 * An EMPTY `reported_fields` cannot separate `missing` from `unknown` on its
 * own, which is exactly why `source` is a required argument here.
 */
export function resolveUsageStatus(apiType: string, reported: readonly UsageField[], source: UsageSource): UsageStatus {
  if (source === "rehydrated" || source === "unknown") return "unknown";
  if (source === "sdk_default") return "missing";
  const contract = USAGE_FIELD_CONTRACTS[apiType];
  if (!contract) return "unknown";
  if (reported.length === 0) return "missing";
  const seen = new Set(reported);
  // Only `required` decides completeness. An absent extension field means the
  // API has no such concept, not that the report is short.
  return contract.required.every((field) => seen.has(field)) ? "reported" : "partial";
}

/** A usage figure that contradicts another — kept as evidence, never silently clamped. */
export interface UsageInconsistency {
  field: "reasoning_vs_output" | "cache_vs_input";
  detail: string;
}

/**
 * Report figures that cannot both be true.
 *
 * Callers persist these alongside the record. The point is that an impossible
 * pair is a DATA QUALITY signal; folding it to zero (as `Math.max(0, …)` would)
 * destroys the only evidence that something upstream is wrong — the same
 * failure mode we already catalogued in pi's own adapter.
 */
export function validateUsageConsistency(
  record: Pick<LlmCallRecord,
    "api_type" | "input_tokens_total" | "output_tokens_total" | "reasoning_tokens" | "cache_read_tokens" | "cache_write_tokens">,
): UsageInconsistency[] {
  const problems: UsageInconsistency[] = [];
  const { output_tokens_total: output, reasoning_tokens: reasoning } = record;
  if (output !== null && reasoning !== null && reasoning > output) {
    problems.push({
      field: "reasoning_vs_output",
      detail: `reasoning ${reasoning} exceeds output ${output}; reasoning is a subset of output`,
    });
  }
  // Only meaningful where the protocol counts cache INSIDE the input total.
  // Under anthropic-messages it does not, so cache_read far exceeding input is
  // ordinary (a large cached prefix with a short new turn) and flagging it would
  // manufacture a data-quality alert out of a healthy call.
  if (cacheCountsInsideInput(record.api_type)) {
    const cached = cacheChargedAgainstInput(record);
    const { input_tokens_total: input } = record;
    if (input !== null && cached !== null && cached > input) {
      problems.push({
        field: "cache_vs_input",
        detail: `cached ${cached} exceeds input total ${input}`,
      });
    }
  }
  return problems;
}

/**
 * Whether this protocol's `input_tokens` INCLUDES the cache figures.
 *
 * openai-responses does (pi subtracts them back out); anthropic-messages reports
 * input exclusive of cache. Getting this backwards either invents impossible
 * readings or hides real ones.
 */
export function cacheCountsInsideInput(apiType: string): boolean {
  return apiType === "openai-responses" || apiType === "openai-completions";
}

/**
 * Tokens the provider actually charged for, from one api_type's field sums.
 *
 * Exists because "total tokens" is NOT the same arithmetic across protocols:
 * under openai-responses the cache figures are already INSIDE `input`, under
 * anthropic-messages they are not. Summing the five columns uniformly
 * double-counts every cached token on one protocol and undercounts on the
 * other — which is why an aggregate must group by api_type and call this per
 * group, rather than express the rule a second time in SQL.
 *
 * `null` when a component this protocol requires was never reported: the answer
 * is then unknown, and a plausible-looking number would be worse than a gap.
 * An unreported EXTENSION field contributes 0 (the API has no such concept).
 */
export function billableTokens(
  apiType: string,
  sums: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
  },
): number | null {
  const contract = USAGE_FIELD_CONTRACTS[apiType];
  if (!contract) return null; // unknown convention — do not guess at the shape
  if (sums.input === null || sums.output === null) return null;
  if (cacheCountsInsideInput(apiType)) return sums.input + sums.output;
  const part = (field: UsageField, value: number | null): number | null =>
    value !== null ? value : (contract.extension.includes(field) ? 0 : null);
  const read = part("cache_read", sums.cacheRead);
  const write = part("cache_write", sums.cacheWrite);
  if (read === null || write === null) return null;
  return sums.input + sums.output + read + write;
}

/**
 * Cache tokens that this protocol counts INSIDE `input_tokens_total`.
 * Returns null when a required component is unreported; an inapplicable
 * extension field contributes 0 rather than making the whole sum unknown.
 */
function cacheChargedAgainstInput(
  record: Pick<LlmCallRecord, "api_type" | "cache_read_tokens" | "cache_write_tokens">,
): number | null {
  const contract = USAGE_FIELD_CONTRACTS[record.api_type];
  if (!contract) return null;
  const part = (field: UsageField, value: number | null): number | null => {
    if (value !== null) return value;
    // Unreported but merely an extension of this API ⇒ not applicable ⇒ 0.
    return contract.extension.includes(field) ? 0 : null;
  };
  const read = part("cache_read", record.cache_read_tokens);
  const write = part("cache_write", record.cache_write_tokens);
  if (read === null || write === null) return null;
  return read + write;
}

/**
 * Output tokens excluding reasoning.
 *
 * Under Responses `reasoning` is a SUBSET of output, so the two must never be
 * summed. Deriving it here — rather than documenting "do not add these" — is
 * what keeps every consumer from having to remember the rule.
 */
export function outputNonReasoningTokens(
  record: Pick<LlmCallRecord, "output_tokens_total" | "reasoning_tokens">,
): number | null {
  const { output_tokens_total: total, reasoning_tokens: reasoning } = record;
  if (total === null || reasoning === null) return null;
  const remainder = total - reasoning;
  // A negative remainder means the two figures contradict each other. Clamping
  // it to 0 would present a fabricated number as fact and hide the conflict —
  // surface it as unknown and let `validateUsageConsistency` carry the evidence.
  return remainder < 0 ? null : remainder;
}

/**
 * Input tokens that were NOT served from cache.
 *
 * Protocol-dependent by necessity (see `input_tokens_total`). An api_type whose
 * convention is unknown returns null rather than assuming either shape — picking
 * wrong here silently mis-sizes every cost figure downstream.
 */
export function inputTokensUncached(
  record: Pick<LlmCallRecord, "api_type" | "input_tokens_total" | "cache_read_tokens" | "cache_write_tokens">,
): number | null {
  const { api_type: apiType, input_tokens_total: total } = record;
  if (total === null) return null;
  if (apiType === "anthropic-messages") return total; // already excludes cache
  if (!USAGE_FIELD_CONTRACTS[apiType]) return null;   // unknown convention — do not guess
  const cached = cacheChargedAgainstInput(record);
  if (cached === null) return null;
  const uncached = total - cached;
  // Same rule as above: an impossible split is unknown, not zero.
  return uncached < 0 ? null : uncached;
}

/**
 * The part of a record the runtime core can fill in on its own.
 *
 * Core produces this as a structured event and hands it over; attribution
 * (org/user/agent/session) is added by the layer that owns those identities, and
 * persistence happens there too — core never writes to a database.
 */
export type LlmCallMeasurement = Omit<
  LlmCallRecord,
  | "session_id" | "org_id" | "user_id" | "agent_id" | "agent_type"
  | "session_origin" | "root_request_id" | "parent_call_id" | "workload"
> & {
  /**
   * Which part of the product spent this call. Optional on the WIRE so an older
   * box keeps working; absent is stored as `unattributed`, never as
   * `conversation` — see {@link LLM_WORKLOADS}.
   */
  workload?: LlmWorkload;
  /**
   * The LLM call that spawned this sub-agent, when this record belongs to one.
   *
   * Like `root_request_id`, carried by the PRODUCER: the receiver can see that a
   * child session exists but not WHICH of the parent's calls dispatched it, and
   * neither a tool-call id (it names the invocation, not the call that emitted
   * it) nor session lineage can answer that. Absent on an older box ⇒ null.
   */
  parent_call_id?: string | null;
  /** Contradictions found in the reported figures; empty when consistent. */
  inconsistencies: UsageInconsistency[];
  /**
   * The user request this call serves, when the producer knows it.
   *
   * Carried by the PRODUCER rather than derived at the receiver: only the box
   * knows which turn a call belongs to, and a sub-agent inherits its parent's
   * value so one request's main and child calls share an id. Absent on an older
   * box — the receiver then stores null rather than inventing a correlation.
   */
  root_request_id?: string | null;
};

/**
 * Attribution the runtime adds to complete a record.
 *
 * Separate because core genuinely does not know these: a recorder sits at the
 * provider boundary and has no session, tenant or agent identity in hand.
 */
export interface LlmCallAttribution {
  session_id: string;
  org_id: string;
  user_id: string | null;
  agent_id: string;
  agent_type: string;
  session_origin: string;
  root_request_id: string | null;
  parent_call_id: string | null;
}

/**
 * One delivery of measurements from a box to the Runtime.
 *
 * Batched because a turn settles several calls in quick succession, and keyed on
 * `call_id` at the receiving end so a redelivery after a lost response cannot
 * double-count — the measurement itself carries no "already sent" state.
 */
export interface LlmCallMeasurementBatch {
  session_id: string;
  measurements: LlmCallMeasurement[];
}

/** Join a core measurement with the attribution only the runtime knows. */
export function completeLlmCallRecord(
  measurement: LlmCallMeasurement,
  attribution: LlmCallAttribution,
): LlmCallRecord {
  // Inconsistencies are carried through, not dropped: they are the evidence
  // that a figure cannot be trusted, and discarding them at the join would
  // leave a record that looks clean while its numbers contradict each other.
  // Absent workload becomes `unattributed`, matching the persist path. Both
  // join sites must agree, or a record read through one looks conversational
  // and through the other does not.
  return { workload: "unattributed", ...measurement, ...attribution };
}

/** True when this record carries provider-reported numbers safe to aggregate. */
export function hasTrustworthyUsage(record: Pick<LlmCallRecord, "usage_status" | "usage_source">): boolean {
  return record.usage_source === "provider" &&
    (record.usage_status === "reported" || record.usage_status === "partial");
}
