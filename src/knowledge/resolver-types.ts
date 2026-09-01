import type { MemorySearchResult } from "../memory/types.js";

export interface KnowledgeSearchIndex {
  search(query: string, topK?: number, minScore?: number): Promise<MemorySearchResult>;
}

export type KnowledgeLookupStatus = "ready" | "not_found" | "unavailable";

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

export interface KnowledgeNavigationResult {
  file: string;
  heading: string;
  score: number;
}

export interface KnowledgeLookupResult {
  status: KnowledgeLookupStatus;
  mode: "hybrid";
  query: string;
  results: KnowledgeEvidencePage[];
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
  evidenceBudgetCharsRef: { current: number };
  maxPages?: number;
  maxCandidates?: number;
}
