/**
 * Sub-agent model tiering — frozen payload shapes, normalizers, and resolution.
 *
 * Design: `docs/design/subagent-model-tiering.md`. This module owns §6.1 (the two
 * wire shapes), §6.3 (the Runtime normalizers), and the §5 revision comparison.
 *
 * Pure module by design — no db, no clock, no env, no logging — mirroring
 * `tool-capabilities.ts`. Everything here is a total function over its inputs so
 * the whole contract is unit-testable, and so the Runtime boundary and the
 * write-side API can share one implementation instead of drifting apart (the
 * failure `isOpenAccessTier` already demonstrated: two copies of one rule left
 * one side accepting what the other refused, and the user got silence).
 *
 * ## The two shapes are asymmetric on purpose
 *
 * A tier is configured as one row — tier, provider, modelId, whenToUse — but it
 * travels over two channels that carry different things:
 *
 *   menu       → { tier, whenToUse }                      no credentials
 *   candidates → { tier, provider, modelId, modelConfig }  credentials
 *
 * `whenToUse` is prose written for the model and the menu is what reaches a tool
 * description, so it must not ride along with an apiKey. `provider`/`modelId`
 * identify the model and must not reach the model at all. `tier` is the only
 * field in both, and it is the join key.
 *
 * Neither normalizer may validate the other's fields: requiring `whenToUse` on a
 * candidate, or `provider` on a menu item, rejects a well-formed payload.
 */

/** Selector character set. Lowercase-only keeps it unambiguous in a description list. */
const TIER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** SHA-256 in lowercase hex. */
const REVISION_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Cap on tiers per agent. This is a context-budget decision as much as a sanity
 * one: every tier contributes a `whenToUse` line to the tool description of every
 * turn, so the ceiling bounds what tiering costs a turn that never uses it.
 */
export const MAX_SUBAGENT_TIERS = 5;

/**
 * `whenToUse` length bounds, counted in Unicode CODE POINTS rather than UTF-16
 * units so prose written in CJK is not charged double for it.
 *
 * The floor exists because an 8-character justification cannot tell the lead when
 * to pick this tier, and a menu entry the lead cannot act on is worse than no
 * entry — it burns context and invites a wrong choice.
 */
export const WHEN_TO_USE_MIN_CHARS = 8;
export const WHEN_TO_USE_MAX_CHARS = 256;

/** One menu entry: what the lead sees. Never carries credentials. */
export interface SubagentTierMenuItem {
  tier: string;
  whenToUse: string;
}

/** The menu payload, as carried by `ToolsPayload.subagentTierMenu`. */
export interface SubagentTierMenu {
  revision: string;
  items: SubagentTierMenuItem[];
}

/** One candidate: what actually runs. Carries credentials in `modelConfig`. */
export interface SubagentTierCandidate {
  tier: string;
  provider: string;
  modelId: string;
  /** Provider config including apiKey — same shape `ModelRouteCandidate` carries. */
  modelConfig: Record<string, unknown>;
}

/** The candidate payload, as carried by `binding.subagentTiers` / prompt body. */
export interface SubagentTierCandidates {
  revision: string;
  candidates: SubagentTierCandidate[];
}

/**
 * The configuration form: one row per tier, holding every field. This is what an
 * operator edits and what `agents.subagent_models` stores; the two wire shapes are
 * projections of it. It has no `revision` — that is computed when the config is
 * published, not stored alongside it.
 */
export interface SubagentTierConfigEntry {
  tier: string;
  provider: string;
  modelId: string;
  whenToUse: string;
}

/**
 * Normalizer outcome. A rejection names its reason so the CALLER can log it —
 * keeping this module free of logging is what lets it stay a pure function, and
 * the reason string is then assertable in tests rather than being buried in
 * console output.
 *
 * A rejection is never an exception. Malformed tier data is a configuration
 * problem, and letting it throw would take down the parent turn — strictly worse
 * than running that turn without tiers.
 */
export type NormalizeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

