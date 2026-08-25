/**
 * The delegation REQUEST context — validation and rendering.
 *
 * Spec: docs/design/2026-08-25-delegation-contract-v1.md §1–§6. This is the request half of the
 * same versioned contract whose result half lives in `delegation-result-budget.ts`.
 *
 * Why a module rather than a few checks at the call site: every rule here has exactly one legal
 * shape, and the value of that is lost if two call sites implement it twice. The three properties
 * worth stating up front, because they are what the rules are FOR:
 *
 *   1. **`targets` is confirmed routing identity; `observations` is leads.** A coordinator does no
 *      hands-on work, so it is structurally incapable of establishing a live fact — everything it
 *      holds is first-hand-but-not-live, second-hand, or reference material. Provenance is the
 *      point of `observations`, not decoration: collapsing those into one "known facts" list is
 *      what launders a candidate into a premise.
 *   2. **There is no free-text escape hatch.** No `known_facts`, no `steps`, no `notes`. The rule
 *      "do not send the specialist your execution steps" cannot be enforced by prompt wording, but
 *      it is enforced by there being nowhere to put them.
 *   3. **Rejection, not truncation, on the way in.** Nothing has run yet, so a caller that sent too
 *      much can send less; silently trimming would drop a user constraint, which is the loss this
 *      contract exists to prevent.
 */

/** Request-side contract generation. Integer ≥ 1. */
export const DELEGATION_REQUEST_SCHEMA_VERSION = 1;

/** §10b: UTF-8 bytes of the serialized request context. */
export const REQUEST_BUDGET_BYTES = 64 * 1024;
/** Bounded twice — a total-bytes cap alone lets one oversized entry crowd out thirty real ones. */
export const MAX_OBSERVATIONS = 32;
export const MAX_OBSERVATION_BYTES = 4 * 1024;
/** §2: one word must not commission work proportional to an agent's whole binding list. */
export const MAX_EXPANDED_TARGETS = 64;

export type DelegationScope = "exact" | "all_peer_bindings" | "discovery";
export type ObservationSource = "user" | "peer_report" | "knowledge_base" | "coordinator_tool";

export type DelegationTarget =
  | { type: "cluster"; cluster_binding: string }
  | { type: "host"; host: string }
  | { type: "k8s_resource"; cluster_binding: string; kind: string; name: string; namespace?: string };

export interface DelegationObservation {
  text: string;
  source: ObservationSource;
  observed_at?: string;
  session_id?: string;
}

export interface DelegationRequestContextV1 {
  schema_version: number;
  mode: "snapshot" | "delta";
  scope?: DelegationScope;
  targets?: DelegationTarget[];
  constraints?: {
    time_window?: { from?: string; to?: string; timezone?: string };
    user_requirements?: string[];
  };
  observations?: DelegationObservation[];
  execution_policy?: {
    /**
     * NOW ENFORCED, on BOTH delegation paths, which is why it carries the real name.
     *
     * It was `requested_access_mode` while the derivation existed on neither side: a field called
     * `access_mode` that only advises would read as an enforcement, and that is worse than no
     * field exactly where it matters. It could not be renamed one path at a time either — a
     * permission that holds for a same-Runtime peer and not a cross-Runtime one is a permission
     * that depends on scheduling.
     *
     * `read_only` maps to `delegation.readOnly`, which filters the peer's toolset down to
     * read-only-delegable tools and gates its MCPs. ABSENT means `normal`: the cautious-looking
     * inverse would strip write tools from every existing remediation delegation.
     */
    access_mode?: "read_only" | "normal";
  };
}

/** A refusal the caller can act on: what was wrong, and where. */
export interface RequestContextRejection {
  rejected_by: string;
  message: string;
  /** The offending target, when one target is at fault. */
  target?: unknown;
}

const encoder = new TextEncoder();
const bytes = (v: string): number => encoder.encode(v).length;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Required-field matrix per target type. A `type` that does not constrain its fields is a type in
 * name only — and `ip` is deliberately absent from every shape: an IP cannot be checked against a
 * binding, so it could never satisfy what `targets` claims about itself. Those belong in
 * `observations`.
 */
