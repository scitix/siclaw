/**
 * Capability contract — the generic, capability-agnostic protocol between a
 * siclaw runtime capability (a profile-shaped box driven by the runtime) and a
 * consumer control plane (sicore, gpu-cloud, ...).
 *
 * This GENERALIZES the deleted compile.* bolt-on into ONE vocabulary, so a
 * consumer implements a single thin adapter instead of a bespoke protocol per
 * capability. Ownership split:
 *   - siclaw owns EXECUTION: box + tools + lifecycle + a small execution-state store.
 *   - the consumer owns the DOMAIN: knowledge content + governance + frontend.
 *
 * Contradiction handling is a NORMAL turn (a capability.message), not an async
 * protocol — the model never blocks on a human, so there is no awaiting_input /
 * parked frame. "Async" only means the user rules at their leisure; applying a
 * ruling is just another message injected when the session is idle.
 *
 * ── WIRE RULE ─────────────────────────────────────────────────────────────────
 * Every interface below IS the wire shape: field names are snake_case, exactly
 * as serialized on the WS frames and parsed by the Go consumer adapter
 * (sicore internal/siclaw/capability/contract.go mirrors these). Producers and
 * handlers MUST build/read payloads through these types — do not hand-write
 * payload literals with other casings; a mismatched key is read as a zero value
 * on the other side and the data is silently dropped.
 */

// ---- Wire vocabulary (method names) ----

/** Consumer → siclaw: start / drive / cancel a capability run. */
export const CAPABILITY_START = "capability.start" as const;
export const CAPABILITY_MESSAGE = "capability.message" as const;
export const CAPABILITY_CANCEL = "capability.cancel" as const;

/** siclaw → consumer: live stream + content sink + input fetch. */
export const CAPABILITY_EVENT = "capability.event" as const;
export const CAPABILITY_PERSIST_ARTIFACT = "capability.persistArtifact" as const;
export const CAPABILITY_FETCH_INPUT = "capability.fetchInput" as const;

/**
 * siclaw → consumer: opaque run-state store (option B). siclaw OWNS the execution
 * run; the consumer persists it as a dumb store so an in-flight run survives a
 * stateless-runtime restart. getRun is part of the consumer's store obligation
 * even though the runtime currently only calls persist + listActiveRuns.
 */
export const CAPABILITY_PERSIST_RUN_STATE = "capability.persistRunState" as const;
export const CAPABILITY_GET_RUN = "capability.getRun" as const;
export const CAPABILITY_LIST_ACTIVE_RUNS = "capability.listActiveRuns" as const;

/** Durably persist an assistant conversational turn (generalizes compile.assistantTurn). */
export const CAPABILITY_PERSIST_TURN = "capability.persistTurn" as const;

// ---- Lifecycle ----

export type CapabilityLifecycleStatus = "running" | "idle" | "done" | "failed";

/**
 * The lifecycle values that mean a run is FINISHED. Shared contract, not
 * convention: the runtime's watchdog/endRun and the consumer's active-run
 * filtering (`status NOT IN terminal`) must agree, or a status one side treats
 * as terminal becomes an immortal "active" zombie on the other. The Go mirror
 * is capability.TerminalStatuses (contract.go) — change both together.
 */
export const CAPABILITY_TERMINAL_STATUSES = ["done", "failed"] as const satisfies readonly CapabilityLifecycleStatus[];
export type CapabilityTerminalStatus = (typeof CAPABILITY_TERMINAL_STATUSES)[number];

export function isTerminalCapabilityStatus(s: CapabilityLifecycleStatus): s is CapabilityTerminalStatus {
  return (CAPABILITY_TERMINAL_STATUSES as readonly string[]).includes(s);
}

// ---- Consumer → siclaw ----

export interface CapabilityStartRequest {
  /** BoxProfile name selecting the box shape + tool/trust envelope (e.g. "kb-compile", "kb-test"). */
  profile: string;
  /** Consumer org owning the run — scopes the persisted run row (SSE gate / listing). */
  org_id?: string;
  /**
   * Correlates this run to a consumer-domain object (e.g. an AuthoringAttempt).
   * Carried on both sides so neither has to double-write the linkage.
   */
  correlation_id?: string;
  /** Capability input — opaque to the transport; the box interprets it (e.g. instruction, repo ref). */
  input?: Record<string, unknown>;
}

