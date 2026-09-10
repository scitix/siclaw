import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { buildKnowledgeCatalogRoutes } from "./catalog-graph.js";
import { parseKnowledgeLabels } from "./labels.js";
import { modelKnowledgePath } from "./model-path.js";
import { isKnowledgeNavigationPage } from "./page-kind.js";

// The runtime artifact wrapper also replaces outputs above 8,000 characters.
// Both limits must hold before a page is registered as completely read.
export const LOOKUP_OUTPUT_BYTES = 12_000;
const LOOKUP_OUTPUT_CHARS = 8_000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_PAGES = 10_000;

interface Library { id: string; name: string; root: string; version?: number | string }
interface Page { relative: string; title: string; library: Library; hash: string }
export interface LookupOptions {
  query: string;
  topK?: number;
  readCount?: number;
  repoIds?: string[];
}
export interface LookupCandidate {
  rank: number;
  file: string;
  title: string;
  library: Library;
  contentHash: string;
  readStatus: "candidate" | "full" | "budget_exceeded";
  content?: string;
}
export interface LookupResult {
  mode: "content";
  generation: string;
  totalPages: number;
  matchedPages: number;
  hasMore: boolean;
  results: LookupCandidate[];
  message: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const encoded = (term: string) => `t${Buffer.from(term).toString("hex")}`;
function fitsOutput(value: unknown, reserve = 0): boolean {
  const text = JSON.stringify(value);
  return text.length <= LOOKUP_OUTPUT_CHARS - reserve && Buffer.byteLength(text) <= LOOKUP_OUTPUT_BYTES - reserve;
}

/** Identical document/query tokenization: retain numbers, negations and identifiers. */
export function knowledgeTerms(text: string, expandIdentifiers = true): string[] {
  const terms: string[] = [];
  for (const match of text.normalize("NFKC").toLowerCase().matchAll(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+(?:[._:/-](?:(?!\p{Script=Han})[\p{L}\p{N}])+)*/gu)) {
    const term = match[0];
    if (/^\p{Script=Han}+$/u.test(term)) {
      const chars = Array.from(term);
      if (chars.length === 1) terms.push(term);
      for (let i = 0; i + 1 < chars.length; i++) terms.push(chars[i] + chars[i + 1]);
    } else {
      terms.push(term);
      if (expandIdentifiers && /[._:/-]/.test(term)) terms.push(...term.split(/[._:/-]/));
    }
  }
  return terms;
}

function optionalFile(file: string): string {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** A disposable, agent-mount-scoped index. No Wiki writes or embedding provider. */
export class KnowledgeLookupIndex {
  private db?: DatabaseSync;
  private pages: Page[] = [];
  private libraries: Library[] = [];
  private generation = "";
  private revision = 0;
  private building?: Promise<void>;
  private closed = false;

  constructor(private readonly root: string) {}

  invalidate(): void { this.revision++; }

  private snapshot(): { generation: string; libraries: Library[] } {
    const citations = optionalFile(path.join(this.root, ".citation-manifest.json"));
    const sync = optionalFile(path.join(this.root, ".sync-manifest.json"));
    const generation = digest(JSON.stringify([this.revision, citations, sync]));
    if (!citations) {
      if (sync) throw new Error("Knowledge mount is incomplete; retry after synchronization.");
      return { generation, libraries: [{ id: "local", name: "Local knowledge", root: "" }] };
    }
    const manifest = JSON.parse(citations);
    const versions = sync ? JSON.parse(sync) : { repos: [] };
    if (!Array.isArray(manifest.repos) || !Array.isArray(versions.repos)) throw new Error("Invalid knowledge mount manifest.");
    const ids = new Set<string>();
    const libraries: Library[] = manifest.repos.map((repo: any) => {
      if (typeof repo.id !== "string" || !repo.id || ids.has(repo.id) || typeof repo.root !== "string" ||
          path.isAbsolute(repo.root) || repo.root.includes("\\") || repo.root.split("/").includes("..")) {
        throw new Error("Invalid knowledge library identity or root.");
      }
      ids.add(repo.id);
      const version = versions.repos.find((entry: any) => entry.id === repo.id);
      return {
        id: repo.id,
        name: typeof version?.name === "string" ? version.name : repo.id,
        root: repo.root.replace(/\/$/, ""),
        ...(typeof version?.version === "string" || Number.isSafeInteger(version?.version) ? { version: version.version } : {}),
      };
    });
    return { generation, libraries: libraries.sort((a, b) => b.root.length - a.root.length) };
  }

  private libraryFor(relative: string, libraries: Library[]): Library | undefined {
    return libraries.find((lib) => lib.root === "" || relative.startsWith(`${lib.root}/`));
  }

  private async readPage(relative: string): Promise<string | undefined> {
    if (relative.split("/").some((part) => part.startsWith(".")) || !relative.toLowerCase().endsWith(".md")) return;
    const absolute = path.resolve(this.root, relative);
    if (!within(path.resolve(this.root), absolute)) return;
    try {
      // Reject symlinks in every component, including links to another mounted library.
      let component = this.root;
      for (const part of relative.split("/")) {
        component = path.join(component, part);
        if ((await fs.promises.lstat(component)).isSymbolicLink()) return;
      }
      const stat = await fs.promises.stat(absolute);
      if (!stat.isFile()) return;
      if (stat.size > MAX_PAGE_BYTES) throw new Error(`Knowledge page exceeds ${MAX_PAGE_BYTES} bytes: ${relative}`);
      const content = await fs.promises.readFile(absolute, "utf8");
      if (Buffer.byteLength(content) > MAX_PAGE_BYTES) throw new Error(`Knowledge page grew beyond the indexing limit: ${relative}`);
      return content;
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
  }

  private async rebuild(): Promise<void> {
    const snapshot = this.snapshot();
    const db = new DatabaseSync(":memory:");
    const pages: Page[] = [];
    let totalBytes = 0;
    try {
      db.exec("CREATE VIRTUAL TABLE pages USING fts5(title, labels, headings, body, repo UNINDEXED)");
      const insert = db.prepare("INSERT INTO pages(rowid,title,labels,headings,body,repo) VALUES(?,?,?,?,?,?)");
      for (const relative of buildKnowledgeCatalogRoutes(this.root).keys()) {
        if (this.closed) throw new Error("Knowledge lookup is closed.");
        const library = this.libraryFor(relative, snapshot.libraries);
        if (!library) continue;
        const content = await this.readPage(relative);
        if (content === undefined || isKnowledgeNavigationPage(relative, content) || path.basename(relative) === "log.md") continue;
        totalBytes += Buffer.byteLength(content);
        if (totalBytes > MAX_INDEX_BYTES || pages.length >= MAX_INDEX_PAGES) throw new Error("Knowledge mount exceeds lookup indexing limits; use catalog/Read.");
        const labels = parseKnowledgeLabels(content);
        const body = content.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*\r?\n/, "");
        const title = (labels?.title || body.match(/^#\s+(.+)$/m)?.[1] || path.basename(relative, ".md")).slice(0, 200);
        const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1]).join(" ");
        const aliases = labels?.labels.flatMap((label) => [label.value, ...label.aliases]).join(" ") ?? "";
        const tokens = (value: string) => knowledgeTerms(value).map(encoded).join(" ");
        pages.push({ relative, title, library, hash: digest(content) });
        insert.run(pages.length, tokens(title), tokens(aliases), tokens(headings), tokens(body), library.id);
      }
      if (this.closed || snapshot.generation !== this.snapshot().generation) throw new Error("Knowledge mount changed while indexing; retry lookup.");
      this.db?.close();
      this.db = db;
      this.pages = pages;
      this.libraries = snapshot.libraries;
      this.generation = snapshot.generation;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private async ready(): Promise<void> {
    if (this.closed) throw new Error("Knowledge lookup is closed.");
    if (this.building) { await this.building; return this.ready(); }
    if (this.db && this.generation === this.snapshot().generation) return;
    this.building = this.rebuild();
    try { await this.building; } finally { this.building = undefined; }
  }

  async lookup(options: LookupOptions, signal?: AbortSignal): Promise<LookupResult> {
    if (typeof options.query !== "string" || !options.query.trim() || options.query.length > 1000) throw new Error("query must contain 1–1000 characters.");
    const topK = options.topK ?? 6;
    const readCount = options.readCount ?? 2;
    if (!Number.isInteger(topK) || topK < 1 || topK > 20 || !Number.isInteger(readCount) || readCount < 0 || readCount > 5) throw new Error("topK must be 1–20 and readCount must be 0–5.");
    if (options.repoIds !== undefined && (!Array.isArray(options.repoIds) || !options.repoIds.length || options.repoIds.some((id) => typeof id !== "string"))) throw new Error("repoIds must be a nonempty array of library IDs.");
    const terms = [...new Set(knowledgeTerms(options.query, false))];
    if (!terms.length || terms.length > 64) throw new Error("Use a query with 1–64 searchable terms.");
    // Bind the expression, quote every token, and never execute user FTS syntax.
    const expression = terms.map((term) => `"${encoded(term)}"`).join(" OR ");
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      await this.ready();
      signal?.throwIfAborted();
      if (options.repoIds?.some((id) => !this.libraries.some((library) => library.id === id))) throw new Error("Unknown library ID; use IDs from mounted lookup results.");
      const filter = options.repoIds ? ` AND repo IN (${options.repoIds.map(() => "?").join(",")})` : "";
      const bindings = [expression, ...options.repoIds ?? []];
      const rows = this.db!.prepare(`SELECT rowid FROM pages WHERE pages MATCH ?${filter} ORDER BY bm25(pages,8,6,3,1,0),rowid LIMIT ?`).all(...bindings, topK) as { rowid: number }[];
      const matched = this.db!.prepare(`SELECT count(*) AS count FROM pages WHERE pages MATCH ?${filter}`).get(...bindings) as { count: number };
      const pages = this.pages;
      const result: LookupResult = {
        mode: "content", generation: this.generation, totalPages: this.pages.length, matchedPages: matched.count,
        hasMore: matched.count > rows.length, results: [],
        message: "Only readStatus=full is evidence already read. Other results require Read(file). Check applicability and linked prerequisites before answering; cite only evidence used. Ranking is lexical relevance, not confidence. Refine or use the catalog when evidence is insufficient.",
      };
      let stale = false;
      // Reserve space for the ranked candidate set before allocating page contents.
      for (const row of rows) {
        const page = pages[row.rowid - 1];
        const candidate: LookupCandidate = {
          rank: result.results.length + 1, file: modelKnowledgePath(this.root, page.relative),
          title: page.title, library: page.library, contentHash: page.hash, readStatus: "candidate",
        };
        result.results.push(candidate);
        if (!fitsOutput(result, 100)) { result.results.pop(); result.hasMore = true; break; }
      }
      for (let i = 0; i < Math.min(readCount, result.results.length); i++) {
        signal?.throwIfAborted();
        const candidate = result.results[i];
        const page = pages[rows[i].rowid - 1];
        const content = await this.readPage(page.relative);
        if (content === undefined || digest(content) !== page.hash) { stale = true; break; }
        candidate.content = content;
        candidate.readStatus = "full";
        if (!fitsOutput(result)) {
          delete candidate.content;
          candidate.readStatus = "budget_exceeded";
        }
      }
      signal?.throwIfAborted();
      if (!stale && result.generation === this.snapshot().generation) return result;
      this.invalidate();
    }
    throw new Error("Knowledge pages changed during lookup; retry against the synchronized mount.");
  }

  close(): void {
    this.closed = true;
    this.db?.close();
    this.db = undefined;
    this.pages = [];
  }
}
