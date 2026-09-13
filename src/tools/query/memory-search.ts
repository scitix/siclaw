import { createPrivateMemorySearchTool } from "./private-memory.js";
import type { ToolEntry } from "../../core/tool-registry.js";
import { isMemoryEnabled } from "../../core/config.js";

export const registration: ToolEntry = {
  category: "query",
  create: refs => {
    if (!refs.privateMemory) throw new Error("Memory backend is unavailable");
    return createPrivateMemorySearchTool(refs.privateMemory, refs.turnRef);
  },
  available: refs => isMemoryEnabled() && !!refs.privateMemory,
};