function reject(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Count Unicode code points. `String.prototype.length` counts UTF-16 units, so it
 * charges 2 for every astral character (emoji, some CJK extensions) and would
 * reject prose that is well within the intended limit.
 */
function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * Control characters are REJECTED rather than stripped. The value lands in a tool
 * description, and silently editing prose an operator wrote is worse than telling
 * them it was refused — a stripped newline changes what the model reads without
 * anyone being told.
 *
 * Matches C0 and C1 ranges plus DEL.
 */
function hasControlChars(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001F\u007F-\u009F]/.test(text);
}

function normalizeRevision(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return REVISION_PATTERN.test(raw) ? raw : undefined;
}

function normalizeTier(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return TIER_PATTERN.test(raw) ? raw : undefined;
}

/** Non-empty after trim, returning the trimmed value. */
function normalizeRequiredString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Read `whenToUse`, accepting the snake_case spelling as an alias.
 *
 * `config.getAgent` is a control-plane RPC whose every other field is snake_case
 * (`tool_capabilities`, `agent_type`, `model_provider`), so a control plane
 * emitting `when_to_use` is following that RPC's convention, not breaking it —
 * while the tools payload this ends up in is camelCase like the rest of the
 * AgentBox wire. Accepting both is what lets each boundary keep its own
 * convention instead of one side silently producing an empty menu.
 */
function readWhenToUse(entry: Record<string, unknown>): unknown {
  return entry.whenToUse ?? entry.when_to_use;
}

function normalizeWhenToUse(raw: unknown): string | undefined {
  const trimmed = normalizeRequiredString(raw);
  if (trimmed === undefined) return undefined;
  if (hasControlChars(trimmed)) return undefined;
  const length = codePointLength(trimmed);
  if (length < WHEN_TO_USE_MIN_CHARS || length > WHEN_TO_USE_MAX_CHARS) return undefined;
  return trimmed;
}

/**
 * Normalize a menu payload arriving over the tools sync channel.
 *
 * ⚠️ Does NOT look at `provider` / `modelId` — a menu does not carry them, and
 * validating a field the shape excludes would reject every valid payload.
 *
 * `null` / `undefined` mean "no tier state", which is a CLEAR and not a rejection:
 * see `isMenuCleared`. An empty `items` array with a revision IS rejected — it
 * would leave a revision on the menu side with nothing to match on the candidate
 * side, i.e. a permanent mismatch that reads as "tiering mysteriously stopped".
 */
export function normalizeSubagentTierMenu(raw: unknown): NormalizeResult<SubagentTierMenu> {
  if (!isRecord(raw)) return reject("menu is not an object");

  const revision = normalizeRevision(raw.revision);
  if (revision === undefined) return reject("menu revision is not 64 lowercase hex characters");

  if (!Array.isArray(raw.items)) return reject("menu items is not an array");
  if (raw.items.length === 0) {
    return reject("menu has a revision but no items — send null to clear instead");
  }
  if (raw.items.length > MAX_SUBAGENT_TIERS) {
    return reject(`menu declares ${raw.items.length} tiers, exceeding the cap of ${MAX_SUBAGENT_TIERS}`);
  }

  const items: SubagentTierMenuItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw.items) {
    if (!isRecord(entry)) return reject("menu item is not an object");

    const tier = normalizeTier(entry.tier);
    if (tier === undefined) return reject(`menu tier does not match ${TIER_PATTERN.source}`);
    if (seen.has(tier)) return reject(`menu declares tier "${tier}" more than once`);
    seen.add(tier);

    const whenToUse = normalizeWhenToUse(readWhenToUse(entry));
    if (whenToUse === undefined) {
      return reject(
        `menu tier "${tier}" whenToUse must be ${WHEN_TO_USE_MIN_CHARS}-${WHEN_TO_USE_MAX_CHARS} code points with no control characters`,
      );
    }

    items.push({ tier, whenToUse });
  }

  return { ok: true, value: { revision, items } };
}

