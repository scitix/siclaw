export interface MemoryChunk {
  file: string;       // relative path within memory dir
  heading: string;    // markdown heading context (breadcrumb)
  content: string;    // chunk text
  startLine: number;  // 1-indexed start line in source file
  endLine: number;    // 1-indexed end line (inclusive)
  score?: number;     // search relevance score
}

export interface MemorySearchResult {
  chunks: MemoryChunk[];
  totalFiles: number;
  totalChunks: number;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
  model: string;
  /** Max input tokens per text. Texts exceeding this are truncated before embedding. */
  maxInputTokens?: number;
}

/** Aggregated pattern from multiple past investigations, grouped by root cause category. */
export interface InvestigationPattern {
  rootCauseCategory: string;
  count: number;
  avgConfidence: number;
  validatedHypotheses: string[];
  commonRemediations: string[];
}

export type FeedbackStatus = 'confirmed' | 'corrected' | 'rejected';

/** Retrieval weight multiplier for each feedback status. */
export const FEEDBACK_SIGNALS: Record<FeedbackStatus, number> = {
  confirmed: 1.5,   // boost
  corrected: 0.5,   // partial suppress (data still useful, conclusion wrong)
  rejected: 0.1,    // heavy suppress
};

/** Structured record extracted from a deep investigation conclusion. */
export interface InvestigationRecord {
  id: string;
  question: string;
  rootCauseCategory: string;
  affectedEntities: string[];
  environmentTags: string[];
  causalChain: string[];
  confidence: number;
  conclusion: string;
  remediationSteps?: string[];
  durationMs: number;
  totalToolCalls: number;
  hypotheses: Array<{ id: string; text: string; status: string; confidence: number }>;
  createdAt: number;
  /** Retrieval weight multiplier (default 1.0). Set by investigation_feedback tool. */
  feedbackSignal?: number;
  /** Feedback note: status label + optional user text (e.g. "corrected: actual root cause was X"). */
  feedbackNote?: string;
  /** Timestamp when feedback was submitted. */
  feedbackAt?: number;
}
