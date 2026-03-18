import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { MemoryIndexer } from "../../memory/index.js";

/**
 * Memory flush extension.
 *
 * Reactive hooks only (proactive flush removed — it injected noisy save prompts
 * that consumed tokens and distracted the agent from its actual task):
 * - agent_end: sync memory index (picks up files written during the turn)
 * - session_compact: re-sync memory index after compaction
 * - session_shutdown: final sync before process exit
 */
export default function memoryFlushExtension(api: ExtensionAPI, memoryIndexer?: MemoryIndexer): void {
  if (memoryIndexer) {
    // After each agent turn: sync memory index
    api.on("agent_end", () => {
      memoryIndexer.sync().catch((err) => {
        console.warn(`[memory-flush] Post-turn sync failed:`, err);
      });
      return undefined;
    });
  }

  api.on("session_compact", () => {
    if (memoryIndexer) {
      memoryIndexer.sync().catch((err) => {
        console.warn(`[memory-flush] Post-compaction sync failed:`, err);
      });
    }
    return undefined;
  });

  if (memoryIndexer) {
    // On shutdown: final sync to persist any last writes
    api.on("session_shutdown", () => {
      memoryIndexer.sync().catch((err) => {
        console.warn(`[memory-flush] Shutdown sync failed:`, err);
      });
      return undefined;
    });
  }
}
