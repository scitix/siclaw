import type { ToolEntry } from "../../core/tool-registry.js";

// knowledge_cite is registered like every model-visible Siclaw tool, while its
// per-session implementation is injected by agent-factory because it shares
// state with the framework-owned Read tool.
export const registration: ToolEntry = {
  category: "query",
  create: (refs) => refs.knowledgeCitationTool!,
  available: (refs) => Boolean(refs.knowledgeCitationTool && refs.sessionEventEmitter),
};
