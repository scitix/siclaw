/**
 * Diagnostic event bus — lightweight decoupling layer for observability.
 *
 * Business code emits events via emitDiagnostic(). Subscribers (e.g. metrics.ts)
 * consume them without the emitter knowing or caring about prom-client / OTel / logs.
 *
 * Design choices:
 * - Plain callback array (not EventEmitter) — try-catch protects callers from subscriber errors
 * - Zero external dependencies — safe to import from any module
 * - Synchronous dispatch — O(1) per subscriber, no event loop overhead
 */

import type { BrainSessionStats, BrainModelInfo } from "../core/brain-session.js";

// ── Event types ──

export type DiagnosticEvent =
  // Prompt lifecycle
  | {
      type: "prompt_complete";
      sessionId: string;
      prev: BrainSessionStats;
      curr: BrainSessionStats;
      model: BrainModelInfo | undefined;
      durationMs: number;
      outcome: "completed" | "error";
      userId?: string;
    }
  // Session lifecycle
  | { type: "session_created"; sessionId: string }
  | { type: "session_released"; sessionId: string }
  // Tool execution
  | {
      type: "tool_call";
      toolName: string;
      outcome: "success" | "error";
      durationMs: number;
      userId: string;
      agentId: string | null;
    }
  // WebSocket connections (Gateway)
  | { type: "ws_connected" }
  | { type: "ws_disconnected" }
  // Context window usage (Phase 2)
  | {
      type: "context_usage";
      provider: string;
      model: string;
      tokensUsed: number;
      tokensLimit: number;
    }
  // Skill execution (Skill Metrics)
  | {
      type: "skill_call";
      skillName: string;
      scriptName: string;
      scope: "builtin" | "global";
      outcome: "success" | "error";
      durationMs: number;
      sessionId?: string;
      userId: string;
      agentId: string | null;
    }
  // Stuck session detection (Phase 2)
  | { type: "session_stuck"; sessionId: string; idleMs: number };

// ── Event bus ──

type Listener = (event: DiagnosticEvent) => void;
const listeners: Listener[] = [];

/**
 * Emit a diagnostic event. All registered listeners are called synchronously.
 * Listener exceptions are caught and logged — never propagated to the caller.
 */
export function emitDiagnostic(event: DiagnosticEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      console.warn("[diagnostic] listener error:", err);
    }
  }
}

/**
 * Subscribe to diagnostic events. Returns an unsubscribe function.
 */
export function onDiagnostic(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}