function validateTarget(raw: unknown): RequestContextRejection | null {
  if (!raw || typeof raw !== "object") {
    return { rejected_by: "target_shape", message: "each target must be an object", target: raw };
  }
  const t = raw as Record<string, unknown>;
  switch (t.type) {
    case "cluster":
      if (!isNonEmptyString(t.cluster_binding)) {
        return { rejected_by: "target_fields", message: "a cluster target requires cluster_binding", target: raw };
      }
      return null;
    case "host":
      if (!isNonEmptyString(t.host)) {
        return { rejected_by: "target_fields", message: "a host target requires host", target: raw };
      }
      return null;
    case "k8s_resource":
      if (!isNonEmptyString(t.cluster_binding) || !isNonEmptyString(t.kind) || !isNonEmptyString(t.name)) {
        return {
          rejected_by: "target_fields",
          message: "a k8s_resource target requires cluster_binding, kind and name",
          target: raw,
        };
      }
      return null;
    default:
      return {
        rejected_by: "target_type",
        message: `unknown target type ${JSON.stringify(t.type)}; expected cluster, host or k8s_resource`,
        target: raw,
      };
  }
}

/**
 * §2 — exactly ONE legal shape of `targets` per scope. The other three combinations are schema
 * errors, not interpretations.
 *
 * Six states with three defined is how two implementations diverge, and the undefined ones have no
 * honest answer: `discovery` carrying targets would be a guess presented as confirmed identity
 * (candidates belong in `observations`), and `all_peer_bindings` carrying targets is unresolvable —
 * intersection or override is unknowable from the request.
 */
export function validateScopeAndTargets(
  scope: DelegationScope,
  targets: DelegationTarget[] | undefined,
): RequestContextRejection | null {
  const list = targets ?? [];
  switch (scope) {
    case "exact":
      if (list.length === 0) {
        return { rejected_by: "scope_targets", message: "scope=exact asserts the targets are known; targets is empty" };
      }
      return null;
    case "all_peer_bindings":
      if (list.length > 0) {
        return {
          rejected_by: "scope_targets",
          message: "scope=all_peer_bindings expands from the roster; sending targets too is ambiguous " +
            "(intersection or override cannot be inferred) — pick one scope",
        };
      }
      return null;
    case "discovery":
      if (list.length > 0) {
        return {
          rejected_by: "scope_targets",
          message: "scope=discovery means the target is not known yet; a guess is a CANDIDATE and " +
            "belongs in observations, where it carries a source",
        };
      }
      return null;
  }
}

/**
 * Full validation of an incoming context. Returns the first rejection, or null.
 *
 * Order matters only in that cheap structural checks come before the budget, so a malformed
 * request is named for its real problem rather than for its size.
 */