/**
 * Normalize a candidate payload arriving over the prompt binding.
 *
 * ⚠️ Does NOT require `whenToUse` — a candidate does not carry it. Requiring it
 * here would reject every valid payload and disable tiering everywhere.
 *
 * A duplicate `(provider, modelId)` is refused even when the tier names differ:
 * two names for one model make `effective_model_id` in the per-item report
 * ambiguous about which tier actually ran.
 */
export function normalizeSubagentTierCandidates(
  raw: unknown,
): NormalizeResult<SubagentTierCandidates> {
  if (!isRecord(raw)) return reject("candidates payload is not an object");

  const revision = normalizeRevision(raw.revision);
  if (revision === undefined) {
    return reject("candidates revision is not 64 lowercase hex characters");
  }

  if (!Array.isArray(raw.candidates)) return reject("candidates is not an array");
  if (raw.candidates.length === 0) {
    return reject("candidates has a revision but no entries — omit the field to carry no tiers");
  }
  if (raw.candidates.length > MAX_SUBAGENT_TIERS) {
    return reject(
      `candidates declares ${raw.candidates.length} tiers, exceeding the cap of ${MAX_SUBAGENT_TIERS}`,
    );
  }

  const candidates: SubagentTierCandidate[] = [];
  const seenTiers = new Set<string>();
  const seenModels = new Set<string>();
  for (const entry of raw.candidates) {
    if (!isRecord(entry)) return reject("candidate is not an object");

    const tier = normalizeTier(entry.tier);
    if (tier === undefined) return reject(`candidate tier does not match ${TIER_PATTERN.source}`);
    if (seenTiers.has(tier)) return reject(`candidates declare tier "${tier}" more than once`);
    seenTiers.add(tier);

    const provider = normalizeRequiredString(entry.provider);
    if (provider === undefined) return reject(`candidate tier "${tier}" has no provider`);

    const modelId = normalizeRequiredString(entry.modelId);
    if (modelId === undefined) return reject(`candidate tier "${tier}" has no modelId`);

    const modelKey = `${provider}\u0000${modelId}`;
    if (seenModels.has(modelKey)) {
      return reject(`candidates point two tiers at ${provider}/${modelId}`);
    }
    seenModels.add(modelKey);

    if (!isRecord(entry.modelConfig)) {
      return reject(`candidate tier "${tier}" has no modelConfig`);
    }

    candidates.push({ tier, provider, modelId, modelConfig: entry.modelConfig });
  }

  return { ok: true, value: { revision, candidates } };
}

/**
 * Is this payload an explicit CLEAR rather than something to normalize?
 *
 * `null` means "no tier state" and must wipe whatever was held. Distinguishing it
 * from a malformed payload matters because the two have different consequences: a
 * clear is routine, a rejection is a configuration bug worth logging.
 */
export function isTierPayloadCleared(raw: unknown): boolean {
  return raw === null || raw === undefined;
}

// ── Write-side validation (Standalone config API) ────────────────────────────

/**
 * Validate + encode the CONFIG form for storage, mirroring
 * `encodeToolCapabilitiesForDb`.
 *
 * Unlike the normalizers this THROWS, because it sits on an API write path where
 * the caller turns the message into a 400 — refusing a bad write is right, while
 * refusing to serve a turn is not. `undefined` means "field absent, leave the
 * column alone"; `null` and `[]` both mean "no tiers" and store NULL.
 *
 * Existence of the referenced provider/model is NOT checked here — that needs a
 * db round-trip and belongs to the API layer. This function answers shape only.
 */
