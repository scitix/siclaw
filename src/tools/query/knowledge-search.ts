import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { ToolEntry } from "../../core/tool-registry.js";
import type { KnowledgeLookupResult, KnowledgeResolver } from "../../knowledge/resolver-types.js";
import { renderTextResult } from "../infra/tool-render.js";

interface KnowledgeSearchParams {
  query: string;
}

interface TurnCache {
  turn: number;
  result: KnowledgeLookupResult;
}

/** Try to accelerate a concrete question into one conservative page read. */
export function createKnowledgeSearchTool(
  resolver: KnowledgeResolver,
  turnRef?: { current: number },
): ToolDefinition {
  let cache: TurnCache | undefined;

  return {
    name: "knowledge_search",
    label: "Knowledge Search",
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("knowledge_search")) +
          " " + theme.fg("accent", args?.query || ""),
        0,
        0,
      );
    },
    renderResult: renderTextResult,
    description:
      "Optional accelerator for a concrete knowledge question that likely has one direct page answer. " +
      "Use it at most once per user turn with the question as asked; do not repeatedly rewrite or search. " +
      "A direct_hit contains one page snapshot, but similarity is not proof: validate subject, task, version, environment, and scope before using it, then cite only material actually used. " +
      "For a direct_hit, follow citationMode exactly: use returned evidenceRefs for evidence, pass the page for page, and do not call knowledge_cite for none. " +
      "An explore result contains unverified page hints, not evidence. Continue with Find/Grep/Read using the returned indexPath, readPath hints, and linked pages for broad, novel, ambiguous, comparative, weak-match, or cross-page questions. " +
      "Unavailable also means use Wiki exploration; neither status means the knowledge is absent. Bound Skills supplement domain reasoning and must not replace it.",
    parameters: Type.Object({
      query: Type.String({ description: "The user's original knowledge question, including any product, version, environment, and task details they supplied." }),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as KnowledgeSearchParams;
      const currentTurn = turnRef?.current;
      if (currentTurn !== undefined && cache?.turn === currentTurn) {
        const repeated = {
          status: "already_resolved",
          wikiRoot: cache.result.wikiRoot,
          indexPath: cache.result.indexPath,
          message: "The retrieval accelerator was already used this turn. Do not call it again; validate the direct page or continue Wiki exploration with Find/Grep/Read.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(repeated, null, 2) }],
          details: { status: cache.result.status, resultCount: cache.result.results.length, reused: true },
        };
      }

      const result = await resolver.lookup(params.query ?? "");
      if (currentTurn !== undefined) cache = { turn: currentTurn, result };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { status: result.status, resultCount: result.results.length, reused: false },
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createKnowledgeSearchTool(refs.knowledgeResolver!, refs.turnRef),
  available: (refs) => Boolean(refs.knowledgeResolver),
  readOnlyDelegable: true,
};
