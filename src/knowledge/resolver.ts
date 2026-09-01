import { createHash } from "node:crypto";
import path from "node:path";

import yaml from "js-yaml";

import { isKnowledgeNavigationPage, isKnowledgeNavigationPath } from "./page-kind.js";
import type {
  CreateKnowledgeResolverOptions,
  KnowledgeEvidencePage,
  KnowledgeEvidenceSection,
  KnowledgeExplorationHint,
  KnowledgeLookupResult,
  KnowledgeNavigationResult,
  KnowledgeResolver,
} from "./resolver-types.js";
import { modelKnowledgeLocations, modelKnowledgePath } from "./model-path.js";
import type { MemoryChunk } from "../memory/types.js";
import { tokenizeForFts } from "../memory/stop-words.js";

const DEFAULT_MAX_CANDIDATES = 40;
const DEFAULT_RERANK_CANDIDATES = 8;
const DEFAULT_MAX_EXPLORATION_HINTS = 5;
const MAX_NAVIGATION_RESULTS = 5;
const MIN_ACCELERATOR_SCORE = 0.35;
const DIRECT_HIT_CONFIDENCE = 0.72;
const DIRECT_HIT_MARGIN = 0.12;
const COMPETING_HINT_CONFIDENCE = 0.64;

interface PageCandidate {
  file: string;
  score: number;
  chunks: MemoryChunk[];
  title?: string;
  metadata?: KnowledgeEvidencePage["metadata"];
  metadataScore?: number;
  passageScore?: number;
  routingConfidence?: number;
  qualifiersMatch?: boolean;
  inspectedBody?: string;
}

interface PageMetadata {
  title: string;
  metadata?: KnowledgeEvidencePage["metadata"];
  searchText: string;
}

function roundScore(score: number | undefined): number {
  return Math.round((score ?? 0) * 1_000) / 1_000;
}

function safePagePath(knowledgeDir: string, file: string): string | null {
  const normalizedFile = file.replaceAll("\\", "/");
  if (!normalizedFile.toLowerCase().endsWith(".md")) return null;
  const absolutePath = path.resolve(knowledgeDir, normalizedFile);
  const relative = path.relative(path.resolve(knowledgeDir), absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absolutePath;
}

/**
 * FTS tokenization is intentionally recall-oriented and drops common negation
 * words and pure numbers. Those omissions are unsafe at the direct-hit gate:
 * "enable" is not the same task as "do not enable", and 2025 is not 2026.
 */
function tokenizeForRouting(value: string): string[] {
  const tokens = new Set(tokenizeForFts(value));
  if (/\b(?:no|not|never|without)\b/iu.test(value) || /(?:不|未|无|没有|禁止|禁用|关闭|关掉|停用)/u.test(value)) {
    tokens.add("__negated__");
  }
  // Do not require word boundaries: versions are often attached to product
  // names (`CUDA12.4`, `RHEL8`, `B200`).
  for (const match of value.matchAll(/v?\d+(?:[._/-]\d+)*/giu)) {
    tokens.add(`__number:${match[0].toLowerCase()}`);
  }
  return [...tokens];
}

function parsePageMetadata(file: string, body: string): PageMetadata {
  let raw: Record<string, unknown> | null = null;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---", 4);
    if (end >= 0 && end <= 64 * 1024) {
      try {
        raw = yaml.load(body.slice(4, end)) as Record<string, unknown> | null;
      } catch {
        raw = null;
      }
    }
  }

  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const frontmatterTitle = typeof raw?.title === "string" ? raw.title.trim() : "";
  const fallbackTitle = path.posix.basename(file.replaceAll("\\", "/"), path.posix.extname(file));
  const metadata: NonNullable<KnowledgeEvidencePage["metadata"]> = {};
  if (typeof raw?.type === "string" && raw.type.trim()) metadata.type = raw.type.trim();
  if (typeof raw?.description === "string" && raw.description.trim()) metadata.description = raw.description.trim();
  if (Array.isArray(raw?.tags)) {
    const tags = raw.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
    if (tags.length > 0) metadata.tags = tags.map((tag) => tag.trim());
  }
  if (typeof raw?.timestamp === "string" && raw.timestamp.trim()) metadata.timestamp = raw.timestamp.trim();

  const searchableFrontmatter = raw
    ? Object.values(raw).flatMap((value) => {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          return [String(value)];
        }
        if (Array.isArray(value)) {
          return value.filter((item): item is string | number | boolean =>
            typeof item === "string" || typeof item === "number" || typeof item === "boolean")
            .map(String);
        }
        return [];
      })
    : [];
  const title = frontmatterTitle || heading || fallbackTitle;

  return {
    title,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    searchText: [file, title, heading, ...searchableFrontmatter].filter(Boolean).join(" "),
  };
}

