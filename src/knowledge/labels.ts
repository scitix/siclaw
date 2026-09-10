import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

import { buildKnowledgeCatalogRoutes, type KnowledgeRouteProof } from "./catalog-graph.js";
import { isKnowledgeNavigationPage } from "./page-kind.js";
import { discoverKnowledgeLibraries, libraryRootForFile, type KnowledgeLibraryInfo } from "./libraries.js";

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
  invalidLabeledPages: number;
  unlabeledPages: number;
  unreachableLabeledPages: number;
}

export interface MatchedKnowledgeLabel {
  facet: KnowledgeLabelFacet;
  value: string;
  matchedBy: string;
  pageCount: number;
}

export interface KnowledgePageCandidate {
  file: string;
  title: string;
  description: string;
  score: number;
  labels: KnowledgeLabel[];
  matchedLabels: MatchedKnowledgeLabel[];
  routeProof: KnowledgeRouteProof;
  /** Library root this page belongs to; "" on a single-library mount. */
  library: string;
}

/** One library's share of a search: its routing score and its own top pages. */
export interface KnowledgeLibraryCandidate extends KnowledgeLibraryInfo {
  /** 0..1 — how strongly the query points at this library (labels + name/domain). */
  score: number;
  /** Human-readable reasons behind `score`, e.g. "label: linkcheck", "domain: Library B". */
  why: string[];
  /** Labeled pages in this library matching the query, before topK truncation. */
  matchedPages: number;
  pages: KnowledgePageCandidate[];
}

export interface KnowledgeLibraryRouting {
  /** True when the mount holds more than one library. */
  multiLibrary: boolean;
  /** Library roots the query was routed to; empty when every library was searched. */
  selected: string[];
  /** True when no library stood out and all libraries were searched. */
  fallback: boolean;
  /** Score gap between the best and second-best library, null when < 2 libraries matched. */
  margin: number | null;
}

/** Library summary for `listLibraries`: routing metadata plus the library's dominant labels. */
export interface KnowledgeLibrarySummary extends KnowledgeLibraryInfo {
  /** Reachable labeled pages in this library. */
  pageCount: number;
  /** Content pages in this library that declare no labels at all (invisible to knowledge_search). */
  unlabeledPages: number;
  /** Titles (or file names) of up to 5 unlabeled pages — the compile-side backfill worklist. */
  unlabeledSamples: string[];
  /** Per facet, the most frequent label values (≤ 3 each) with their page counts. */
  topLabels: Array<{ facet: KnowledgeLabelFacet; value: string; pageCount: number }>;
}

export interface KnowledgeResolutionResult {
  pages: KnowledgePageCandidate[];
  matchedPages: number;
  totalPages: number;
  /** Per-library grouping of the same match set, best library first. */
  libraries: KnowledgeLibraryCandidate[];
  routing: KnowledgeLibraryRouting;
  /** Indexed pages that no longer exist on disk at search time (index/page drift). */
  staleCandidates: number;
  /** True when `opts.library` named no mounted library; the result is then empty on purpose. */
  unknownLibrary: boolean;
  totalLabels: number;
  invalidLabeledPages: number;
  unlabeledPages: number;
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

function frontmatterSource(markdown: string): string | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.slice(1).findIndex((line) => {
    const value = line.trim();
    return value === "---" || value === "...";
  });
  if (end < 0) return null;
  const delimiterLine = end + 1;
  return lines.slice(1, delimiterLine).join("\n");
}

function parseFrontmatter(markdown: string): Record<string, unknown> | null {
  const source = frontmatterSource(markdown);
  if (source === null) return null;
  try {
    const metadata = yaml.load(source);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    return metadata as Record<string, unknown>;
  } catch {
    return null;
  }
}

