import fs from "node:fs";
import path from "node:path";

import { isKnowledgeNavigationPage } from "./page-kind.js";

export interface KnowledgeRouteStep {
  file: string;
  kind: "catalog" | "leaf";
  via?: string;
}

export interface KnowledgeRouteProof {
  reachable: true;
  trail: KnowledgeRouteStep[];
}

interface CatalogLink {
  file: string;
  text: string;
}

const MARKDOWN_LINK_RE = /(?<!!)\[([^\]]+)\]\((<[^>]+>|[^)\n]+)\)/g;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function markdownDestination(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("<") && value.endsWith(">")) return value.slice(1, -1);
  const titled = value.match(/^(.*?)\s+(?:"[^"]*"|'[^']*')$/);
  return titled ? titled[1].trim() : value;
}

function resolveMarkdownTarget(catalogFile: string, rawTarget: string): string | null {
  let target = safeDecode(rawTarget).split("#", 1)[0].split("?", 1)[0].trim();
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  target = target.replaceAll("\\", "/");
  const base = target.startsWith("/") ? "" : path.posix.dirname(catalogFile);
  const resolved = path.posix.normalize(path.posix.join(base, target.replace(/^\/+/, "")));
  if (!resolved || resolved === "." || resolved === ".." || resolved.startsWith("../")) return null;
  return resolved.toLowerCase().endsWith(".md") ? resolved : `${resolved}.md`;
}

function linksFromCatalog(catalogFile: string, markdown: string): CatalogLink[] {
  const links: CatalogLink[] = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK_RE)) {
    const file = resolveMarkdownTarget(catalogFile, markdownDestination(match[2]));
    if (file) links.push({ file, text: match[1].trim() || file });
  }
  for (const match of markdown.matchAll(WIKILINK_RE)) {
    const file = resolveMarkdownTarget(catalogFile, match[1].trim());
    if (file) links.push({ file, text: match[2]?.trim() || match[1].trim() });
  }
  return links.sort((a, b) => a.file.localeCompare(b.file) || a.text.localeCompare(b.text));
}

/** Build one canonical, shortest catalog trail from root index.md to each reachable page. */
export function buildKnowledgeCatalogRoutes(knowledgeDir: string): Map<string, KnowledgeRouteProof> {
  const root = path.resolve(knowledgeDir);
  const catalogs = new Map<string, CatalogLink[]>();
  const catalogFiles = new Set<string>();

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
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      let markdown: string;
      try { markdown = fs.readFileSync(absolute, "utf8"); } catch { continue; }
      const file = path.relative(root, absolute).replaceAll("\\", "/");
      if (!isKnowledgeNavigationPage(file, markdown)) continue;
      catalogFiles.add(file);
      catalogs.set(file, linksFromCatalog(file, markdown));
    }
  };
  visit(root);

  const rootCatalog = "index.md";
  if (!catalogFiles.has(rootCatalog)) return new Map();

  const routes = new Map<string, KnowledgeRouteProof>();
  routes.set(rootCatalog, {
    reachable: true,
    trail: [{ file: rootCatalog, kind: "catalog" }],
  });
  const queue = [rootCatalog];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const catalog = queue[cursor];
    const parent = routes.get(catalog)!;
    for (const link of catalogs.get(catalog) ?? []) {
      if (routes.has(link.file)) continue;
      const isCatalog = catalogFiles.has(link.file);
      routes.set(link.file, {
        reachable: true,
        trail: [
          ...parent.trail,
          { file: link.file, kind: isCatalog ? "catalog" : "leaf", via: link.text },
        ],
      });
      if (isCatalog) queue.push(link.file);
    }
  }
  return routes;
}
