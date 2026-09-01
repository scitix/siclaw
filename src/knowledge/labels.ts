import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

import { chunkMarkdown } from "../memory/chunker.js";
import type { MemoryChunk, MemorySearchResult } from "../memory/types.js";

export const KNOWLEDGE_LABEL_FACETS = [
  "entity", "topic", "task", "component", "environment", "version",
] as const;

export type KnowledgeLabelFacet = typeof KNOWLEDGE_LABEL_FACETS[number];

export interface KnowledgeLabel {
  facet: KnowledgeLabelFacet;
  value: string;
  aliases: string[];
}

export interface KnowledgeLabelCatalogEntry extends KnowledgeLabel {
  pages: string[];
  pageCount: number;
  pagesTruncated: boolean;
}

export interface KnowledgeLabelCatalogResult {
  labels: KnowledgeLabelCatalogEntry[];
  totalLabels: number;
  totalPages: number;
  offset: number;
  hasMore: boolean;
}

interface KnowledgePageLabels {
  file: string;
  title: string;
  description: string;
  body: string;
  bodyStartLine: number;
  labels: KnowledgeLabel[];
}

const FACETS = new Set<string>(KNOWLEDGE_LABEL_FACETS);
const MAX_LABELS = 32;
const MAX_ALIASES = 8;
const MAX_TEXT = 100;
const MAX_CATALOG_PAGES_PER_LABEL = 100;

function validationKey(value: string): string {
  // Keep duplicate validation aligned with the Python producer and Sicore's
  // Go validator. Search normalization below is intentionally broader.
  return value.trim().toLocaleLowerCase();
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/[\s_\-./]+/g, " ");
}

function parseFrontmatter(markdown: string): { metadata: Record<string, unknown>; body: string; bodyStartLine: number } | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.slice(1).findIndex((line) => {
    const value = line.trim();
    return value === "---" || value === "...";
  });
  if (end < 0) return null;
  const delimiterLine = end + 1;
  try {
    const metadata = yaml.load(lines.slice(1, delimiterLine).join("\n"));
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    return {
      metadata: metadata as Record<string, unknown>,
      body: lines.slice(delimiterLine + 1).join("\n"),
      bodyStartLine: delimiterLine + 2,
    };
  } catch {
    return null;
  }
}

