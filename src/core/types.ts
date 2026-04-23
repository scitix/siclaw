/**
 * Shared types used across core/, tools/, and agentbox/ layers.
 *
 * Extracted from agent-factory.ts, deep-search/tool.ts, and dp-tools.ts
 * to eliminate circular type dependencies between core/ and tools/.
 */

import type { MemoryIndexer } from "../memory/indexer.js";

// ── Session mode ──

export type SessionMode = "web" | "channel" | "cli" | "task";

// ── Mutable ref types ──

export interface KubeconfigRef {
  credentialsDir?: string; // path to credentials directory (e.g. /home/agentbox/.credentials)
  /** On-demand credential broker — if set, tools can acquire credentials from Upstream Adapter */
  credentialBroker?: import("../agentbox/credential-broker.js").CredentialBroker;
}

/** Mutable ref to LLM config for deep_search sub-agents (updated by gateway prompt handler) */
export interface LlmConfigRef {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  api?: string;
}

/** Mutable ref to the shared memory indexer (set after session creation). */
export interface MemoryRef {
  indexer?: MemoryIndexer;
  dir?: string;
}

// ── DP lifecycle types ──
//
// Post-refactor (Apr 2026): DP is reduced to a single mode flag. The
// old enum (investigating / awaiting_confirmation / validating / concluding /
// completed), draft / confirmed hypothesis storage, and per-phase state
// were all removed together with the propose_hypotheses / deep_search tool
// pair. See docs/design/2026-04-24-dp-mode-refactor-design.md.

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