function metadataCoverage(queryTokens: string[], metadataText: string): number {
  if (queryTokens.length === 0) return 0;
  const metadataTokens = new Set(tokenizeForRouting(metadataText));
  const hits = queryTokens.filter((token) => metadataTokens.has(token)).length;
  return hits / queryTokens.length;
}

function contentCoverage(queryTokens: string[], candidate: PageCandidate): number {
  if (queryTokens.length === 0) return 0;
  const text = candidate.chunks.map((chunk) => `${chunk.heading} ${chunk.content}`).join(" ");
  const contentTokens = new Set(tokenizeForRouting(text));
  const hits = queryTokens.filter((token) => contentTokens.has(token)).length;
  return hits / queryTokens.length;
}

function routingQualifiersMatch(queryTokens: string[], pageText: string): boolean {
  const required = queryTokens.filter((token) => token.startsWith("__"));
  if (required.length === 0) return true;
  const pageTokens = new Set(tokenizeForRouting(pageText));
  return required.every((token) => pageTokens.has(token));
}

function calculateRoutingConfidence(candidate: PageCandidate): number {
  const metadata = candidate.metadataScore ?? 0;
  const passage = candidate.passageScore ?? 0;
  const coverage = Math.max(metadata, passage * 0.8);
  const retrieval = Math.min(1, Math.max(0, candidate.score));
  return 0.8 * coverage + 0.2 * retrieval;
}

function explorationHint(knowledgeDir: string, candidate: PageCandidate, rank: number): KnowledgeExplorationHint {
  return {
    rank,
    file: candidate.file,
    readPath: modelKnowledgePath(knowledgeDir, candidate.file),
    title: candidate.title ?? path.posix.basename(candidate.file, path.posix.extname(candidate.file)),
    score: roundScore(candidate.score),
    routingConfidence: roundScore(candidate.routingConfidence),
    ...(candidate.metadataScore !== undefined ? { metadataScore: roundScore(candidate.metadataScore) } : {}),
    ...(candidate.passageScore !== undefined ? { passageScore: roundScore(candidate.passageScore) } : {}),
    ...(candidate.metadata ? { metadata: candidate.metadata } : {}),
  };
}

function resultId(file: string, body: string): string {
  return createHash("sha256").update(file).update("\0").update(body).digest("hex");
}

function groupLeafCandidates(chunks: MemoryChunk[]): PageCandidate[] {
  const byFile = new Map<string, PageCandidate>();
  for (const chunk of chunks) {
    if (isKnowledgeNavigationPath(chunk.file)) continue;
    const existing = byFile.get(chunk.file);
    if (existing) {
      existing.score = Math.max(existing.score, chunk.score ?? 0);
      existing.chunks.push(chunk);
    } else {
      byFile.set(chunk.file, {
        file: chunk.file,
        score: chunk.score ?? 0,
        chunks: [chunk],
      });
    }
  }
  return [...byFile.values()].sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

function navigationResults(knowledgeDir: string, chunks: MemoryChunk[]): KnowledgeNavigationResult[] {
  const byFile = new Map<string, KnowledgeNavigationResult>();
  for (const chunk of chunks) {
    if (!isKnowledgeNavigationPath(chunk.file)) continue;
    if (!safePagePath(knowledgeDir, chunk.file)) continue;
    const next = {
      file: chunk.file,
      readPath: modelKnowledgePath(knowledgeDir, chunk.file),
      heading: chunk.heading,
      score: roundScore(chunk.score),
    };
    const existing = byFile.get(chunk.file);
    if (!existing || next.score > existing.score) byFile.set(chunk.file, next);
  }
  return [...byFile.values()]
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, MAX_NAVIGATION_RESULTS);
}

/**
 * Use the index as a conservative single-page accelerator. Anything less than
 * a unique, identity-level match stays an Agent-led Wiki exploration problem.
 */