export function validateRequestContext(raw: unknown): RequestContextRejection | null {
  if (!raw || typeof raw !== "object") {
    return { rejected_by: "shape", message: "request_context must be an object" };
  }
  const ctx = raw as Record<string, unknown>;

  const version = ctx.schema_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return {
      rejected_by: "schema_version",
      message: "schema_version must be an integer >= 1; a fraction, NaN, Infinity or non-number " +
        "names no contract",
    };
  }

  if (ctx.mode !== "snapshot" && ctx.mode !== "delta") {
    return { rejected_by: "mode", message: 'mode must be "snapshot" or "delta" — it is never inferred from session_id' };
  }

  // No free-text escape hatch. Checked explicitly rather than left to "we simply do not read it":
  // a field the sender believes is carried is worse than one it knows is refused, and a `notes`
  // string would undo every other rule here.
  for (const forbidden of ["known_facts", "steps", "notes", "extra", "instructions"]) {
    if (forbidden in ctx) {
      return {
        rejected_by: "forbidden_field",
        message: `${forbidden} is not part of this contract: facts go in observations (with a source), ` +
          "and execution steps are the specialist's to choose",
      };
    }
  }

  const targets = ctx.targets as DelegationTarget[] | undefined;
  if (targets !== undefined) {
    if (!Array.isArray(targets)) return { rejected_by: "targets", message: "targets must be an array" };
    for (const t of targets) {
      const bad = validateTarget(t);
      if (bad) return bad;
    }
  }

  // §5 rule: scope and targets are ATOMIC in delta mode. Each omittable independently would demand
  // a legality check on "the new combination" that nobody can perform — the gateway holds no
  // persisted effective context to merge against, by design, because the peer's session is the
  // only thing with continuity.
  if (ctx.mode === "delta") {
    const hasScope = ctx.scope !== undefined;
    const hasTargets = targets !== undefined;
    if (hasScope !== hasTargets) {
      return {
        rejected_by: "delta_atomicity",
        message: "in delta mode scope and targets are atomic: send both or neither. Neither means " +
          "the peer's existing targets stand",
      };
    }
  } else if (ctx.scope === undefined || targets === undefined) {
    return { rejected_by: "snapshot_required", message: "snapshot mode requires scope and targets" };
  }

  if (ctx.scope !== undefined) {
    if (ctx.scope !== "exact" && ctx.scope !== "all_peer_bindings" && ctx.scope !== "discovery") {
      return { rejected_by: "scope", message: `unknown scope ${JSON.stringify(ctx.scope)}` };
    }
    const bad = validateScopeAndTargets(ctx.scope, targets);
    if (bad) return bad;
  }

  // A malformed `constraints` passed validation and then threw a TypeError during RENDERING —
  // `user_requirements: "do not restart"` is a string, and `.filter` on it is not a function. A
  // validator that admits something the renderer cannot handle has moved the failure from a clean
  // 400 to a 500 after the peer session already exists.
  const constraints = ctx.constraints;
  if (constraints !== undefined) {
    if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) {
      return { rejected_by: "constraints", message: "constraints must be an object" };
    }
    const c = constraints as Record<string, unknown>;
    if (c.user_requirements !== undefined) {
      if (!Array.isArray(c.user_requirements) || c.user_requirements.some((r) => typeof r !== "string")) {
        return {
          rejected_by: "user_requirements",
          message: "constraints.user_requirements must be an array of strings — a bare string is the " +
            "commonest shape a model produces here, and it renders as nothing",
        };
      }
    }
    if (c.time_window !== undefined) {
      if (!c.time_window || typeof c.time_window !== "object" || Array.isArray(c.time_window)) {
        return { rejected_by: "time_window", message: "constraints.time_window must be an object" };
      }
      for (const key of ["from", "to", "timezone"]) {
        const v = (c.time_window as Record<string, unknown>)[key];
        if (v !== undefined && typeof v !== "string") {
          return { rejected_by: "time_window", message: `constraints.time_window.${key} must be a string` };
        }
      }
    }
  }

  const observations = ctx.observations;
  if (observations !== undefined) {
    if (!Array.isArray(observations)) {
      return { rejected_by: "observations", message: "observations must be an array" };
    }
    if (observations.length > MAX_OBSERVATIONS) {
      return {
        rejected_by: "observations_count",
        message: `at most ${MAX_OBSERVATIONS} observations; got ${observations.length}`,
      };
    }
    for (const o of observations) {
      if (!o || typeof o !== "object") {
        return { rejected_by: "observation_shape", message: "each observation must be an object" };
      }
      const obs = o as Record<string, unknown>;
      if (!isNonEmptyString(obs.text)) {
        return { rejected_by: "observation_text", message: "each observation requires non-empty text" };
      }
      // The source is REQUIRED, and that is what makes this field safe to carry: without it, a
      // coordinator's own candidate and a peer's measured finding arrive indistinguishable.
      const sources: ObservationSource[] = ["user", "peer_report", "knowledge_base", "coordinator_tool"];
      if (!sources.includes(obs.source as ObservationSource)) {
        return {
          rejected_by: "observation_source",
          message: `each observation requires source ∈ ${sources.join(" | ")} — provenance is what ` +
            "keeps a candidate from being read as a fact",
        };
      }
      if (bytes(obs.text) > MAX_OBSERVATION_BYTES) {
        return {
          rejected_by: "observation_size",
          message: `an observation is at most ${MAX_OBSERVATION_BYTES} UTF-8 bytes`,
        };
      }
    }
  }

  const deltaPolicy = requiresExplicitPolicyOnDelta(ctx as unknown as DelegationRequestContextV1);
  if (deltaPolicy) return deltaPolicy;

  const policy = ctx.execution_policy as Record<string, unknown> | undefined;
  if (policy !== undefined) {
    if (!policy || typeof policy !== "object") {
      return { rejected_by: "execution_policy", message: "execution_policy must be an object" };
    }
    // The transitional name is refused rather than accepted-as-a-synonym: a caller still sending
    // it believes the field only advises, and it now enforces. Silently honouring it would give a
    // peer fewer tools than the caller thinks it asked for.
    if ("requested_access_mode" in policy) {
      return {
        rejected_by: "requested_access_mode_retired",
        message: "the field is now `access_mode` and it is ENFORCED — read_only removes the peer's " +
          "write tools. Rename it, having checked that is what you meant",
      };
    }
    const mode = policy.access_mode;
    // Present-but-invalid is refused rather than defaulted, and the reason is the same one the
    // receiving router states: a typo silently downgraded to `normal` hands a peer write tools the
    // caller believed it had withheld, and nothing says so.
    if (mode !== undefined && mode !== "read_only" && mode !== "normal") {
      return {
        rejected_by: "access_mode",
        message: 'access_mode must be "read_only" or "normal"',
      };
    }
  }

  // Budget last, so a malformed request is named for its real fault. Rejected rather than trimmed:
  // nothing has run, so the caller can send less — and a silent trim would drop a user constraint.
  const serialized = bytes(JSON.stringify(ctx));
  if (serialized > REQUEST_BUDGET_BYTES) {
    return {
      rejected_by: "request_budget",
      message: `request_context is ${serialized} UTF-8 bytes, over the ${REQUEST_BUDGET_BYTES} budget; ` +
        "send fewer observations rather than expecting truncation",
    };
  }

  return null;
}

