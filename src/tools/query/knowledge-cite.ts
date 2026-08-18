import type { ToolEntry } from "../../core/tool-registry.js";
import { createKnowledgeCitationSupport } from "../../core/knowledge-citation-tool.js";

// knowledge_cite is registered like every model-visible Siclaw tool, while its
// per-session implementation is injected by agent-factory because it shares
// state with the framework-owned Read tool.
export const registration: ToolEntry = {
  category: "query",
  create: (refs) => refs.knowledgeCitationTool ?? createKnowledgeCitationSupport({
    knowledgeDir: "",
    turnRef: { current: 0 },
  }).tool,
  available: (refs) => Boolean(refs.knowledgeCitationTool),
  readOnlyDelegable: true,
};
