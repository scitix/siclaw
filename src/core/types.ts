/**
 * Shared types used across core/, tools/, and agentbox/ layers.
 *
 * Extracted from agent-factory.ts, deep-search/tool.ts, and dp-tools.ts
 * to eliminate circular type dependencies between core/ and tools/.
 */

import type { MemoryIndexer } from "../memory/indexer.js";

// ── Session mode ──

export type SessionMode = "web" | "channel" | "cli";

// ── Mutable ref types ──

export interface KubeconfigRef {
  credentialsDir?: string; // path to credentials directory (e.g. /home/agentbox/.credentials)
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

export type DpStatus =
  | "idle"                    // No investigation active
  | "investigating"           // Model is triaging / gathering context
  | "awaiting_confirmation"   // Hypotheses presented, waiting for user decision
  | "validating"              // User confirmed — deep_search executing Phase 3
  | "concluding"              // Phase 4 or user skipped validation — model presenting conclusion
  | "completed";              // Investigation finished

export interface DpHypothesis {
  id: string;
  text: string;
  confidence: number;
  description?: string;
}

/**
 * Writable version of DpStateRef — held only by the extension (single writer).
 * Tools and agentbox receive the readonly DpStateRef view of the same object.
 */
export interface MutableDpStateRef {
  status: DpStatus;
  triageContextDraft?: string;
  confirmedHypotheses?: DpHypothesis[];
  question?: string;
  round?: number;
}

/**
 * Read-only ref for tools that need to inspect DP state without mutating it.
 * Derived from MutableDpStateRef to guarantee both types stay in sync.
 */
export type DpStateRef = Readonly<MutableDpStateRef>;
