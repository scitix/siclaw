import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

import { buildKnowledgeCatalogRoutes, type KnowledgeRouteProof } from "./catalog-graph.js";

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
  unreachableLabeledPages: number;
}

export interface MatchedKnowledgeLabel {
  facet: KnowledgeLabelFacet;
  value: string;
  matchedBy: string;
}

export interface KnowledgePageCandidate {
  file: string;
  title: string;
  description: string;
  score: number;
  labels: KnowledgeLabel[];
  matchedLabels: MatchedKnowledgeLabel[];
  routeProof: KnowledgeRouteProof;
}

export interface KnowledgeResolutionResult {
  pages: KnowledgePageCandidate[];
  totalPages: number;
  totalLabels: number;
  unreachableLabeledPages: number;
}

interface KnowledgePageLabels {
  file: string;
  title: string;
  description: string;
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

function parseFrontmatter(markdown: string): Record<string, unknown> | null {
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
    return metadata as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseKnowledgeLabels(markdown: string): {
  title: string;
  description: string;
  labels: KnowledgeLabel[];
} | null {
  const metadata = parseFrontmatter(markdown);
  if (!metadata) return null;
  const rawLabels = metadata.labels;
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
    title: typeof metadata.title === "string" ? metadata.title.trim() : "",
    description: typeof metadata.description === "string" ? metadata.description.trim() : "",
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

function queryCoverage(query: string, matchedTerms: string[]): number {
  const queryChars = [...normalize(query)];
  const meaningful = queryChars.map((char) => char !== " ");
  const total = meaningful.filter(Boolean).length;
  if (total === 0) return 0;

  const covered = new Array(queryChars.length).fill(false);
  const findSequence = (haystack: string[], needle: string[], from = 0): number => {
    if (needle.length === 0) return -1;
    for (let start = from; start <= haystack.length - needle.length; start++) {
      if (needle.every((char, offset) => haystack[start + offset] === char)) return start;
    }
    return -1;
  };
  for (const rawTerm of matchedTerms) {
    const termChars = [...normalize(rawTerm)];
    if (termChars.length === 0) continue;
    if (findSequence(termChars, queryChars) >= 0) {
      for (let i = 0; i < queryChars.length; i++) covered[i] = meaningful[i];
      continue;
    }
    let cursor = 0;
    while (cursor < queryChars.length) {
      const start = findSequence(queryChars, termChars, cursor);
      if (start < 0) break;
      for (let i = start; i < start + termChars.length; i++) covered[i] = meaningful[i];
      cursor = start + termChars.length;
    }
  }
  return covered.filter(Boolean).length / total;
}

function pageScore(
  query: string,
  matches: Array<MatchedKnowledgeLabel & { score: number }>,
): number {
  const uniqueTerms = new Map<string, number>();
  for (const match of matches) {
    const key = normalize(match.matchedBy);
    uniqueTerms.set(key, Math.max(uniqueTerms.get(key) ?? 0, match.score));
  }
  const qualities = [...uniqueTerms.values()];
  const best = Math.max(...qualities);
  const coverage = queryCoverage(query, [...uniqueTerms.keys()]);
  if (uniqueTerms.size === 1 && best === 1 && coverage === 1) return 1;

  const distinctFacets = new Set(matches.map((match) => match.facet)).size;
  const termBonus = 0.06 * Math.min(2, uniqueTerms.size - 1);
  const facetBonus = 0.04 * Math.min(2, distinctFacets - 1);
  return Math.min(1, best * (0.55 + 0.35 * coverage) + termBonus + facetBonus);
}

/** Fast page-label catalog. It scans local frontmatter only and never calls a model. */
export class KnowledgeLabelIndex {
  private readonly knowledgeDir: string;
  private pages = new Map<string, KnowledgePageLabels>();
  private routes = new Map<string, KnowledgeRouteProof>();

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
    this.routes = buildKnowledgeCatalogRoutes(this.knowledgeDir);
  }

  search(query: string, topK = 10): KnowledgeResolutionResult {
    const candidates: KnowledgePageCandidate[] = [];
    let reachableLabeledPages = 0;
    for (const page of this.pages.values()) {
      const routeProof = this.routes.get(page.file.replaceAll("\\", "/"));
      if (!routeProof) continue;
      reachableLabeledPages++;
      const matches = page.labels.flatMap((label) => {
        const match = matchLabel(query, label);
        return match ? [{ facet: label.facet, value: label.value, matchedBy: match.matchedBy, score: match.score }] : [];
      });
      if (matches.length === 0) continue;
      candidates.push({
        file: page.file,
        title: page.title,
        description: page.description,
        score: pageScore(query, matches),
        labels: page.labels,
        matchedLabels: matches.map(({ facet, value, matchedBy }) => ({ facet, value, matchedBy })),
        routeProof,
      });
    }
    candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    return {
      pages: candidates.slice(0, topK),
      totalPages: reachableLabeledPages,
      totalLabels: this.catalog({ limit: 1 }).totalLabels,
      unreachableLabeledPages: this.pages.size - reachableLabeledPages,
    };
  }

  catalog(opts: { query?: string; facet?: string; offset?: number; limit?: number } = {}): KnowledgeLabelCatalogResult {
    const merged = new Map<string, KnowledgeLabelCatalogEntry>();
    let reachableLabeledPages = 0;
    for (const page of this.pages.values()) {
      if (!this.routes.has(page.file.replaceAll("\\", "/"))) continue;
      reachableLabeledPages++;
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
      totalPages: reachableLabeledPages,
      offset,
      hasMore: offset + limit < all.length,
      unreachableLabeledPages: this.pages.size - reachableLabeledPages,
    };
  }
}
