/**
 * Capability contract — the generic, capability-agnostic protocol between a
 * siclaw runtime capability (a profile-shaped box driven by the runtime) and a
 * consumer control plane (any downstream platform).
 *
 * This GENERALIZES the deleted compile.* bolt-on into ONE vocabulary, so a
 * consumer implements a single thin adapter instead of a bespoke protocol per
 * capability. Ownership split:
 *   - siclaw owns EXECUTION: box + tools + lifecycle + a small execution-state store.
 *   - the consumer owns the DOMAIN: knowledge content + governance + frontend.
 *
 * Contradiction handling is not a parked/awaiting-input protocol: the model
 * never blocks on a human. The user rules at their leisure, then the product
 * submits a typed compile.apply_rulings command when the session is idle.
 *
 * ── WIRE RULE ─────────────────────────────────────────────────────────────────
 * Every interface below IS the wire shape: field names are snake_case, exactly
 * as serialized on the WS frames and parsed by the Go consumer adapter
 * (the consumer's Go adapter mirrors these in its own contract.go). Producers and
 * handlers MUST build/read payloads through these types — do not hand-write
 * payload literals with other casings; a mismatched key is read as a zero value
 * on the other side and the data is silently dropped.
 */

// ---- Wire vocabulary (method names) ----

/** Consumer → siclaw: start / drive / cancel a capability run. */
export const CAPABILITY_START = "capability.start" as const;
export const CAPABILITY_MESSAGE = "capability.message" as const;
export const CAPABILITY_COMMAND = "capability.command" as const;
export const CAPABILITY_CANCEL = "capability.cancel" as const;

/**
 * Consumer → siclaw: read-only TEST SESSION over a run's pinned draft snapshot
 * (the product's "起测试会话" / start-a-test-session flow). A test session
 * REUSES the authoring run's live box (no new pod):
 * the box pins candidate/ into an immutable snapshot and hosts an ephemeral,
 * tool-whitelisted consumer session over it. STATELESS by contract — nothing a
 * test session says is persisted (no persistTurn/persistArtifact); its frames
 * are live-only capability.event {type:"test"} on the parent run.
 */
export const CAPABILITY_TEST_START = "capability.testStart" as const;
export const CAPABILITY_TEST_MESSAGE = "capability.testMessage" as const;
export const CAPABILITY_TEST_CLOSE = "capability.testClose" as const;
export const CAPABILITY_TEST_RECOMMEND = "capability.testRecommend" as const;

/** siclaw → consumer: live stream + content sink + input fetch. */
export const CAPABILITY_EVENT = "capability.event" as const;
export const CAPABILITY_PERSIST_ARTIFACTS = "capability.persistArtifacts" as const;
export const CAPABILITY_FETCH_INPUT = "capability.fetchInput" as const;

/**
 * siclaw → consumer: opaque run-state store (option B). siclaw OWNS the execution
 * run; the consumer persists it as a dumb store so an in-flight run survives a
 * stateless-runtime restart. The runtime calls persist + listActiveRuns (boot/
 * reconcile recovery) and getRun (adopt + the reap re-check).
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

/**
 * Content-free execution failure diagnostic persisted inside the opaque run
 * checkpoint. Values are deliberately machine fields only: source text, tool
 * input/output, provider responses, and credentials must never enter it.
 */
export interface CapabilityRunFailure {
  code: string;
  stage: string;
  attempts?: number;
  idle_s?: number;
  bound_s?: number;
  tool_pending?: boolean;
  last_sdk_message?: string;
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
  /**
   * Immutable consumer input selected for this run. New consumers pin it at
   * start so Runtime can durably checkpoint it before spawning/materializing a
   * box. Absent preserves the rolling-compatible fetch-then-checkpoint path.
   */
  input_revision?: string;
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
   * Consumer-minted idempotency key for this conversational turn. Optional for
   * rolling compatibility; retries carrying the same id must be accepted once.
   */
  message_id?: string;
  /**
   * A genuine conversational turn injected into the live session. Product
   * controls use CapabilityCommandRequest; old fixed-prefix controls are only
   * a temporary box compatibility adapter.
   * The run's profile/org come from the run record minted at start, not the frame.
   */
  message: string;
}

