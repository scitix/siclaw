import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../tools/infra/tool-render.js";
import {
  normalizeKnowledgeRuntimeBindings,
  type KnowledgeEvidence,
  type KnowledgeEvidenceSet,
  type KnowledgeRetrieveExecutor,
  type KnowledgeRetrieveRequest,
  type KnowledgeRuntimeBinding,
} from "./contracts.js";

const MAX_QUERY_CHARS = 4_000;
const MAX_TOP_K = 50;
const MAX_EVIDENCE = 20;
const MAX_EVIDENCE_CONTENT_CHARS = 2_000;

export interface KnowledgeRuntimeResult {
  tools: ToolDefinition[];
  promptContext: string;
  materializedRoots: string[];
}

export function loadKnowledgeRuntimeBindings(knowledgeDir: string): KnowledgeRuntimeBinding[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(knowledgeDir, ".sync-manifest.json"), "utf8")) as {
      bindings?: unknown;
    };
    return normalizeKnowledgeRuntimeBindings(raw.bindings);
  } catch {
    return [];
  }
}

function hasCapability(binding: KnowledgeRuntimeBinding, kind: "materialized" | "retrieve"): boolean {
  return binding.capabilities.some((capability) => capability.kind === kind);
}

function buildPromptContext(bindings: KnowledgeRuntimeBinding[]): string {
  if (bindings.length === 0) return "";
  const lines = [
    "# Bound Knowledge Bases",
    "",
    "Use only the knowledge bases listed below. Whole-page Wiki content is available through Read; " +
      "large or incident-oriented collections are available through `knowledge_retrieve`. " +
      "When both are available, prefer Wiki pages for normative procedures and retrieval for historical or long-tail cases. " +
      "Cite the evidence you use and report conflicts instead of silently merging them.",
    "",
  ];
  for (const binding of bindings) {
    const modes = [
      ...(hasCapability(binding, "materialized") ? ["Wiki"] : []),
      ...(hasCapability(binding, "retrieve") ? ["retrieval"] : []),
    ].join(" + ");
    lines.push(`- ${binding.name} (\`${binding.repoId}\`, ${modes}, version ${binding.version})` +
      `${binding.description ? ` — ${binding.description}` : ""}`);
  }
  return lines.join("\n");
}

function normalizeRequest(
  raw: unknown,
  retrievableRepoIds: Set<string>,
): KnowledgeRetrieveRequest | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "knowledge_retrieve requires an object input." };
  const params = raw as Record<string, unknown>;
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) return { error: "knowledge_retrieve requires a non-empty query." };
  if (query.length > MAX_QUERY_CHARS) {
    return { error: `knowledge_retrieve query exceeds ${MAX_QUERY_CHARS} characters.` };
  }

  let repoIds: string[] | undefined;
  if (params.repo_ids !== undefined) {
    if (!Array.isArray(params.repo_ids)) return { error: "repo_ids must be an array." };
    repoIds = [...new Set(params.repo_ids.filter((item): item is string => typeof item === "string" && item.length > 0))];
    if (repoIds.length === 0) return { error: "repo_ids must contain at least one repository id." };
    const forbidden = repoIds.filter((repoId) => !retrievableRepoIds.has(repoId));
    if (forbidden.length > 0) {
      return { error: `Repository is not bound for retrieval: ${forbidden.join(", ")}` };
    }
  } else {
    repoIds = [...retrievableRepoIds];
  }

  let topK: number | undefined;
  if (params.top_k !== undefined) {
    if (typeof params.top_k !== "number" || !Number.isInteger(params.top_k)) {
      return { error: "top_k must be an integer." };
    }
    topK = Math.min(MAX_TOP_K, Math.max(1, params.top_k));
  }

  const filters = params.filters && typeof params.filters === "object" && !Array.isArray(params.filters)
    ? params.filters as Record<string, unknown>
    : undefined;
  return { query, repoIds, filters, topK };
}

function compactEvidence(item: KnowledgeEvidence): KnowledgeEvidence {
  return {
    ...item,
    content: item.content.length > MAX_EVIDENCE_CONTENT_CHARS
      ? `${item.content.slice(0, MAX_EVIDENCE_CONTENT_CHARS)}…`
      : item.content,
  };
}

function compactEvidenceSet(result: KnowledgeEvidenceSet): KnowledgeEvidenceSet {
  return {
    retrievalId: result.retrievalId,
    evidence: result.evidence.slice(0, MAX_EVIDENCE).map(compactEvidence),
  };
}

function createKnowledgeRetrieveTool(
  bindings: KnowledgeRuntimeBinding[],
  executeRetrieve: KnowledgeRetrieveExecutor,
): ToolDefinition {
  const retrievable = bindings.filter((binding) => hasCapability(binding, "retrieve"));
  const retrievableRepoIds = new Set(retrievable.map((binding) => binding.repoId));
  const catalog = retrievable
    .map((binding) => `- ${binding.name}: ${binding.repoId}${binding.description ? ` — ${binding.description}` : ""}`)
    .join("\n");

  return {
    name: "knowledge_retrieve",
    label: "Knowledge Retrieve",
    description: `Retrieve evidence from knowledge bases bound to this agent.
Use for historical incidents, semantic similarity, and large collections that are not practical to browse page-by-page.
Omit repo_ids to search every bound retrieval knowledge base.

Bound retrieval knowledge bases:
${catalog}

Returns an EvidenceSet with retrieval_id, source ids, citations, scores, and index versions.`,
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language or exact-identifier query" }),
      repo_ids: Type.Optional(Type.Array(Type.String(), {
        description: "Bound repository ids to search. Omit to search all retrieval-enabled bindings.",
      })),
      filters: Type.Optional(Type.Object({}, {
        additionalProperties: true,
        description: "Provider-supported structured filters",
      })),
      top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TOP_K })),
    }),
    renderCall(args: unknown, theme: { fg(name: string, value: string): string; bold(value: string): string }) {
      const query = args && typeof args === "object" && typeof (args as { query?: unknown }).query === "string"
        ? (args as { query: string }).query
        : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("knowledge_retrieve")) +
          (query ? ` ${theme.fg("accent", query)}` : ""),
        0,
        0,
      );
    },
    renderResult: renderTextResult,
    async execute(_toolCallId, rawParams, signal) {
      const request = normalizeRequest(rawParams, retrievableRepoIds);
      if ("error" in request) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: request.error }) }],
          details: { status: "invalid_request" },
        };
      }
      try {
        const result = compactEvidenceSet(await executeRetrieve(request, signal));
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: {
            status: "success",
            retrieval_id: result.retrievalId,
            evidence_count: result.evidence.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          details: { status: "error" },
        };
      }
    },
  };
}

export function buildKnowledgeRuntime(input: {
  bindings: KnowledgeRuntimeBinding[];
  retrieve?: KnowledgeRetrieveExecutor;
  knowledgeDir?: string;
}): KnowledgeRuntimeResult {
  const bindings = normalizeKnowledgeRuntimeBindings(input.bindings);
  const retrievable = bindings.some((binding) => hasCapability(binding, "retrieve"));
  const materializedRoots = bindings.flatMap((binding) =>
    binding.capabilities
      .filter((capability) => capability.kind === "materialized")
      .map((capability) => path.resolve(input.knowledgeDir ?? process.cwd(), capability.rootPath ?? ".")),
  );
  return {
    tools: retrievable && input.retrieve
      ? [createKnowledgeRetrieveTool(bindings, input.retrieve)]
      : [],
    promptContext: buildPromptContext(bindings),
    materializedRoots,
  };
}