/**
 * Validate the stored CONFIG form WITHOUT throwing.
 *
 * One rule set, shared by the write path (which turns a rejection into a 400) and
 * by every READ path (which must degrade to "no tiers"). The rules used to live
 * only inside the throwing encoder, so read paths had no way to apply them and
 * simply trusted the column.
 *
 * A read path cannot afford that trust. `safeParseJson` is a type ASSERTION, not a
 * validator: `'[null]'` parses fine, passes `Array.isArray`, and then throws a
 * TypeError on the first field access. Since the same resolver now also feeds
 * `config.getModelBinding`, one malformed row would take out an agent's entire
 * model binding rather than just its tiers — turning bad config for an optional
 * feature into a total outage for that agent.
 *
 * `null` / `undefined` / `[]` are not errors: they mean no tiers, which is the
 * ordinary state of most agents.
 */
export function normalizeSubagentTierConfig(
  value: unknown,
): NormalizeResult<SubagentTierConfigEntry[]> {
  if (value === null || value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return reject("subagent_models must be null or an array of tier entries");
  }
  if (value.length === 0) return { ok: true, value: [] };
  if (value.length > MAX_SUBAGENT_TIERS) {
    return reject(`subagent_models allows at most ${MAX_SUBAGENT_TIERS} tiers`);
  }

  const entries: SubagentTierConfigEntry[] = [];
  const seenTiers = new Set<string>();
  const seenModels = new Set<string>();
  for (const raw of value) {
    // Catches null, arrays and primitives — the shapes that made a read path throw
    // a TypeError on field access rather than report a bad configuration.
    if (!isRecord(raw)) return reject("each subagent_models entry must be an object");

    const tier = normalizeTier(raw.tier);
    if (tier === undefined) {
      return reject(`tier must match ${TIER_PATTERN.source} (lowercase, no whitespace)`);
    }
    if (seenTiers.has(tier)) return reject(`duplicate tier "${tier}"`);
    seenTiers.add(tier);

    const provider = normalizeRequiredString(raw.provider ?? raw.model_provider);
    if (provider === undefined) return reject(`tier "${tier}" requires a provider`);

    const modelId = normalizeRequiredString(raw.modelId ?? raw.model_id);
    if (modelId === undefined) return reject(`tier "${tier}" requires a modelId`);

    // Keyed as a JSON pair rather than by concatenation: no separator character can
    // appear inside either half, so two distinct pairs cannot collide.
    const modelKey = JSON.stringify([provider, modelId]);
    if (seenModels.has(modelKey)) {
      return reject(`two tiers point at the same model ${provider}/${modelId}`);
    }
    seenModels.add(modelKey);

    const whenToUse = normalizeWhenToUse(readWhenToUse(raw));
    if (whenToUse === undefined) {
      return reject(
        `tier "${tier}" requires whenToUse of ${WHEN_TO_USE_MIN_CHARS}-${WHEN_TO_USE_MAX_CHARS} code points without control characters`,
      );
    }

    entries.push({ tier, provider, modelId, whenToUse });
  }

  return { ok: true, value: entries };
}

export function encodeSubagentModelsForDb(value: unknown): string | null | undefined {
  // `undefined` = field absent, leave the column alone. Distinct from `null`,
  // which clears it — and the normalizer collapses both to "no tiers", so this
  // has to be decided before calling it.
  if (value === undefined) return undefined;

  const normalized = normalizeSubagentTierConfig(value);
  // Throws HERE and only here: this is an API write path where the caller turns
  // the message into a 400. Refusing a bad write is right; refusing to serve a
  // turn — which is what a read path would be doing — is not.
  if (!normalized.ok) throw new Error(normalized.reason);
  if (normalized.value.length === 0) return null; // no tiers = inherit everywhere
  return JSON.stringify(normalized.value);
}

// ── Resolution (§5 revision protocol + §7.2 fallback reasons) ────────────────

/**
 * Why a child did not run on the tier it asked for. Reported per item so a
 * misrouted child is diagnosable — without it, "the report is weak", "the lead
 * chose badly" and "the candidate never arrived" look identical from outside.
 *
 * The first three are decidable from tier state alone (`resolveTierSelection`);
 * the rest are observed while putting the brain on the model.
 *
 * `parent_fallback_failed` is terminal, not a fallback: the parent's effective
 * model is the last resort by definition, so a child whose parent restore also
 * fails FAILS rather than trying a third model. Looping here would burn a whole
 * fan-out retrying a broken session.
 */