/**
 * Versioned machine-control envelope. The runtime validates only this common
 * shape and transports `command` opaquely to the selected BoxProfile. Action
 * names and parameters belong to the box implementation; human-language text
 * must never be used as the discriminator.
 */
export interface CapabilityCommandRequest {
  run_id: string;
  /** Consumer-owned idempotency key. */
  command_id: string;
  command: {
    version: number;
    action: string;
    /** Consumer-domain mutation receipt; opaque to the runtime. */
    operation_id: string;
    /** Consumer-domain write-fencing epoch; opaque to the runtime. */
    generation: number;
    parameters?: Record<string, unknown>;
  };
}

export interface CapabilityCancelRequest {
  run_id: string;
}

export interface CapabilityCancelResponse {
  ok: true;
  run_id: string;
  /**
   * True only after the AgentBox termination request was accepted (or the box
   * was already absent). Runtime lifecycle terminalization is initiated first;
   * domain consumers must still fence their own writers before cancellation.
   */
  stop_confirmed: true;
}

// ---- Test session (read-only consumer probe over a pinned draft snapshot) ----

export interface CapabilityTestStartRequest {
  /** The AUTHORING run whose live box + current draft the test session pins. */
  run_id: string;
  /**
   * Optional consumer-provided snapshot (base64 tar.gz of root-level wiki
   * pages, e.g. a PUBLISHED version bundle). When set, the box pins THIS
   * content instead of packing the run's candidate/ draft — the snapshot
   * source generalizes to {draft, published version} with the same hash
   * formula, so gradings stay comparable across sources.
   */
  bundle_base64?: string;
  /** sha256 of the bundle bytes; the box verifies it at install time. */
  bundle_sha256?: string;
}

export interface CapabilityTestStartResponse {
  run_id: string;
  test_session_id: string;
  /** sha256 over the pinned Wiki content side of the regression-round identity. */
  snapshot_hash: string;
  /** sha256 over the answer-affecting consumer prompt/model/SDK/tool/turn contract. */
  consumer_fingerprint: string;
  /** Page count of the pinned snapshot. */
  pages: number;
}

export interface CapabilityTestMessageRequest {
  run_id: string;
  test_session_id: string;
  message: string;
}

export interface CapabilityTestCloseRequest {
  run_id: string;
  test_session_id: string;
}

/**
 * Explicit, owner-triggered red-team authoring of one regression test.
 * This is deliberately separate from compilation: the one-shot session can
 * read raw/ and candidate/ but cannot mutate either tree. The reference answer
 * is returned to the control plane and is never sent to the blind test consumer.
 */
export interface CapabilityTestRecommendRequest {
  run_id: string;
}

export interface CapabilityTestRecommendResponse {
  run_id: string;
  question: string;
  reference_answer: string;
  evidence_paths: string[];
}

