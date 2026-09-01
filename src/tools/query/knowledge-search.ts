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

/** Resolve a knowledge question into read leaf-page evidence in one tool call. */
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
      "Resolve the user's original knowledge question into a small set of relevant leaf-page evidence. " +
      "Call this once per user turn with the question as asked; do not pre-search an index page, rewrite the query repeatedly, or Read the returned pages again. " +
      "Bound Skills are supplementary and must not replace or repeat this platform retrieval step. " +
      "A ready result contains page content already read and bounded to the current model context. Answer only from that evidence, then call knowledge_cite once for the evidence_refs and citable pages actually used. " +
      "A not_found or unavailable result is not evidence; say what is missing or use ordinary Grep/Read only when further investigation is necessary.",
    parameters: Type.Object({
      query: Type.String({ description: "The user's original knowledge question, including any product, version, environment, and task details they supplied." }),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as KnowledgeSearchParams;
      const currentTurn = turnRef?.current;
      if (currentTurn !== undefined && cache?.turn === currentTurn) {
        const repeated = {
          status: "already_resolved",
          message: "Knowledge was already resolved earlier this turn. Use the evidence from the first result; do not call knowledge_search again.",
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
