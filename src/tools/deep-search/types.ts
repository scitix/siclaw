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
  /** LLM-estimated tool calls needed for validation (from Phase 2). Used for proportional budget allocation. */
  estimatedCalls: number;
  toolCallsUsed: number;
  trace?: TraceStep[];
}

export interface TraceStep {
  type: "llm_reasoning" | "tool_call" | "tool_result";
  content: string;
  tool?: string;
  command?: string;
}

export interface ConclusionResult {
  text: string;
  structured?: {
    root_cause_category: string;
    affected_entities: string[];
    environment_tags: string[];
    causal_chain: string[];
    confidence: number;
    remediation_steps?: string[];
  };
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
  maxContextCalls: 15,  // Fallback only — in DP mode, PL agent handles Phase 1 (triage)
  maxHypotheses: 5,     // Fallback only — in DP mode, PL agent handles Phase 2 (hypotheses)
  maxCallsPerHypothesis: 10,
  maxTotalCalls: 75,    // When Phase 1+2 are skipped, this budget goes to Phase 3 validation
  maxParallel: 3,
  maxDurationMs: 300_000, // 5 minutes
};

export const QUICK_BUDGET: DeepSearchBudget = {
  maxContextCalls: 10,  // Fallback only — in DP mode, PL agent handles Phase 1
  maxHypotheses: 3,     // Fallback only — in DP mode, PL agent handles Phase 2
  maxCallsPerHypothesis: 8,
  maxTotalCalls: 40,
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

/** When a validated hypothesis reaches this confidence, low-confidence pending
 *  hypotheses (below EARLY_EXIT_SKIP_BELOW) are skipped to save budget.
 *  Higher-confidence hypotheses still get validated — real issues often have
 *  multiple contributing factors. */
export const EARLY_EXIT_CONFIDENCE = 85;

/** Hypotheses below this confidence are skipped once early exit triggers.
 *  Hypotheses at or above this threshold are always validated regardless. */
export const EARLY_EXIT_SKIP_BELOW = 60;

/** Debug trace output truncation: max total chars per tool result. */
export const TRACE_MAX_OUTPUT = 2000;
/** Debug trace output truncation: head portion chars. */
export const TRACE_HEAD_CHARS = 1500;
/** Debug trace output truncation: tail portion chars. */
export const TRACE_TAIL_CHARS = 400;