export type TierFallbackReason =
  | "revision_mismatch"
  | "candidate_missing"
  | "unknown_tier"
  | "model_not_found"
  | "context_overflow"
  | "model_setup_failed"
  | "parent_fallback_failed";

/** Which resolution level produced the outcome, for the per-item report. */
export type TierSelectionSource = "env" | "request" | "type_default" | "inherit";

export type TierResolution =
  | { kind: "tier"; candidate: SubagentTierCandidate }
  /** No tier was asked for, or the deployment has none — today's behaviour. */
  | { kind: "inherit" }
  | { kind: "fallback"; reason: TierFallbackReason };

/**
 * Resolve a requested tier against the spawn snapshot (§5).
 *
 * `menu` is the snapshot the SESSION advertised when its tool schema was built —
 * not the box's current menu. Honouring a newer menu than the one the lead chose
 * from would run a model the operator did not intend for that tier name.
 *
 * The revision comparison is what makes a two-channel disagreement detectable at
 * all. Without it, a menu/candidate skew presents as "tiering silently does
 * nothing", which is indistinguishable from an unconfigured deployment.
 */
export function resolveTierSelection(
  menu: SubagentTierMenu | null | undefined,
  candidates: SubagentTierCandidates | null | undefined,
  requestedTier: string | null | undefined,
): TierResolution {
  const wanted = typeof requestedTier === "string" ? requestedTier.trim() : "";

  // Nothing was asked for: inherit, regardless of what state exists.
  if (wanted === "") return { kind: "inherit" };

  // No tier state at all is not an error — it is an unconfigured deployment. The
  // lead cannot have been shown a menu, so a tier name here came from an env
  // override or a stale schema; either way inheritance is the honest answer.
  if (!menu && !candidates) return { kind: "inherit" };

  // One-sided state means the two channels disagree about whether tiering exists.
  if (!menu || !candidates) return { kind: "fallback", reason: "revision_mismatch" };

  if (menu.revision !== candidates.revision) {
    return { kind: "fallback", reason: "revision_mismatch" };
  }

  // Advertised? A name absent from the menu was never offered to the lead, so it
  // is out of bounds even if a candidate happens to carry it — the menu is the
  // authorization boundary (§3.4), not the candidate list.
  if (!menu.items.some((item) => item.tier === wanted)) {
    return { kind: "fallback", reason: "unknown_tier" };
  }

  const candidate = candidates.candidates.find((entry) => entry.tier === wanted);
  if (!candidate) return { kind: "fallback", reason: "candidate_missing" };

  return { kind: "tier", candidate };
}

/**
 * The immutable tier decision context for ONE `spawn_subagent` dispatch.
 *
 * Captured once, when the tool call is dispatched, and reused by every child of
 * that call: the single-task collapse path, each map child, every later wave of
 * the worker pool, the detached background continuation, and the reduce child.
 *
 * The alternative — each child reading current state as it starts — lets a long
 * batch straddle a configuration change, so its first wave runs one model and the
 * rest another while the reduce merges both into one report where the difference
 * is invisible.
 *
 * `effectiveParent` is a `ModelRouteCandidate`-shaped record rather than an
 * import, keeping this module dependency-free.
 */
export interface SubagentTierPlan {
  menu: SubagentTierMenu | null;
  candidates: SubagentTierCandidates | null;
  /** What the caller asked for; null means "no tier", i.e. inherit. */
  requestedTier: string | null;
  /** Which resolution level produced `requestedTier`. */
  selectionSource?: TierSelectionSource;
  effectiveParent: {
    provider: string;
    modelId: string;
    modelConfig?: Record<string, unknown>;
    /**
     * The tunables in effect on the parent when this plan was captured — the
     * restore target for a child that tried a tier and fell back.
     *
     * Shaped structurally rather than imported, keeping this module dependency
     * free. Absent when the parent turn never went through the routing runner.
     */
    params?: { reasoningEffort?: string };
  } | null;
}