export interface CapabilityTestCloseResponse {
  ok: true;
  run_id: string;
  test_session_id: string;
  /**
   * Authoritative fence: true only after the box acknowledged teardown or the
   * Runtime verified that the hosting box no longer exists. Consumers must not
   * unlock Raw writes from a legacy `ok` / `already_closed` response alone.
   */
  close_confirmed: true;
  already_closed?: true;
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
  | "lifecycle" // run lifecycle transition; payload.status
  | "test"; //     read-only test-session frame; payload.test_session_id + payload.kind

export interface CapabilityEventPayload {
  /** type = log | summary | turn | test: human/agent text. */
  text?: string;
  /** type = lifecycle: the new lifecycle status. */
  status?: CapabilityLifecycleStatus;
  /** type = lifecycle + failed: error detail. */
  error?: string;
  /** type = test: which test session this frame belongs to. */
  test_session_id?: string;
  /** type = test: inner frame kind (session | log | turn_done | error | end). */
  kind?: string;
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
  /** Opaque resume blob; KB runs checkpoint input revision and accepted message ids here. */
  checkpoint?: unknown;
  /**
   * Box session id, reserved for a future where the box persists its session and
   * a resume needs it. Deliberately has NO writer: continuity today is workspace-
   * file rehydration + routing by run_id, not session-id resume (adopt/recover
   * carry any stored value through, but nothing sets or consumes it).
   */
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
 *
 * Deletions travel as TOMBSTONES (`deleted: true`, no content): the box's sync
 * is per-path diffs, so without them a file the agent deleted (page merge,
 * rename, restructure) would leave an orphan row the consumer publishes and the
 * next workspace rehydration resurrects. The old compile.done full-bundle
 * replace covered this implicitly; the generalization must carry it explicitly.
 * DEPLOY ORDER: the consumer must understand `deleted` before a box that emits
 * it rolls out — an older consumer would treat the tombstone as an empty-content
 * upsert.
 */
export interface CapabilityPersistArtifactRequest {
  run_id: string;
  /** Immutable input revision materialized into this run. */
  input_revision?: string;
  /** Logical path within the capability workspace, e.g. "candidate/00-intro.md". */
  path: string;
  /** Present on add/update; absent when `deleted` is set. */
  content?: CapabilityContentRef;
  /** Tombstone: delete the row for `path` from the consumer's store. */
  deleted?: boolean;
}

/** Atomic content batch. One box sync event is committed all-or-nothing. */
export interface CapabilityPersistArtifactsRequest {
  run_id: string;
  input_revision?: string;
  /** Explicit full-compile commit; replay/content presence alone never advances provenance. */
  commit_input?: boolean;
  artifacts: Array<Omit<CapabilityPersistArtifactRequest, "run_id" | "input_revision">>;
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
  /** Recovery pin: return this exact immutable source manifest instead of freezing current raw. */
  input_revision?: string;
}

/**
 * LLM connection settings installed into one capability box at session setup.
 *
 * The object is an authority boundary, not a bag of field-level overrides:
 * when the consumer supplies it, Runtime must forward that object as-is and
 * must not fill missing fields with Runtime credentials. Only an entirely
 * absent consumer object may fall back to Runtime's Helm-provided environment.
 */
export interface CapabilityLlmConfig {
  base_url?: string;
  auth_token?: string;
  api_key?: string;
  model?: string;
}

export interface CapabilityFetchInputResponse {
  bundle_base64?: string;
  bundle_sha256?: string;
  /** Immutable consumer input revision represented by the source bundle. */
  input_revision?: string;
  /**
   * Consumer-declared prompt/output locale for the run's box (e.g. "zh").
   * Locale is DOMAIN config — the tenant/KB's language — so it rides this
   * consumer-config channel, not the run row. Absent ⇒ the platform default
   * (English prompt packs).
   */
  locale?: string;
  /**
   * Consumer-managed LLM endpoint for the run's box (DESIGN-kb-llm-binding-v2).
   * The consumer owns the credential store; Runtime passes this whole object
   * OPAQUELY into the box /session body and MUST NOT log it or merge a Runtime
   * credential into missing fields. Only an absent object uses Runtime's
   * Helm-provided ANTHROPIC_* values, also delivered through /session so
   * credentials never enter the KB PodSpec.
   */
  llm?: CapabilityLlmConfig;
  /**
   * Consumer-managed box behavior knobs, keyed by the box's OWN env vocabulary
   * (KBC_* — model tiers, PK/media-verify switches, budgets). Same wire shape
   * as the env fallback so v1/v2 share one semantics; the box whitelists keys.
   */
  settings?: Record<string, string>;
}
