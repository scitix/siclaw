import path from "node:path";

import yaml from "js-yaml";

import { isKnowledgeNavigationPage, isKnowledgeNavigationPath } from "./page-kind.js";
import type {
  CreateKnowledgeResolverOptions,
  KnowledgeEvidencePage,
  KnowledgeEvidenceSection,
  KnowledgeLookupResult,
  KnowledgeNavigationResult,
  KnowledgeResolver,
} from "./resolver-types.js";
import type { MemoryChunk } from "../memory/types.js";

const DEFAULT_MAX_PAGES = 3;
const DEFAULT_MAX_CANDIDATES = 40;
const MAX_NAVIGATION_RESULTS = 5;

interface PageCandidate {
  file: string;
  score: number;
  chunks: MemoryChunk[];
}

interface PageMetadata {
  title: string;
  metadata?: KnowledgeEvidencePage["metadata"];
}

function roundScore(score: number | undefined): number {
  return Math.round((score ?? 0) * 1_000) / 1_000;
}

function truncateUtf16Safe(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 0) return "";
  const code = value.charCodeAt(maxLength - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? maxLength - 1 : maxLength;
  return value.slice(0, end);
}

function safePagePath(knowledgeDir: string, file: string): string | null {
  const normalizedFile = file.replaceAll("\\", "/");
  if (!normalizedFile.toLowerCase().endsWith(".md")) return null;
  const absolutePath = path.resolve(knowledgeDir, normalizedFile);
  const relative = path.relative(path.resolve(knowledgeDir), absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absolutePath;
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

  return {
    title: frontmatterTitle || heading || fallbackTitle,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function extractEvidenceRefs(file: string, content: string): string[] {
  const refs: string[] = [];
  const marker = /<!--[ \t]*okf:evidence[ \t]+(\{[^\r\n]*\})[ \t]*-->/g;
  for (const match of content.matchAll(marker)) {
    try {
      const payload = JSON.parse(match[1]) as { id?: unknown };
      if (typeof payload.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(payload.id)) {
        refs.push(`${file}#${payload.id}`);
      }
    } catch {
      // Invalid markers are intentionally not advertised as citable evidence.
    }
  }
  return [...new Set(refs)];
}

function matchedSections(chunks: MemoryChunk[], body: string, budget: number): KnowledgeEvidenceSection[] {
  const sections: KnowledgeEvidenceSection[] = [];
  const seen = new Set<string>();
  const lines = body.split(/\r?\n/);
  let remaining = Math.max(0, budget);
  for (const chunk of chunks) {
    const key = `${chunk.startLine}:${chunk.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (remaining <= 0) break;
    let startIndex = Math.max(0, chunk.startLine - 1);
    const endIndex = Math.min(lines.length, Math.max(startIndex + 1, chunk.endLine));
    // OKF evidence markers conventionally sit immediately before the heading
    // they bind. Include that marker with a matched heading so the returned
    // snapshot remains citable without returning the rest of a large page.
    let markerIndex = startIndex - 1;
    while (markerIndex >= 0 && lines[markerIndex].trim() === "") markerIndex -= 1;
    if (markerIndex >= 0 && /<!--[ \t]*okf:evidence[ \t]+\{[^\r\n]*\}[ \t]*-->/.test(lines[markerIndex])) {
      startIndex = markerIndex;
    }
    const snapshotContent = lines.slice(startIndex, endIndex).join("\n").trim();
    const content = truncateUtf16Safe(snapshotContent, remaining);
    if (!content) break;
    sections.push({
      heading: chunk.heading,
      startLine: startIndex + 1,
      endLine: endIndex,
      content,
    });
    remaining -= content.length;
  }
  return sections;
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

function navigationResults(chunks: MemoryChunk[]): KnowledgeNavigationResult[] {
  const byFile = new Map<string, KnowledgeNavigationResult>();
  for (const chunk of chunks) {
    if (!isKnowledgeNavigationPath(chunk.file)) continue;
    const next = { file: chunk.file, heading: chunk.heading, score: roundScore(chunk.score) };
    const existing = byFile.get(chunk.file);
    if (!existing || next.score > existing.score) byFile.set(chunk.file, next);
  }
  return [...byFile.values()]
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, MAX_NAVIGATION_RESULTS);
}

/**
 * Resolve one natural-language question into a small, read, evidence-bearing
 * set of leaf pages. Search is an implementation detail behind this boundary.
 */
export function createKnowledgeResolver(options: CreateKnowledgeResolverOptions): KnowledgeResolver {
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES));
  const maxCandidates = Math.max(maxPages, Math.floor(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES));

  return {
    async lookup(rawQuery: string): Promise<KnowledgeLookupResult> {
      const query = rawQuery.trim();
      if (!query) {
        return {
          status: "not_found",
          mode: "hybrid",
          query,
          results: [],
          message: "A non-empty knowledge question is required.",
        };
      }

      let searched;
      try {
        searched = await options.indexer.search(query, maxCandidates, 0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "unavailable",
          mode: "hybrid",
          query,
          results: [],
          message: `Knowledge retrieval is unavailable: ${message}`,
        };
      }

      const navigation = navigationResults(searched.chunks);
      const candidates = groupLeafCandidates(searched.chunks).slice(0, maxPages);
      if (candidates.length === 0) {
        return {
          status: "not_found",
          mode: "hybrid",
          query,
          results: [],
          ...(navigation.length > 0 ? { navigationResults: navigation } : {}),
          totalFiles: searched.totalFiles,
          totalChunks: searched.totalChunks,
          message: "No matching knowledge leaf pages found.",
        };
      }

      const totalEvidenceBudget = Math.max(256, Math.floor(options.evidenceBudgetCharsRef.current));
      const perPageBudget = Math.max(1, Math.floor(totalEvidenceBudget / candidates.length));
      const reads = await Promise.all(candidates.map(async (candidate) => {
        const absolutePath = safePagePath(options.knowledgeDir, candidate.file);
        if (!absolutePath) {
          return { kind: "error", candidate, error: "candidate path is outside the mounted knowledge directory" } as const;
        }
        try {
          const body = await options.readPage(absolutePath);
          if (isKnowledgeNavigationPage(candidate.file, body)) {
            return { kind: "navigation", candidate } as const;
          }
          return { kind: "page", candidate, body } as const;
        } catch (error) {
          return {
            kind: "error",
            candidate,
            error: error instanceof Error ? error.message : String(error),
          } as const;
        }
      }));

      const results: KnowledgeEvidencePage[] = [];
      for (const read of reads) {
        if (read.kind !== "page") continue;
        const { candidate, body } = read;
        const { title, metadata } = parsePageMetadata(candidate.file, body);
        const fullPage = body.length <= perPageBudget;
        const sections = fullPage
          ? [{
              heading: title,
              startLine: 1,
              endLine: Math.max(1, body.split(/\r?\n/).length),
              content: body,
            }]
          : matchedSections(candidate.chunks, body, perPageBudget);
        if (sections.length === 0) continue;
        const selectedContent = sections.map((section) => section.content).join("\n");
        const evidenceRefs = extractEvidenceRefs(candidate.file, selectedContent);
        const pageHasEvidenceMarkers = /<!--[ \t]*okf:evidence\b/.test(body);
        results.push({
          rank: results.length + 1,
          file: candidate.file,
          title,
          score: roundScore(candidate.score),
          ...(metadata ? { metadata } : {}),
          readMode: fullPage ? "full_page" : "matched_sections",
          truncated: !fullPage,
          citationMode: evidenceRefs.length > 0 ? "evidence" : pageHasEvidenceMarkers ? "none" : "page",
          ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
          sections,
        });
      }

      if (results.length === 0) {
        const hadInvalidPath = reads.some((read) => read.kind === "error" && read.error.includes("outside"));
        return {
          status: "unavailable",
          mode: "hybrid",
          query,
          results: [],
          ...(navigation.length > 0 ? { navigationResults: navigation } : {}),
          totalFiles: searched.totalFiles,
          totalChunks: searched.totalChunks,
          message: hadInvalidPath
            ? "Knowledge retrieval is unavailable: the index returned an invalid page path."
            : "Knowledge retrieval is unavailable: matching leaf pages could not be read.",
        };
      }

      return {
        status: "ready",
        mode: "hybrid",
        query,
        results,
        ...(navigation.length > 0 ? { navigationResults: navigation } : {}),
        totalFiles: searched.totalFiles,
        totalChunks: searched.totalChunks,
        ...(results.length < candidates.length
          ? { message: "Some matching knowledge pages could not be returned; answer only from the evidence present." }
          : {}),
      };
    },
  };
}