/** What actually happened when a child was put on a model. Feeds the per-item report. */
export interface ChildModelOutcome {
  requestedTier: string | null;
  resolvedTier: string | null;
  source: TierSelectionSource;
  fallbackReason?: TierFallbackReason;
  /** The model the child actually runs on — identifiers only, never credentials. */
  provider?: string;
  modelId?: string;
  /** Set only when even the parent could not be applied; the child must fail. */
  failed?: boolean;
  detail?: string;
}

/**
 * Project the stored CONFIG form into the menu payload.
 *
 * This is the projection that keeps credentials off the menu channel: it copies
 * `tier` and `whenToUse` and drops `provider` / `modelId` entirely, so no caller
 * can leak the model inventory into a tool description by forwarding "the config".
 *
 * The revision must match the one the candidate side computes, so both are derived
 * from the same canonical form — see the Standalone resolver. `computeRevision` is
 * injected rather than imported to keep this module free of node:crypto (it runs in
 * the same bundle as browser-adjacent code).
 *
 * Returns null for absent/empty config, which is the CLEAR signal.
 */
export function projectTierMenuFromConfig(
  entries: unknown,
  computeRevision: (canonical: string) => string,
): SubagentTierMenu | null {
  // A control plane may deliver the menu ALREADY PROJECTED —
  // `{revision, items:[{tier, whenToUse}]}` — rather than the config array. That
  // is the better shape for it to send: the menu channel has no business seeing
  // provider/modelId, so projecting on the producer side discloses strictly less.
  //
  // Handling only the config array made the feature silently absent on exactly
  // those deployments: this returned null, no menu reached the tool description,
  // and `spawn_subagent` never exposed the parameter — with every unit test still
  // green, because they all fed the Standalone shape.
  if (isRecord(entries) && Array.isArray(entries.items)) {
    const normalized = normalizeSubagentTierMenu(entries);
    // Keep the producer's revision: it has to match the one that accompanies the
    // candidates, and recomputing here would be computing it over a projection
    // that no longer carries provider/modelId.
    return normalized.ok ? normalized.value : null;
  }

  // Same rules as every other config reader — including the duplicate and cap
  // checks this branch used to skip, which is how a config the write path would
  // have refused could still produce a menu here.
  const parsed = normalizeSubagentTierConfig(entries);
  if (!parsed.ok || parsed.value.length === 0) return null;

  return {
    revision: computeRevision(canonicalTierConfig(parsed.value)),
    items: parsed.value.map((entry) => ({ tier: entry.tier, whenToUse: entry.whenToUse })),
  };
}

/**
 * The canonical string a tier revision is computed over: sorted by tier, only the
 * fields that define the configuration.
 *
 * Sorting is what makes the revision independent of storage and serialization
 * order — the menu and the candidates are produced by different code paths, and a
 * revision that depended on ordering would report a mismatch for two descriptions
 * of the same configuration.
 */
export function canonicalTierConfig(entries: SubagentTierConfigEntry[]): string {
  return JSON.stringify(
    [...entries]
      .map((e) => ({ tier: e.tier, provider: e.provider, modelId: e.modelId, whenToUse: e.whenToUse }))
      .sort((a, b) => (a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : 0)),
  );
}

/**
 * Render the menu passage for the `spawn_subagent` description.
 *
 * Returns an empty string when there is no menu, and the caller then omits the
 * parameter entirely — in a deployment without tiers the lead never learns the
 * concept exists.
 */
export function renderTierMenuForDescription(menu: SubagentTierMenu | null | undefined): string {
  if (!menu || menu.items.length === 0) return "";
  const lines = menu.items.map((item) => `  ${item.tier} — ${item.whenToUse}`);
  return (
    "\n\nAvailable model_tier values (omit to use this agent's own model):\n" +
    lines.join("\n")
  );
}