function declaresKnowledgeLabels(markdown: string): boolean {
  const source = frontmatterSource(markdown);
  if (source === null) return false;
  try {
    const metadata = yaml.load(source);
    return Boolean(
      metadata && typeof metadata === "object" && !Array.isArray(metadata) &&
      Object.prototype.hasOwnProperty.call(metadata, "labels"),
    );
  } catch {
    return /^labels\s*:/m.test(source);
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
  const uniqueTerms = new Map<string, { score: number; pageCount: number }>();
  for (const match of matches) {
    const key = normalize(match.matchedBy);
    const previous = uniqueTerms.get(key);
    if (!previous || match.score > previous.score) {
      uniqueTerms.set(key, { score: match.score, pageCount: match.pageCount });
    }
  }
  const terms = [...uniqueTerms.values()];
  const best = Math.max(...terms.map((term) => term.score));
  const coverage = queryCoverage(query, [...uniqueTerms.keys()]);
  if (uniqueTerms.size === 1 && best === 1 && coverage === 1 && terms[0].pageCount <= 2) return 1;

  const bestAdjusted = Math.max(...terms.map((term) =>
    term.score * (0.6 + 0.4 / Math.sqrt(term.pageCount))));
  const distinctFacets = new Set(matches.map((match) => match.facet)).size;
  const termBonus = 0.06 * Math.min(2, uniqueTerms.size - 1);
  const facetBonus = 0.04 * Math.min(2, distinctFacets - 1);
  return Math.min(1, bestAdjusted * (0.55 + 0.35 * coverage) + termBonus + facetBonus);
}

/** Weakest library score that still counts as a confident route. */
const LIBRARY_ROUTE_MIN_SCORE = 0.55;
/** A library within this gap of the best one is routed to as well. */
const LIBRARY_ROUTE_MARGIN = 0.15;
const TOP_LABELS_PER_FACET = 3;

/** Terms a library's name/domain contribute to routing, split on punctuation only (CJK stays whole). */
function libraryDomainTerms(library: KnowledgeLibraryInfo): string[] {
  return [library.name, ...library.domain.split(/[，,。;；、\s—–\-·/()（）:：]+/)]
    .map((term) => term.trim())
    .filter((term) => [...term].length >= 2);
}

/** Fast page-label catalog. It scans local frontmatter only and never calls a model. */
export class KnowledgeLabelIndex {
  private readonly knowledgeDir: string;
  private pages = new Map<string, KnowledgePageLabels>();
  private routes = new Map<string, KnowledgeRouteProof>();
  /** Library root → normalized term → labeled pages carrying it, counted WITHIN that library. */
  private termPageCounts = new Map<string, Map<string, number>>();
  private libraries: KnowledgeLibraryInfo[] = [{ root: "", name: "", domain: "", version: null }];
  private pageLibrary = new Map<string, string>();
  /** Unlabeled content pages by relative path → title (frontmatter title or file name). */
  private unlabeledByFile = new Map<string, string>();
  private invalidLabeledPages = 0;
  private unlabeledPages = 0;

  constructor(knowledgeDir: string) {
    this.knowledgeDir = path.resolve(knowledgeDir);
  }

  async sync(): Promise<void> {
    const next = new Map<string, KnowledgePageLabels>();
    const unlabeledByFile = new Map<string, string>();
    let invalidLabeledPages = 0;
    let unlabeledPages = 0;
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
        const file = path.relative(this.knowledgeDir, absolute);
        // Navigation pages (`_index.md` by path, `type: index` by frontmatter;
        // plain `index.md` never gets here) must not enter the label index:
        // citation validation rejects them as evidence, so a labeled navigation
        // page would hand knowledge_search a candidate whose cite call then
        // hard-fails the whole turn's citations. Same classifier as citation
        // validation and the catalog graph, so the layers cannot disagree.
        // They are routing surfaces, not content pages — no counter increments.
        if (isKnowledgeNavigationPage(file, markdown)) continue;
        const parsed = parseKnowledgeLabels(markdown);
        if (!parsed) {
          if (declaresKnowledgeLabels(markdown)) invalidLabeledPages++;
          else {
            unlabeledPages++;
            const title = parseFrontmatter(markdown)?.title;
            unlabeledByFile.set(file, typeof title === "string" && title.trim() ? title.trim() : path.basename(file, ".md"));
          }
          continue;
        }
        next.set(file, { file, ...parsed });
      }
    };
    visit(this.knowledgeDir);
    this.pages = next;
    this.unlabeledByFile = unlabeledByFile;
    this.routes = buildKnowledgeCatalogRoutes(this.knowledgeDir);
    this.invalidLabeledPages = invalidLabeledPages;
    this.unlabeledPages = unlabeledPages;

    // Library dimension: roots from the materializer manifest (or the root
    // catalog's library links), each page assigned by path prefix. A
    // single-library mount collapses to one root "" so every consumer can treat
    // "one library" and "no library dimension" the same way.
    this.libraries = discoverKnowledgeLibraries(this.knowledgeDir);
    const roots = this.libraries.map((library) => library.root);
    this.pageLibrary = new Map();
    const termPageCounts = new Map<string, Map<string, number>>();
    for (const page of this.pages.values()) {
      const file = page.file.replaceAll("\\", "/");
      const library = libraryRootForFile(file, roots);
      this.pageLibrary.set(page.file, library);
      if (!this.routes.has(file)) continue;
      // Term frequency is counted per library on purpose: a label shared by
      // many pages of an unrelated library must not dilute a rare, decisive
      // label inside the library the query is really about.
      let counts = termPageCounts.get(library);
      if (!counts) { counts = new Map(); termPageCounts.set(library, counts); }
      const pageTerms = new Set(page.labels.flatMap((label) =>
        [label.value, ...label.aliases].map(normalize).filter(Boolean)));
      for (const term of pageTerms) {
        counts.set(term, (counts.get(term) ?? 0) + 1);
      }
    }
    this.termPageCounts = termPageCounts;
  }

  /** Library metadata discovered at the last sync (one entry with root "" for a single library). */
  listLibraries(): KnowledgeLibrarySummary[] {
    const roots = this.libraries.map((library) => library.root);
    return this.libraries.map((library) => {
      const facetCounts = new Map<KnowledgeLabelFacet, Map<string, { value: string; pageCount: number }>>();
      let pageCount = 0;
      for (const page of this.pages.values()) {
        if (this.pageLibrary.get(page.file) !== library.root) continue;
        if (!this.routes.has(page.file.replaceAll("\\", "/"))) continue;
        pageCount++;
        for (const label of page.labels) {
          let values = facetCounts.get(label.facet);
          if (!values) { values = new Map(); facetCounts.set(label.facet, values); }
          const key = normalize(label.value);
          const entry = values.get(key) ?? { value: label.value, pageCount: 0 };
          entry.pageCount++;
          values.set(key, entry);
        }
      }
      const topLabels: KnowledgeLibrarySummary["topLabels"] = [];
      for (const facet of KNOWLEDGE_LABEL_FACETS) {
        const values = facetCounts.get(facet);
        if (!values) continue;
        [...values.values()]
          .sort((a, b) => b.pageCount - a.pageCount || a.value.localeCompare(b.value))
          .slice(0, TOP_LABELS_PER_FACET)
          .forEach((entry) => topLabels.push({ facet, value: entry.value, pageCount: entry.pageCount }));
      }
      const unlabeled = [...this.unlabeledByFile.entries()]
        .filter(([file]) => libraryRootForFile(file.replaceAll("\\", "/"), roots) === library.root)
        .map(([, title]) => title)
        // Code-point order: `localeCompare` without a locale follows the host's
        // ICU locale, so the same mount would list its samples differently per pod.
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return { ...library, pageCount, topLabels, unlabeledPages: unlabeled.length, unlabeledSamples: unlabeled.slice(0, 5) };
    });
  }

  private resolveLibraryRoot(selector: string | undefined): string | null | undefined {
    if (selector === undefined) return undefined;
    const wanted = selector.trim().replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
    if (!wanted) return undefined;
    const byRoot = this.libraries.find((library) => library.root === wanted);
    if (byRoot) return byRoot.root;
    const byName = this.libraries.find((library) => normalize(library.name) === normalize(wanted));
    if (byName) return byName.root;
    const byBase = this.libraries.filter((library) => path.posix.basename(library.root) === wanted);
    return byBase.length === 1 ? byBase[0].root : null;
  }

  search(query: string, topK = 10, opts: { library?: string } = {}): KnowledgeResolutionResult {
    const libraryFilter = this.resolveLibraryRoot(opts.library);
    const multiLibrary = this.libraries.length > 1;
    const empty = (): KnowledgeResolutionResult => ({
      pages: [], matchedPages: 0, totalPages: 0, totalLabels: this.catalog({ limit: 1 }).totalLabels,
      libraries: [], routing: { multiLibrary, selected: [], fallback: false, margin: null }, staleCandidates: 0,
      unknownLibrary: false,
      invalidLabeledPages: this.invalidLabeledPages, unlabeledPages: this.unlabeledPages,
      unreachableLabeledPages: 0,
    });
    if (libraryFilter === null) {
      // Unknown library selector: fail loud with an empty result rather than
      // silently searching everything the caller tried to exclude. The flag is
      // the single source of truth for callers; they must not re-match names.
      return { ...empty(), unknownLibrary: true, unreachableLabeledPages: this.pages.size - this.reachableLabeledPageCount() };
    }

    const candidates: KnowledgePageCandidate[] = [];
    let reachableLabeledPages = 0;
    let staleCandidates = 0;
    for (const page of this.pages.values()) {
      const file = page.file.replaceAll("\\", "/");
      const routeProof = this.routes.get(file);
      if (!routeProof) continue;
      reachableLabeledPages++;
      const library = this.pageLibrary.get(page.file) ?? "";
      if (libraryFilter !== undefined && library !== libraryFilter) continue;
      const counts = this.termPageCounts.get(library);
      const matches = page.labels.flatMap((label) => {
        const match = matchLabel(query, label);
        if (!match) return [];
        return [{
          facet: label.facet,
          value: label.value,
          matchedBy: match.matchedBy,
          pageCount: counts?.get(normalize(match.matchedBy)) ?? 1,
          score: match.score,
        }];
      });
      if (matches.length === 0) continue;
      // The index is rebuilt on sync, but a page can vanish between syncs. A
      // candidate the Agent cannot Read is worse than no candidate: it costs a
      // failed tool call and teaches the model to distrust the whole result.
      if (!fs.existsSync(path.join(this.knowledgeDir, page.file))) {
        staleCandidates++;
        continue;
      }
      candidates.push({
        file: page.file,
        title: page.title,
        description: page.description,
        score: pageScore(query, matches),
        labels: page.labels,
        matchedLabels: matches.map(({ facet, value, matchedBy, pageCount }) => ({ facet, value, matchedBy, pageCount })),
        routeProof,
        library,
      });
    }
    candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

    const { libraries, routing } = this.routeLibraries(query, candidates, topK, libraryFilter);
    // With a confident route, the flat result list is drawn from the routed
    // libraries only; the per-library groups still expose every other match so
    // nothing is hidden, merely ranked behind the route.
    const routedSet = new Set(routing.selected);
    const routed = routing.selected.length > 0
      ? candidates.filter((candidate) => routedSet.has(candidate.library))
      : candidates;

    return {
      pages: routed.slice(0, topK),
      matchedPages: candidates.length,
      totalPages: reachableLabeledPages,
      totalLabels: this.catalog({ limit: 1 }).totalLabels,
      libraries,
      routing,
      staleCandidates,
      unknownLibrary: false,
      invalidLabeledPages: this.invalidLabeledPages,
      unlabeledPages: this.unlabeledPages,
      unreachableLabeledPages: this.pages.size - reachableLabeledPages,
    };
  }

  private reachableLabeledPageCount(): number {
    let count = 0;
    for (const page of this.pages.values()) {
      if (this.routes.has(page.file.replaceAll("\\", "/"))) count++;
    }
    return count;
  }

  /**
   * Stage 1 of a multi-library search: score each library from the labels its
   * pages matched AND from its own name/domain, then pick the libraries that
   * clearly lead. No leader → every library stays in play (`fallback`).
   */
  private routeLibraries(
    query: string,
    candidates: KnowledgePageCandidate[],
    topK: number,
    libraryFilter: string | undefined,
  ): { libraries: KnowledgeLibraryCandidate[]; routing: KnowledgeLibraryRouting } {
    const multiLibrary = this.libraries.length > 1;
    const byRoot = new Map<string, KnowledgePageCandidate[]>();
    for (const candidate of candidates) {
      const list = byRoot.get(candidate.library) ?? [];
      list.push(candidate);
      byRoot.set(candidate.library, list);
    }

    const libraries: KnowledgeLibraryCandidate[] = [];
    for (const library of this.libraries) {
      if (libraryFilter !== undefined && library.root !== libraryFilter) continue;
      const pages = byRoot.get(library.root) ?? [];
      const why: string[] = [];
      const bestPage = pages[0]?.score ?? 0;
      if (pages[0]) {
        for (const label of pages[0].matchedLabels.slice(0, 2)) why.push(`label: ${label.matchedBy}`);
      }
      const domainTerms = libraryDomainTerms(library);
      const matchedDomainTerms = domainTerms.filter((term) => termScore(query, term) > 0);
      const domainScore = multiLibrary && domainTerms.length > 0
        ? queryCoverage(query, matchedDomainTerms)
        : 0;
      for (const term of matchedDomainTerms.slice(0, 2)) why.push(`domain: ${term}`);
      const density = Math.min(1, pages.length / 3);
      const score = pages.length === 0 && domainScore === 0
        ? 0
        : Math.min(1, 0.7 * bestPage + 0.1 * density + 0.2 * domainScore);
      if (score === 0 && !multiLibrary) continue;
      if (score === 0) continue;
      libraries.push({ ...library, score: Math.round(score * 1000) / 1000, why, matchedPages: pages.length, pages: pages.slice(0, topK) });
    }
    libraries.sort((a, b) => b.score - a.score || a.root.localeCompare(b.root));

    if (!multiLibrary || libraryFilter !== undefined) {
      return { libraries, routing: { multiLibrary, selected: libraryFilter !== undefined ? [libraryFilter] : [], fallback: false, margin: null } };
    }
    const top = libraries[0]?.score ?? 0;
    const margin = libraries.length >= 2 ? Math.round((libraries[0].score - libraries[1].score) * 1000) / 1000 : null;
    if (top < LIBRARY_ROUTE_MIN_SCORE) {
      return { libraries, routing: { multiLibrary, selected: [], fallback: candidates.length > 0, margin } };
    }
    const selected = libraries
      .filter((library) => library.score >= LIBRARY_ROUTE_MIN_SCORE && top - library.score <= LIBRARY_ROUTE_MARGIN)
      .map((library) => library.root);
    return { libraries, routing: { multiLibrary, selected, fallback: false, margin } };
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
      invalidLabeledPages: this.invalidLabeledPages,
      unlabeledPages: this.unlabeledPages,
      unreachableLabeledPages: this.pages.size - reachableLabeledPages,
    };
  }
}
