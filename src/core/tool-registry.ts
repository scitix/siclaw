/**
 * Tool Registry — declarative tool registration and resolution.
 *
 * Each tool file exports a `registration: ToolEntry` that declares its
 * metadata (category, modes, platform exemption, availability guard).
 * The registry collects all entries and resolves the final tool list
 * in one pass: mode filter → available check → instantiate → allowedTools filter.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  SessionMode, KubeconfigRef, LlmConfigRef, MemoryRef, DpStateRef,
} from "./types.js";
import type { MemoryIndexer } from "../memory/indexer.js";

export type { SessionMode };

/** All dependencies shared by tool factory functions. */
export interface ToolRefs {
  kubeconfigRef: KubeconfigRef;
  userId: string;
  sessionIdRef: { current: string };
  llmConfigRef: LlmConfigRef;
  memoryRef: MemoryRef;
  dpStateRef: DpStateRef;
  knowledgeIndexer?: MemoryIndexer;
  memoryIndexer?: MemoryIndexer;
  memoryDir?: string;
}

/** Declarative registration for a single tool. */
export interface ToolEntry {
  /** Tool category — documentation only, not used for filtering. */
  category: "cmd-exec" | "script-exec" | "query" | "workflow";

  /** Factory function — receives shared refs, returns a ToolDefinition. */
  create: (refs: ToolRefs) => ToolDefinition;

  /**
   * Session modes where this tool is available. Omit = all modes.
   * Replaces the scattered `if (mode === "web")` logic in agent-factory.
   */
  modes?: SessionMode[];

  /** Platform tool — exempt from allowedTools workspace filtering. */
  platform?: boolean;

  /**
   * Runtime availability check. Return false to skip this tool (create is not called).
   * Use for tools that depend on resources that may not be available
   * (e.g. memoryIndexer initialization failure).
   * Omit = always available.
   */
  available?: (refs: ToolRefs) => boolean;
}

export class ToolRegistry {
  private entries: ToolEntry[] = [];

  register(...entries: ToolEntry[]): void {
    this.entries.push(...entries);
  }

  /**
   * Resolve the final tool list in one pass:
   * 1. Filter by mode + available guard (zero cost — create not called)
   * 2. Instantiate only the tools that passed filtering
   * 3. Apply allowedTools whitelist (platform tools exempt)
   */
  resolve(opts: {
    mode: SessionMode;
    refs: ToolRefs;
    allowedTools?: string[] | null;
  }): ToolDefinition[] {
    const { mode, refs, allowedTools } = opts;

    // 1. mode filter + available check (create not called yet)
    const applicable = this.entries.filter(
      (e) =>
        (!e.modes || e.modes.includes(mode)) &&
        (!e.available || e.available(refs)),
    );

    // 2. Instantiate only applicable tools
    const tools = applicable.map((e) => ({
      def: e.create(refs),
      platform: e.platform ?? false,
    }));

    // 3. allowedTools whitelist (platform tools exempt)
    if (Array.isArray(allowedTools)) {
      const allowed = new Set(allowedTools);
      return tools
        .filter((t) => t.platform || allowed.has(t.def.name))
        .map((t) => t.def);
    }

    return tools.map((t) => t.def);
  }
}
