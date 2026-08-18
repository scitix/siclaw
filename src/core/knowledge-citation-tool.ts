import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../tools/infra/tool-render.js";
import type { SessionEventEmitter } from "./tool-registry.js";
import type { KnowledgeSourceCitation } from "../shared/knowledge-citations.js";

export const KNOWLEDGE_CITATION_MANIFEST = ".citation-manifest.json";

interface CitationManifestSource { resource: string; title: string; url: string }
interface CitationManifestRepo { id: string; root: string; sources: CitationManifestSource[] }
interface CitationManifest { version: 1; repos: CitationManifestRepo[] }

function result(text: string, cited: number) {
  return { content: [{ type: "text" as const, text }], details: { cited } };
}

function normalizedResource(value: string): string {
  const clean = path.posix.normalize(value.replaceAll("\\", "/").replace(/^\.\//, "")).replace(/^\/+/, "");
  return clean.startsWith("raw/") ? clean.slice(4) : clean;
}

function readManifest(knowledgeDir: string): CitationManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(knowledgeDir, KNOWLEDGE_CITATION_MANIFEST), "utf8")) as CitationManifest;
    return parsed?.version === 1 && Array.isArray(parsed.repos) ? parsed : null;
  } catch {
    return null;
  }
}

function pageResources(pagePath: string): string[] {
  const body = fs.readFileSync(pagePath, "utf8");
  if (!body.startsWith("---\n")) return [];
  const end = body.indexOf("\n---", 4);
  if (end < 0 || end > 64 * 1024) return [];
  const frontmatter = yaml.load(body.slice(4, end)) as Record<string, unknown> | null;
  if (!frontmatter || !Array.isArray(frontmatter.sources)) return [];
  return frontmatter.sources.flatMap((source) => {
    if (!source || typeof source !== "object") return [];
    const resource = (source as Record<string, unknown>).resource;
    return typeof resource === "string" && resource.trim() ? [normalizedResource(resource)] : [];
  });
}

export function hasKnowledgeCitationManifest(knowledgeDir: string): boolean {
  return readManifest(knowledgeDir)?.repos.some((repo) => repo.sources.length > 0) ?? false;
}

export function createKnowledgeCitationSupport(opts: {
  knowledgeDir: string;
  turnRef: { current: number };
  sessionEventEmitter?: SessionEventEmitter;
}): { noteRead: (pagePath: string) => void; tool: ToolDefinition } {
  let turn = -1;
  const readPages = new Set<string>();
  const resetForTurn = () => {
    if (turn !== opts.turnRef.current) {
      turn = opts.turnRef.current;
      readPages.clear();
    }
  };
  const noteRead = (pagePath: string) => {
    resetForTurn();
    const absolute = path.resolve(pagePath);
    const root = path.resolve(opts.knowledgeDir);
    if (absolute.endsWith(".md") && (absolute === root || absolute.startsWith(root + path.sep))) {
      readPages.add(absolute);
    }
  };

  const tool: ToolDefinition = {
    name: "knowledge_cite",
    label: "Cite Knowledge Sources",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("knowledge_cite")), 0, 0),
    renderResult: renderTextResult,
    description:
      "Register the knowledge pages that materially support your final answer. Call once, immediately before the final answer, " +
      "and include only pages you successfully Read in this turn and actually used. The runtime validates their published original-source metadata and appends trusted links; never invent or copy source URLs yourself.",
    parameters: Type.Object({
      pages: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 3,
        description: "Absolute paths, or paths relative to the mounted knowledge directory, of the 1-3 adopted knowledge pages.",
      }),
    }),
    async execute(_toolCallId, rawParams) {
      resetForTurn();
      const manifest = readManifest(opts.knowledgeDir);
      if (!manifest) return result("No trusted original-source metadata is available for this knowledge mount.", 0);
      const rawPages = (rawParams as { pages?: unknown }).pages;
      if (!Array.isArray(rawPages)) return result("knowledge_cite requires pages.", 0);
      const selected = rawPages.map((raw) => {
        const value = String(raw);
        return path.resolve(path.isAbsolute(value) ? value : path.join(opts.knowledgeDir, value));
      });
      const unread = selected.find((page) => !readPages.has(page));
      if (unread) return result(`Cannot cite unread knowledge page: ${unread}`, 0);

      const citations: KnowledgeSourceCitation[] = [];
      const seenURLs = new Set<string>();
      for (const page of selected) {
        const rel = path.relative(opts.knowledgeDir, page).replaceAll(path.sep, "/");
        const repo = manifest.repos.find((candidate) => {
          const root = candidate.root.replace(/\/$/, "");
          return root === "" || rel === root || rel.startsWith(root + "/");
        });
        if (!repo) continue;
        const sourceByResource = new Map(repo.sources.map((source) => [normalizedResource(source.resource), source]));
        for (const resource of pageResources(page)) {
          const source = sourceByResource.get(resource);
          if (!source || seenURLs.has(source.url)) continue;
          seenURLs.add(source.url);
          citations.push({ title: source.title, url: source.url, resource: source.resource, page: rel });
          if (citations.length >= 3) break;
        }
        if (citations.length >= 3) break;
      }
      if (citations.length > 0) {
        opts.sessionEventEmitter?.({ type: "knowledge_sources", sources: citations });
      }
      return result(
        citations.length > 0
          ? `Registered ${citations.length} trusted original source${citations.length === 1 ? "" : "s"}; links will be appended automatically.`
          : "The selected pages have no trusted clickable original sources; answer normally without a references section.",
        citations.length,
      );
    },
  };
  return { noteRead, tool };
}
