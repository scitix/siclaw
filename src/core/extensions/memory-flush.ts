import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { MemoryIndexer } from "../../memory/index.js";

/** Token buffer before context window limit to trigger proactive flush */
const SOFT_THRESHOLD_TOKENS = 4000;
/** Transcript byte size that forces a flush regardless of token count */
const FORCE_FLUSH_TRANSCRIPT_BYTES = 2 * 1024 * 1024; // 2MB
/** Rough char-to-token ratio */
const CHARS_PER_TOKEN = 4;
/** Silent reply token — agent replies with this when nothing to save */
const SILENT_REPLY_TOKEN = "NO_REPLY";

/**
 * Memory flush extension.
 *
 * Proactive flush:
 * - On every `context` event, checks if token usage is approaching the context window.
 *   If so (and we haven't flushed this compaction cycle), injects a flush turn.
 *
 * Reactive hooks:
 * - agent_end: sync memory index (picks up files written during the turn)
 * - session_before_compact: inject flush prompt as last chance before compaction
 * - session_compact: re-sync memory index after compaction
 * - session_shutdown: final sync before process exit
 *
 * Silent reply:
 * - Flush prompt tells agent to reply with NO_REPLY if nothing to save.
 * - The agent_end hook strips silent replies so they don't show to the user.
 */
export default function memoryFlushExtension(api: ExtensionAPI, memoryIndexer?: MemoryIndexer): void {
  /** Compaction count at the time of last proactive flush (gate: don't re-flush same cycle) */
  let lastFlushCompactionCount = -1;
  /** Number of compaction events observed */
  let compactionCount = 0;
  /** Whether a proactive flush has been injected and is pending */
  let flushPending = false;

  // ── Proactive flush: check token usage before every LLM call ──
  api.on("context", (_event, ctx) => {
    if (flushPending) return undefined; // already injected, don't re-trigger

    const usage = ctx.getContextUsage();
    const contextWindow = usage?.contextWindow ?? (ctx as any).model?.contextWindow;
    if (!contextWindow) return undefined;

    const currentTokens = usage?.tokens ?? 0;
    const threshold = contextWindow - SOFT_THRESHOLD_TOKENS;

    // Also check transcript size (char-based estimate)
    const messages = _event.messages ?? [];
    let totalChars = 0;
    for (const m of messages) {
      if (typeof m === "object" && m !== null) {
        totalChars += JSON.stringify(m).length;
      }
    }
    const transcriptBytes = totalChars; // rough estimate (1 char ≈ 1 byte for ASCII)
    const forceBySize = transcriptBytes >= FORCE_FLUSH_TRANSCRIPT_BYTES;

    const shouldFlush = (currentTokens >= threshold || forceBySize) && lastFlushCompactionCount < compactionCount;

    if (shouldFlush) {
      lastFlushCompactionCount = compactionCount;
      flushPending = true;

      const dateStamp = new Date().toISOString().slice(0, 10);
      api.sendUserMessage(
        `[System] Pre-compaction memory flush. ` +
        `The context window is nearly full. Save any important discoveries, findings, or context ` +
        `from this session to \`memory/${dateStamp}.md\` now. ` +
        `If the file already exists, APPEND new content — do not overwrite existing entries. ` +
        `If there is nothing important to save, reply with exactly: ${SILENT_REPLY_TOKEN}`,
        { deliverAs: "followUp" },
      );
    }

    return undefined;
  });

  if (memoryIndexer) {
    // After each agent turn: sync memory index + handle silent replies
    api.on("agent_end", (event) => {
      flushPending = false;

      // Strip silent reply tokens from agent output
      if (event && Array.isArray((event as any).messages)) {
        for (const msg of (event as any).messages) {
          if (msg?.role === "assistant" && typeof msg.content === "string") {
            const trimmed = msg.content.trim();
            if (trimmed === SILENT_REPLY_TOKEN || trimmed === `${SILENT_REPLY_TOKEN}.`) {
              msg.content = "";
            } else if (trimmed.endsWith(SILENT_REPLY_TOKEN)) {
              msg.content = trimmed.slice(0, -SILENT_REPLY_TOKEN.length).trimEnd();
            }
          }
        }
      }

      memoryIndexer.sync().catch((err) => {
        console.warn(`[memory-flush] Post-turn sync failed:`, err);
      });
      return undefined;
    });
  }

  // Before compaction: inject a flush prompt as last chance
  api.on("session_before_compact", () => {
    const dateStamp = new Date().toISOString().slice(0, 10);

    api.sendUserMessage(
      `[System] Pre-compaction memory flush. ` +
      `Context is about to be compacted. Save any important discoveries, findings, or context ` +
      `from this session to \`memory/${dateStamp}.md\` now. ` +
      `If the file already exists, APPEND new content — do not overwrite existing entries. ` +
      `If there is nothing important to save, reply with exactly: ${SILENT_REPLY_TOKEN}`,
      { deliverAs: "followUp" },
    );

    return undefined;
  });

  // Track compaction events for flush gating
  api.on("session_compact", () => {
    compactionCount++;

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