export function parseKnowledgeLabels(markdown: string): {
  title: string;
  description: string;
  body: string;
  bodyStartLine: number;
  labels: KnowledgeLabel[];
} | null {
  const parsed = parseFrontmatter(markdown);
  if (!parsed) return null;
  const rawLabels = parsed.metadata.labels;
  if (!Array.isArray(rawLabels) || rawLabels.length === 0 || rawLabels.length > MAX_LABELS) return null;

  const labels: KnowledgeLabel[] = [];
  const seen = new Set<string>();
  for (const raw of rawLabels) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.facet !== "string" || !FACETS.has(row.facet)) return null;
    if (typeof row.value !== "string") return null;
    const value = row.value.trim();
    if (!value || [...value].length > MAX_TEXT) return null;
    const rawAliases = row.aliases ?? [];
    if (!Array.isArray(rawAliases) || rawAliases.length > MAX_ALIASES) return null;
    const aliases = rawAliases.map((alias) => typeof alias === "string" ? alias.trim() : "");
    if (aliases.some((alias) => !alias || [...alias].length > MAX_TEXT)) return null;
    if (new Set(aliases.map(validationKey)).size !== aliases.length) return null;
    const key = `${row.facet}\u0000${validationKey(value)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    labels.push({ facet: row.facet as KnowledgeLabelFacet, value, aliases });
  }

  return {
    title: typeof parsed.metadata.title === "string" ? parsed.metadata.title.trim() : "",
    description: typeof parsed.metadata.description === "string" ? parsed.metadata.description.trim() : "",
    body: parsed.body,
    bodyStartLine: parsed.bodyStartLine,
    labels,
  };
}

function termScore(query: string, term: string): number {
  const q = normalize(query);
  const t = normalize(term);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (q.includes(t)) return 0.95;
  if (q.length >= 2 && t.includes(q)) return 0.8;
  const queryTokens = new Set(q.split(" ").filter(Boolean));
  const termTokens = t.split(" ").filter(Boolean);
  if (termTokens.length > 1 && termTokens.every((token) => queryTokens.has(token))) return 0.72;
  return 0;
}

function matchLabel(query: string, label: KnowledgeLabel): { score: number; matchedBy: string } | null {
  let best = { score: termScore(query, label.value), matchedBy: label.value };
  for (const alias of label.aliases) {
    const score = termScore(query, alias);
    if (score > best.score) best = { score, matchedBy: alias };
  }
  return best.score > 0 ? best : null;
}

function firstPageChunk(page: KnowledgePageLabels): MemoryChunk {
  const first = chunkMarkdown(page.body)[0];
  const heading = first?.heading || page.title;
  const content = first?.content || [page.title, page.description].filter(Boolean).join("\n");
  return {
    file: page.file,
    heading,
    content,
    startLine: page.bodyStartLine + (first?.startLine ?? 1) - 1,
    endLine: page.bodyStartLine + (first?.endLine ?? 1) - 1,
    labels: page.labels,
  };
}

/** Fast page-label catalog. It scans local frontmatter only and never calls a model. */
export class KnowledgeLabelIndex {
  private readonly knowledgeDir: string;
  private pages = new Map<string, KnowledgePageLabels>();

  constructor(knowledgeDir: string) {
    this.knowledgeDir = path.resolve(knowledgeDir);
  }

  async sync(): Promise<void> {
    const next = new Map<string, KnowledgePageLabels>();
    const visit = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(absolute);
          continue;
        }
        const lowerName = entry.name.toLowerCase();
        if (!entry.isFile() || !lowerName.endsWith(".md")) continue;
        if (lowerName === "index.md" || lowerName === "log.md") continue;
        let markdown: string;
        try { markdown = fs.readFileSync(absolute, "utf8"); } catch { continue; }
        const parsed = parseKnowledgeLabels(markdown);
        if (!parsed) continue;
        const file = path.relative(this.knowledgeDir, absolute);
        next.set(file, { file, ...parsed });
      }
    };
    visit(this.knowledgeDir);
    this.pages = next;
  }

  search(query: string, topK = 10): MemorySearchResult {
    const candidates: MemoryChunk[] = [];
    for (const page of this.pages.values()) {
      const matches = page.labels.flatMap((label) => {
        const match = matchLabel(query, label);
        return match ? [{ facet: label.facet, value: label.value, matchedBy: match.matchedBy, score: match.score }] : [];
      });
      if (matches.length === 0) continue;
      const chunk = firstPageChunk(page);
      chunk.score = Math.min(1, Math.max(...matches.map((match) => match.score)) + 0.03 * (matches.length - 1));
      chunk.matchedLabels = matches.map(({ facet, value, matchedBy }) => ({ facet, value, matchedBy }));
      candidates.push(chunk);
    }
    candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.file.localeCompare(b.file));
    return {
      chunks: candidates.slice(0, topK),
      totalFiles: this.pages.size,
      totalChunks: this.pages.size,
      retrievalMode: "labels",
      contentIndexReady: false,
      totalLabels: this.catalog({ limit: 1 }).totalLabels,
    };
  }

  labelsForFile(file: string): KnowledgeLabel[] {
    return this.pages.get(file)?.labels ?? [];
  }

  matchedLabelsForFile(file: string, query: string): MemoryChunk["matchedLabels"] {
    return (this.pages.get(file)?.labels ?? []).flatMap((label) => {
      const match = matchLabel(query, label);
      return match ? [{ facet: label.facet, value: label.value, matchedBy: match.matchedBy }] : [];
    });
  }

  catalog(opts: { query?: string; facet?: string; offset?: number; limit?: number } = {}): KnowledgeLabelCatalogResult {
    const merged = new Map<string, KnowledgeLabelCatalogEntry>();
    for (const page of this.pages.values()) {
      for (const label of page.labels) {
        if (opts.facet && label.facet !== opts.facet) continue;
        if (opts.query && !matchLabel(opts.query, label)) continue;
        const key = `${label.facet}\u0000${normalize(label.value)}`;
        const existing = merged.get(key);
        if (existing) {
          existing.pageCount++;
          if (existing.pages.length < MAX_CATALOG_PAGES_PER_LABEL) {
            existing.pages.push(page.file);
          } else {
            existing.pagesTruncated = true;
          }
          existing.aliases = [...new Set([...existing.aliases, ...label.aliases])];
        } else {
          merged.set(key, {
            ...label,
            aliases: [...label.aliases],
            pages: [page.file],
            pageCount: 1,
            pagesTruncated: false,
          });
        }
      }
    }
    const all = [...merged.values()].sort((a, b) =>
      a.facet.localeCompare(b.facet) || a.value.localeCompare(b.value));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 100)));
    return {
      labels: all.slice(offset, offset + limit),
      totalLabels: all.length,
      totalPages: this.pages.size,
      offset,
      hasMore: offset + limit < all.length,
    };
  }
}
