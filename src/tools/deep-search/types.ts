export type HypothesisStatus = "pending" | "validated" | "invalidated" | "inconclusive" | "skipped";

export interface Evidence {
  tool: string;
  command: string;
  output: string;
  interpretation: string;
}

export interface HypothesisNode {
  id: string;
  text: string;
  confidence: number;
  status: HypothesisStatus;
  evidence: Evidence[];
  reasoning: string;
  suggestedTools: string[];
  toolCallsUsed: number;
  trace?: TraceStep[];
}

export interface TraceStep {
  type: "llm_reasoning" | "tool_call" | "tool_result";
  content: string;
  tool?: string;
  command?: string;
}

export interface InvestigationResult {
  question: string;
  contextSummary: string;
  hypotheses: HypothesisNode[];
  conclusion: string;
  totalToolCalls: number;
  totalDurationMs: number;
  timedOut: boolean;
  debugTracePath?: string;
  /** ID of the investigation record stored in SQLite (for feedback). */
  investigationId?: string;
}

export interface DeepSearchBudget {
  maxContextCalls: number;
  maxHypotheses: number;
  maxCallsPerHypothesis: number;
  maxTotalCalls: number;
  maxParallel: number;
  /** Global investigation timeout in milliseconds. Safety net for runaway investigations. */
  maxDurationMs: number;
}

export const NORMAL_BUDGET: DeepSearchBudget = {
  maxContextCalls: 8,
  maxHypotheses: 5,
  maxCallsPerHypothesis: 10,
  maxTotalCalls: 60,
  maxParallel: 3,
  maxDurationMs: 300_000, // 5 minutes
};

export const QUICK_BUDGET: DeepSearchBudget = {
  maxContextCalls: 5,
  maxHypotheses: 3,
  maxCallsPerHypothesis: 8,
  maxTotalCalls: 30,
  maxParallel: 3,
  maxDurationMs: 180_000, // 3 minutes
};

// --- Sub-agent constants ---

/** Max tokens for Phase 2/4 LLM completions (hypothesis generation, conclusion). */
export const LLM_COMPLETE_MAX_TOKENS = 4096;

/** Safety timeout (ms) after budget exhausted — force-abort if LLM ignores steer. */
export const BUDGET_ABORT_TIMEOUT_MS = 10_000;

/** Timeout (ms) for Phase 4 conclusion LLM call. Falls back to data-driven summary on timeout. */
export const CONCLUSION_TIMEOUT_MS = 60_000;

/** Evidence output truncation: max total chars kept per tool result. */
export const EVIDENCE_MAX_OUTPUT = 4000;
/** Evidence output truncation: head portion chars. */
export const EVIDENCE_HEAD_CHARS = 2000;
/** Evidence output truncation: tail portion chars. */
export const EVIDENCE_TAIL_CHARS = 1500;

// --- Engine constants ---

/** Early exit threshold: skip remaining hypotheses if one reaches this confidence.
 *  Set to 101 to effectively disable early exit (validate all hypotheses by default).
 *  Lower to 80 to re-enable root-cause-first mode. */
export const EARLY_EXIT_CONFIDENCE = 101;

/** Debug trace output truncation: max total chars per tool result. */
export const TRACE_MAX_OUTPUT = 2000;
/** Debug trace output truncation: head portion chars. */
export const TRACE_HEAD_CHARS = 1500;
/** Debug trace output truncation: tail portion chars. */
export const TRACE_TAIL_CHARS = 400;
