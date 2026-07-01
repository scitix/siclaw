/**
 * Capability contract — the generic, capability-agnostic protocol between a
 * siclaw runtime capability (a profile-shaped box driven by the runtime) and a
 * consumer control plane (sicore, gpu-cloud, ...).
 *
 * This GENERALIZES the compile.* bolt-on (see agentbox/compile-driver.ts) into
 * ONE vocabulary, so a consumer implements a single thin adapter instead of a
 * bespoke protocol per capability. Ownership split:
 *   - siclaw owns EXECUTION: box + tools + lifecycle + a small execution-state store.
 *   - the consumer owns the DOMAIN: knowledge content + governance + frontend.
 *
 * Contradiction handling is a NORMAL turn (a capability.message), not an async
 * protocol — the model never blocks on a human, so there is no awaiting_input /
 * parked frame. "Async" only means the user rules at their leisure; applying a
 * ruling is just another message injected when the session is idle.
 *
 * ⚠️ P0 — TYPES ONLY. Nothing here is wired to a handler or dispatcher yet; the
 * runtime still drives compile via compile.* until Slice B swaps the transport.
 * Field shapes deliberately mirror what compile-driver.ts already moves.
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

// ---- Consumer → siclaw ----

export interface CapabilityStartRequest {
  /** BoxProfile name selecting the box shape + tool/trust envelope (e.g. "kb-compile", "kb-test"). */
  profile: string;
  /** Capability input — opaque to the transport; the box interprets it (e.g. KB repo ref, model, org). */
  input?: Record<string, unknown>;
  /**
   * Correlates this run to a consumer-domain object (e.g. an AuthoringAttempt).
   * Carried on both sides so neither has to double-write the linkage.
   */
  correlationId?: string;
}

export interface CapabilityStartResponse {
  /** siclaw-owned execution run id (the address for subsequent message/cancel/event). */
  runId: string;
}

export interface CapabilityMessageRequest {
  runId: string;
  /**
   * A conversational turn injected into the live session — a compile instruction,
   * a plain chat turn, or "apply these rulings: ..." (contradiction writeback).
   */
  message: string;
}

export interface CapabilityCancelRequest {
  runId: string;
}

// ---- siclaw → consumer ----

/**
 * Live stream frame types. GENERALIZES compile.event + compile.summary +
 * compile.assistantTurn + the box `log`/`done`/`error`/`end` events.
 * NO awaiting_input / parked (see file header).
 */
export type CapabilityEventType =
  | "log" //       agent reasoning / progress narration      (was box `log`)
  | "turn" //      a turn ended; payload.text = assistant reply (was compile.assistantTurn / box `turn_done`)
  | "summary" //   a progress summary                          (was compile.summary)
  | "lifecycle"; // run lifecycle transition; payload.status   (was compile.done / compile.failed / box `end`)

export type CapabilityLifecycleStatus = "running" | "idle" | "done" | "failed";

export interface CapabilityEventPayload {
  /** type = log | summary | turn: human/agent text. */
  text?: string;
  /** type = lifecycle: the new lifecycle status. */
  status?: CapabilityLifecycleStatus;
  /** type = lifecycle + failed: error detail. */
  error?: string;
}

export interface CapabilityEvent {
  runId: string;
  type: CapabilityEventType;
  payload: CapabilityEventPayload;
}

/**
 * Content sink. GENERALIZES compile.syncArtifacts + the compile.done bundle.
 * Knowledge content the box produced is written into the CONSUMER's store;
 * siclaw never persists knowledge content itself (only execution state).
 */
export interface CapabilityPersistArtifactRequest {
  runId: string;
  /** Logical path within the capability workspace, e.g. "candidate/00-intro.md". */
  path: string;
  content: CapabilityContentRef;
}

export interface CapabilityContentRef {
  /** Inline content, base64-encoded. (A blob-ref variant can be added later without breaking callers.) */
  inlineBase64?: string;
}

/**
 * Input fetch. GENERALIZES compile.sourceBundle. siclaw asks the consumer for
 * the frozen source/config to materialize into the box; the consumer owns it.
 */
export interface CapabilityFetchInputRequest {
  runId: string;
  /** What to fetch, e.g. a source-manifest ref. */
  ref: string;
}

export interface CapabilityFetchInputResponse {
  bundleBase64?: string;
  bundleSHA256?: string;
}
