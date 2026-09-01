import type { MemorySearchResult } from "../memory/types.js";

export interface KnowledgeSearchIndex {
  search(query: string, topK?: number, minScore?: number): Promise<MemorySearchResult>;
}

export type KnowledgeLookupStatus = "direct_hit" | "explore" | "unavailable";

export interface KnowledgeEvidenceSection {
  heading: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface KnowledgeEvidencePage {
  rank: number;
  file: string;
  title: string;
  score: number;
  /** Conservative routing confidence; it is not answer confidence. */
  routingConfidence: number;
  /** Stable identity for the exact page snapshot returned by this lookup. */
  resultId?: string;
  /** Fraction of question terms matched by page identity/frontmatter. */
  metadataScore?: number;
  metadata?: {
    type?: string;
    description?: string;
    tags?: string[];
    timestamp?: string;
  };
  readMode: "full_page" | "matched_sections";
  truncated: boolean;
  citationMode: "evidence" | "page" | "none";
  evidenceRefs?: string[];
  sections: KnowledgeEvidenceSection[];
}

/**
 * An unverified page hypothesis for Agent-led Wiki exploration. Hints carry no
 * page body and are never registered as answer evidence.
 */
export interface KnowledgeExplorationHint {
  rank: number;
  file: string;
  title: string;
  score: number;
  routingConfidence: number;
  metadataScore?: number;
  passageScore?: number;
  metadata?: KnowledgeEvidencePage["metadata"];
}

export interface KnowledgeNavigationResult {
  file: string;
  heading: string;
  score: number;
}

export interface KnowledgeLookupResult {
  status: KnowledgeLookupStatus;
  mode: "accelerator";
  query: string;
  /** Exact page content is present only for a conservative direct hit. */
  results: KnowledgeEvidencePage[];
  /** Unverified routing hints for Find/Grep/Read exploration. */
  explorationHints?: KnowledgeExplorationHint[];
  navigationResults?: KnowledgeNavigationResult[];
  totalFiles?: number;
  totalChunks?: number;
  message?: string;
}

export interface KnowledgeResolver {
  lookup(query: string): Promise<KnowledgeLookupResult>;
}

export interface CreateKnowledgeResolverOptions {
  indexer: KnowledgeSearchIndex;
  knowledgeDir: string;
  readPage: (absolutePath: string) => Promise<string>;
  /** Read-only preview that does not register the page as answer evidence. */
  inspectPage?: (absolutePath: string) => Promise<string>;
  evidenceBudgetCharsRef: { current: number };
  maxCandidates?: number;
  rerankCandidates?: number;
  maxExplorationHints?: number;
}