/**
 * `delegation.readOnly` for this request.
 *
 * One function, read by BOTH dispatch paths, because the alternative is two implementations of a
 * PERMISSION — and a permission that differs by path is one that depends on where the peer happened
 * to be scheduled. Absent context, or absent policy, means `normal`.
 */
export function readOnlyFromRequestContext(ctx: DelegationRequestContextV1 | undefined): boolean {
  return ctx?.execution_policy?.access_mode === "read_only";
}

/**
 * A delta may NOT leave `execution_policy` out.
 *
 * ⚠️ This closes a contradiction between two of this contract's own rules. Rule 5 says an omitted
 * field in a delta means UNCHANGED; the permission derivation above reads an omitted
 * `access_mode` as `normal`. Both are defensible alone, and together they silently upgrade a
 * read-only investigation to read-write on its second turn — the caller changed one constraint,
 * omitted everything it did not mean to touch, and got write tools back.
 *
 * The fix is required-on-delta rather than inherit-from-somewhere, because inheriting needs a
 * persisted effective context the gateway deliberately does not keep (rule 5's own reasoning). So a
 * permission must be restated on every request that carries a context at all. Verbose, and the
 * verbosity is the point: a permission that can be dropped by omission is not a permission.
 */
export function requiresExplicitPolicyOnDelta(ctx: DelegationRequestContextV1): RequestContextRejection | null {
  if (ctx.mode !== "delta") return null;
  if (ctx.execution_policy?.access_mode === undefined) {
    return {
      rejected_by: "delta_policy_required",
      message: "a delta must restate execution_policy.access_mode — the gateway keeps no effective " +
        "context to inherit it from, and treating omission as \"normal\" would silently return " +
        "write tools to a read-only investigation",
    };
  }
  return null;
}

/**
 * Render the context into labelled blocks for the peer's turn.
 *
 * Deterministic and done HERE, never by having the coordinator assemble prose: structure that
 * arrives as a paragraph has bought validation and nothing else. The block names are a contract
 * shared with the specialist prompt that explains them — change one side and the block becomes
 * noise, with no failing test anywhere.
 */
export function renderRequestContext(ctx: DelegationRequestContextV1): string {
  const out: string[] = [];

  if (ctx.targets?.length) {
    const lines = ctx.targets.map((t) => {
      switch (t.type) {
        case "cluster":
          return `- cluster ${t.cluster_binding}`;
        case "host":
          return `- host ${t.host}`;
        case "k8s_resource":
          return `- ${t.kind}/${t.name}${t.namespace ? ` in namespace ${t.namespace}` : " (cluster-scoped)"}` +
            ` on cluster ${t.cluster_binding}`;
      }
    });
    out.push(`[AUTHORITATIVE TARGETS]\n${lines.join("\n")}`);
  } else if (ctx.scope === "discovery") {
    out.push("[AUTHORITATIVE TARGETS]\n(none — the target is not yet identified; establish it yourself)");
  } else if (ctx.scope === "all_peer_bindings") {
    out.push("[AUTHORITATIVE TARGETS]\n(all resources you are bound to)");
  }

  const requirements = ctx.constraints?.user_requirements?.filter(isNonEmptyString) ?? [];
  const window = ctx.constraints?.time_window;
  if (requirements.length || window) {
    const lines: string[] = [];
    if (window) {
      const parts = [
        window.from ? `from ${window.from}` : null,
        window.to ? `to ${window.to}` : null,
        window.timezone ? `(${window.timezone})` : null,
      ].filter(Boolean);
      if (parts.length) lines.push(`- time window: ${parts.join(" ")}`);
    }
    for (const r of requirements) lines.push(`- ${r.trim()}`);
    out.push(`[USER CONSTRAINTS]\n${lines.join("\n")}`);
  }

  if (ctx.observations?.length) {
    const lines = ctx.observations.map((o) => {
      const src = o.source === "peer_report" && o.session_id
        ? `peer_report (session ${o.session_id})`
        : o.source;
      // "unknown" is printed rather than omitted: a dynamic observation with no timestamp is the
      // one most likely to be stale, so the absence has to be visible.
      return `- ${o.text.trim()}\n  source: ${src}\n  observed_at: ${o.observed_at ?? "unknown"}`;
    });
    out.push(
      "[UNVERIFIED OBSERVATIONS]\n" +
      "These are LEADS, not facts. Re-check anything you rely on — they may be second-hand or stale.\n" +
      lines.join("\n"),
    );
  }

  return out.join("\n\n");
}