export interface CapabilityStartResponse {
  /** siclaw-owned execution run id (the address for subsequent message/cancel/event). */
  run_id: string;
}

export interface CapabilityMessageRequest {
  run_id: string;
  /**
   * A conversational turn injected into the live session — a compile instruction,
   * a plain chat turn, or "apply these rulings: ..." (contradiction writeback).
   * The run's profile/org come from the run record minted at start, not the frame.
   */
  message: string;
}

export interface CapabilityCancelRequest {
  run_id: string;
}

// ---- siclaw → consumer ----

/**
 * Live stream frame types. GENERALIZES the box `log`/`turn_done`/`summary`
 * events + run lifecycle. NO awaiting_input / parked (see file header).
 */
export type CapabilityEventType =
  | "log" //       agent reasoning / progress narration      (was box `log`)
  | "turn" //      a turn ended; payload.text = assistant reply (was box `turn_done`)
  | "summary" //   a progress summary
  | "lifecycle"; // run lifecycle transition; payload.status

export interface CapabilityEventPayload {
  /** type = log | summary | turn: human/agent text. */
  text?: string;
  /** type = lifecycle: the new lifecycle status. */
  status?: CapabilityLifecycleStatus;
  /** type = lifecycle + failed: error detail. */
  error?: string;
}

export interface CapabilityEventFrame {
  run_id: string;
  type: CapabilityEventType;
  payload: CapabilityEventPayload;
}

/**
 * Opaque run-state row persisted to the consumer's store on every lifecycle
 * transition (option B). This is the persistRunState REQUEST shape.
 */
export interface CapabilityRunState {
  run_id: string;
  org_id: string;
  correlation_id: string;
  profile: string;
  status: CapabilityLifecycleStatus;
  /** Opaque resume blob (JSON-serializable). Reserved — no writer yet. */
  checkpoint?: unknown;
  /** Box session id (for resume). Reserved — no writer yet. */
  session_ref: string;
  /** Which runtime owns the box. */
  runtime_id: string;
}

export interface CapabilityGetRunRequest {
  run_id: string;
}

/**
 * A run row as RETURNED by the consumer's store (getRun / listActiveRuns).
 * getRun returns the row directly (null when unknown).
 * NOTE the asymmetry: the store's primary key serializes as `id`, not `run_id`
 * (it is the consumer's DB row, json-tagged `id` on the Go model).
 */
export interface CapabilityRunRow {
  id: string;
  org_id?: string;
  correlation_id?: string;
  profile?: string;
  status?: CapabilityLifecycleStatus;
  checkpoint?: unknown;
  session_ref?: string;
  runtime_id?: string;
}

export interface CapabilityListActiveRunsResponse {
  runs?: CapabilityRunRow[];
}

/** Durable assistant-turn sink (the consumer writes it to its message store). */
export interface CapabilityPersistTurnRequest {
  run_id: string;
  /** Full assistant reply for the turn. Empty text is a consumer-side no-op. */
  text: string;
}

/**
 * Content sink. GENERALIZES compile.syncArtifacts + the compile.done bundle.
 * Knowledge content the box produced is written into the CONSUMER's store;
 * siclaw never persists knowledge content itself (only execution state).
 */
export interface CapabilityPersistArtifactRequest {
  run_id: string;
  /** Logical path within the capability workspace, e.g. "candidate/00-intro.md". */
  path: string;
  content: CapabilityContentRef;
}

export interface CapabilityContentRef {
  /** Inline content, base64-encoded. (A blob-ref variant can be added later without breaking callers.) */
  inline_base64?: string;
}

/**
 * fetchInput ref selecting the durable authoring-workspace bundle (rehydrates a
 * fresh box's authoring/candidate state). The default (empty ref) is the frozen
 * raw-source bundle. Go mirror: capability.InputRefWorkspace.
 */
export const CAPABILITY_INPUT_WORKSPACE_REF = "workspace" as const;

/**
 * Input fetch. GENERALIZES compile.sourceBundle. siclaw asks the consumer for
 * the frozen source/config to materialize into the box; the consumer owns it
 * and resolves WHAT to freeze from the run's correlation.
 */
export interface CapabilityFetchInputRequest {
  run_id: string;
  /** Input kind: "" = frozen raw sources; CAPABILITY_INPUT_WORKSPACE_REF = durable workspace. */
  ref?: string;
}

export interface CapabilityFetchInputResponse {
  bundle_base64?: string;
  bundle_sha256?: string;
}
