import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { MemoryIndexer } from "../../memory/index.js";

/**
 * Memory flush extension.
 *
 * - agent_end: sync memory index after each agent turn (picks up files written during the turn)
 * - session_before_compact: inject flush prompt so the agent saves important context
 * - session_compact: re-sync memory index after compaction
 * - session_shutdown: final sync before process exit
 */
export default function memoryFlushExtension(api: ExtensionAPI, memoryIndexer?: MemoryIndexer): void {
  if (memoryIndexer) {
    // After each agent turn: sync memory index to pick up files the agent wrote
    api.on("agent_end", () => {
      memoryIndexer.sync().catch((err) => {
        console.warn(`[memory-flush] Post-turn sync failed:`, err);
      });
      return undefined;
    });
  }

  // Before compaction: inject a flush prompt so the agent saves memories
  api.on("session_before_compact", (_event, _ctx) => {
    const dateStamp = new Date().toISOString().slice(0, 10);

    api.sendUserMessage(
      `[System] Pre-compaction memory flush. ` +
      `Context is about to be compacted. Save any important discoveries, findings, or context ` +
      `from this session to \`memory/${dateStamp}.md\` now. ` +
      `If the file already exists, APPEND new content — do not overwrite existing entries. ` +
      `If there is nothing important to save, continue without writing.`,
      { deliverAs: "followUp" },
    );

    return undefined;
  });

  if (memoryIndexer) {
    // After compaction: re-sync memory index to pick up newly written files
    api.on("session_compact", () => {
      memoryIndexer.sync().catch((err) => {
        console.warn(`[memory-flush] Post-compaction sync failed:`, err);
      });
      return undefined;
    });

    // On shutdown: final sync to persist any last writes
    api.on("session_shutdown", () => {
      memoryIndexer.sync().catch((err) => {
        console.warn(`[memory-flush] Shutdown sync failed:`, err);
      });
      return undefined;
    });
  }
}