export function createKnowledgeResolver(options: CreateKnowledgeResolverOptions): KnowledgeResolver {
  const maxExplorationHints = Math.max(
    1,
    Math.floor(options.maxExplorationHints ?? DEFAULT_MAX_EXPLORATION_HINTS),
  );
  const maxCandidates = Math.max(maxExplorationHints, Math.floor(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES));
  const rerankCandidates = Math.max(
    maxExplorationHints,
    Math.floor(options.rerankCandidates ?? DEFAULT_RERANK_CANDIDATES),
  );

  return {
    async lookup(rawQuery: string): Promise<KnowledgeLookupResult> {
      const query = rawQuery.trim();
      const locations = modelKnowledgeLocations(options.knowledgeDir);
      if (!query) {
        return {
          status: "explore",
          mode: "accelerator",
          query,
          ...locations,
          results: [],
          message: "No direct lookup was attempted. Understand the question, then explore the Wiki with Find/Grep/Read.",
        };
      }

      let searched;
      try {
        searched = await options.indexer.search(query, maxCandidates, MIN_ACCELERATOR_SCORE);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "unavailable",
          mode: "accelerator",
          query,
          ...locations,
          results: [],
          message: `The retrieval accelerator is unavailable (${message}). Continue with Wiki Find/Grep/Read; this does not mean the knowledge is absent.`,
        };
      }

      const allChunks = searched.chunks;
      const navigation = navigationResults(options.knowledgeDir, allChunks);
      const queryTokens = tokenizeForRouting(query);
      let candidates: PageCandidate[] = groupLeafCandidates(allChunks).map((candidate) => ({
        ...candidate,
        passageScore: contentCoverage(queryTokens, candidate),
      }));
      let hadInvalidPath = false;

      if (candidates.length > 0) {
        const inspected = await Promise.all(candidates.slice(0, rerankCandidates).map(async (candidate): Promise<PageCandidate | null> => {
          const absolutePath = safePagePath(options.knowledgeDir, candidate.file);
          if (!absolutePath) {
            hadInvalidPath = true;
            return null;
          }
          if (!options.inspectPage) return candidate;
          try {
            const body = await options.inspectPage(absolutePath);
            if (isKnowledgeNavigationPage(candidate.file, body)) return null;
            const parsed = parsePageMetadata(candidate.file, body);
            return {
              ...candidate,
              title: parsed.title,
              metadata: parsed.metadata,
              metadataScore: metadataCoverage(queryTokens, parsed.searchText),
              qualifiersMatch: routingQualifiersMatch(queryTokens, `${parsed.searchText} ${body}`),
              inspectedBody: body,
            };
          } catch {
            return candidate;
          }
        }));
        const inspectedCandidates = inspected.filter((candidate): candidate is PageCandidate => candidate !== null);
        const remainder = candidates.slice(rerankCandidates).filter((candidate) => {
          const valid = safePagePath(options.knowledgeDir, candidate.file) !== null;
          if (!valid) hadInvalidPath = true;
          return valid;
        });
        candidates = [...inspectedCandidates, ...remainder]
          .map((candidate) => ({ ...candidate, routingConfidence: calculateRoutingConfidence(candidate) }))
          .sort((a, b) =>
            (b.routingConfidence ?? 0) - (a.routingConfidence ?? 0) ||
            b.score - a.score ||
            a.file.localeCompare(b.file));
      }

      if (candidates.length === 0) {
        return {
          status: hadInvalidPath ? "unavailable" : "explore",
          mode: "accelerator",
          query,
          ...locations,
          results: [],
          ...(navigation.length > 0 ? { navigationResults: navigation } : {}),
          totalFiles: searched.totalFiles,
          totalChunks: searched.totalChunks,
          message: hadInvalidPath
            ? "The retrieval accelerator returned an invalid page path. Continue with Wiki Find/Grep/Read."
            : "No safe direct hit was found. This is not evidence that the Wiki lacks an answer; explore its catalog, links, and pages with Find/Grep/Read.",
        };
      }

      const hints = candidates
        .slice(0, maxExplorationHints)
        .map((candidate, index) => explorationHint(options.knowledgeDir, candidate, index + 1));
      const directCandidate = candidates[0];
      const competitor = candidates.slice(1).find((candidate) =>
        (candidate.routingConfidence ?? 0) >= COMPETING_HINT_CONFIDENCE &&
        (directCandidate.routingConfidence ?? 0) - (candidate.routingConfidence ?? 0) < DIRECT_HIT_MARGIN);
      const isDirectHit =
        (directCandidate.routingConfidence ?? 0) >= DIRECT_HIT_CONFIDENCE &&
        (directCandidate.metadataScore ?? 0) >= DIRECT_HIT_CONFIDENCE &&
        (directCandidate.passageScore ?? 0) >= COMPETING_HINT_CONFIDENCE &&
        directCandidate.qualifiersMatch !== false &&
        competitor === undefined;

      if (!isDirectHit) {
        return {
          status: "explore",
          mode: "accelerator",
          query,
          ...locations,
          results: [],
          explorationHints: hints,
          ...(navigation.length > 0 ? { navigationResults: navigation } : {}),
          totalFiles: searched.totalFiles,
          totalChunks: searched.totalChunks,
          message: competitor
            ? "Several pages plausibly match, so similarity cannot choose the answer. Treat the hints as unverified leads and explore the Wiki with Find/Grep/Read."
            : "The best match is not strong enough for a safe direct hit. Treat the hints as unverified leads and explore the Wiki with Find/Grep/Read.",
        };
      }

      const absolutePath = safePagePath(options.knowledgeDir, directCandidate.file);
      if (!absolutePath) {
        return {
          status: "unavailable",
          mode: "accelerator",
          query,
          ...locations,
          results: [],
          explorationHints: hints,
          ...(navigation.length > 0 ? { navigationResults: navigation } : {}),
          totalFiles: searched.totalFiles,
          totalChunks: searched.totalChunks,
          message: "The direct-hit path is invalid. Continue with Wiki Find/Grep/Read.",
        };
      }

      const evidenceBudget = Math.max(256, Math.floor(options.evidenceBudgetCharsRef.current));
      if (directCandidate.inspectedBody !== undefined && directCandidate.inspectedBody.length > evidenceBudget) {
        return {
          status: "explore",
          mode: "accelerator",
          query,
          ...locations,
          results: [],
          explorationHints: hints,
          ...(navigation.length > 0 ? { navigationResults: navigation } : {}),
          totalFiles: searched.totalFiles,
          totalChunks: searched.totalChunks,
          message: "The best page is too large for a complete, context-safe direct snapshot. Treat it as an unverified lead and inspect the page and its Wiki neighbors with Find/Grep/Read.",
        };
      }

      let body: string;
      try {
        body = await options.readPage(absolutePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "unavailable",
          mode: "accelerator",
          query,
          ...locations,
          results: [],
          explorationHints: hints,
          ...(navigation.length > 0 ? { navigationResults: navigation } : {}),
          totalFiles: searched.totalFiles,
          totalChunks: searched.totalChunks,
          message: `The direct-hit page could not be read (${message}). Continue with Wiki Find/Grep/Read.`,
        };
      }

      if (directCandidate.inspectedBody !== undefined && body !== directCandidate.inspectedBody) {
        return {
          status: "unavailable",
          mode: "accelerator",
          query,
          ...locations,
          results: [],
          explorationHints: hints,
          ...(navigation.length > 0 ? { navigationResults: navigation } : {}),
          totalFiles: searched.totalFiles,
          totalChunks: searched.totalChunks,
          message: "The candidate page changed between validation and evidence registration. Continue with Wiki Find/Grep/Read against the current mount.",
        };
      }

      if (isKnowledgeNavigationPage(directCandidate.file, body)) {
        return {
          status: "explore",
          mode: "accelerator",
          query,
          ...locations,
          results: [],
          explorationHints: hints,
          ...(navigation.length > 0 ? { navigationResults: navigation } : {}),
          totalFiles: searched.totalFiles,
          totalChunks: searched.totalChunks,
          message: "The match is a navigation page, not answer evidence. Follow its links and explore with Find/Grep/Read.",
        };
      }

      const parsed = parsePageMetadata(directCandidate.file, body);
      if (body.length > evidenceBudget) {
        return {
          status: "explore",
          mode: "accelerator",
          query,
          ...locations,
          results: [],
          explorationHints: hints,
          ...(navigation.length > 0 ? { navigationResults: navigation } : {}),
          totalFiles: searched.totalFiles,
          totalChunks: searched.totalChunks,
          message: "The best page is too large for a complete, context-safe direct snapshot. Treat it as an unverified lead and inspect the page and its Wiki neighbors with Find/Grep/Read.",
        };
      }

      const sections: KnowledgeEvidenceSection[] = [{
        heading: parsed.title,
        startLine: 1,
        endLine: Math.max(1, body.split(/\r?\n/).length),
        content: body,
      }];
      const citation = options.resolveCitation?.(absolutePath, body) ?? { citationMode: "none" as const };
      const result: KnowledgeEvidencePage = {
        rank: 1,
        file: directCandidate.file,
        readPath: modelKnowledgePath(options.knowledgeDir, directCandidate.file),
        title: parsed.title,
        score: roundScore(directCandidate.score),
        routingConfidence: roundScore(directCandidate.routingConfidence),
        resultId: resultId(directCandidate.file, body),
        ...(directCandidate.metadataScore !== undefined
          ? { metadataScore: roundScore(directCandidate.metadataScore) }
          : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
        readMode: "full_page",
        truncated: false,
        citationMode: citation.citationMode,
        ...(citation.evidenceRefs?.length ? { evidenceRefs: citation.evidenceRefs } : {}),
        sections,
      };

      return {
        status: "direct_hit",
        mode: "accelerator",
        query,
        ...locations,
        results: [result],
        ...(navigation.length > 0 ? { navigationResults: navigation } : {}),
        totalFiles: searched.totalFiles,
        totalChunks: searched.totalChunks,
        message: "One strong page match was read. Validate its subject, task, version, environment, and scope before using it; reject it and explore the Wiki if any of those differ.",
      };
    },
  };
}
