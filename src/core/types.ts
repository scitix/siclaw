/**
 * Shared types used across core/, tools/, and agentbox/ layers.
 *
 * Originally extracted to break a circular dependency between core/ and the
 * now-deleted deep-search / dp-tools modules. The types that survived the
 * Apr 2026 DP refactor continue to live here.
 */

import type { MemoryIndexer } from "../memory/indexer.js";

// ── Session mode ──

export type SessionMode = "web" | "channel" | "cli" | "task";

// ── Delegation (agent-to-agent, siclaw-native via the gateway) ──

/**
 * Entry-form of a prompt, as stamped by the caller (web / api / a2a / channel /
 * cron). Used for audit categorization and to carry the entry context into a
 * delegated turn. `undefined` ⇒ web.
 */
export type OriginKind = "web" | "api" | "a2a" | "channel" | "task";

/**
 * Present when this turn was delegated by a coordinator agent to a peer,
 * siclaw-native via the gateway's internal delegate API. Its presence marks the
 * turn as delegated; `readOnly` carries the permission tier. Carried end-to-end
 * from the delegate request to the worker's ToolRefs so the worker can (a) gate
 * its toolset read-only when asked and (b) stamp the result artifact with
 * `delegationId`.
 *
 * Wire contract: see docs/design/agent-delegation.md.
 */
export interface DelegationContext {
  /** Correlates this delegated turn back to the coordinator's delegation record. */
  delegationId: string;
  /** Coordinator's session id (metadata; not load-bearing for the worker). */
  parentSessionId?: string;
  /** Coordinator's agent id (metadata; not load-bearing for the worker). */
  parentAgentId?: string;
  /**
   * Permission tier. Default `false`: the peer runs under ITS OWN configuration
   * (capabilities / persona / model) — coordinator and worker manage their
   * permissions independently, so delegation does NOT downgrade the peer.
   * `true` is an explicit opt-in that filters the worker's toolset to
   * read-only-delegable tools only; it is not imposed by the delegate transport.
   */
  readOnly: boolean;
}

// ── Mutable ref types ──

export interface KubeconfigRef {
  credentialsDir?: string; // path to credentials directory (e.g. /home/agentbox/.credentials)
  /** On-demand credential broker — if set, tools can acquire credentials from Upstream Adapter */
  credentialBroker?: import("../agentbox/credential-broker.js").CredentialBroker;
}

/** Mutable ref to the shared memory indexer (set after session creation). */
export interface MemoryRef {
  indexer?: MemoryIndexer;
  dir?: string;
}

// ── DP lifecycle types ──
//
// Post-refactor (Apr 2026): DP is reduced to a single mode flag. The old
// enum (investigating / awaiting_confirmation / validating / concluding /
// completed), draft / confirmed hypothesis storage, and per-phase state
// were all removed together with the propose_hypotheses / deep_search /
// end_investigation tool trio. See
// docs/design/2026-04-24-dp-mode-refactor-design.md.

/**
 * Writable version of DpStateRef — held only by the extension (single writer).
 * Agentbox and other consumers receive the readonly DpStateRef view.
 */
export interface MutableDpStateRef {
  active: boolean;
}

/**
 * Read-only ref for consumers that need to observe DP state without mutating it.
 */
export type DpStateRef = Readonly<MutableDpStateRef>;
