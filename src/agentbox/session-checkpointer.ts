/**
 * SessionCheckpointer — durable session-dir snapshots via the Gateway.
 *
 * Replaces the shared RWX PVC for AgentBox `user-data` session state:
 * the session directory lives on local/emptyDir storage and is packed to a
 * tar.gz checkpoint on session release / SIGTERM, then restored (hydrated)
 * by getOrCreate() after a pod restart.
 * Contract: docs/design/2026-06-10-session-checkpoint-db.md.
 *
 * Failure philosophy: checkpointing is a background durability path — it
 * must never block or fail a user's prompt. Hydration degrades to a fresh
 * session (chat history stays DB-backed); upload failures are logged loudly
 * and retried on the next trigger. The one hard stop is a repeated revision
 * conflict, which signals a competing writer (split-brain) — we stop writing
 * for that session instead of fighting over the row.
 */

import {
  packSessionDir,
  extractSessionCheckpoint,
  sessionDirNeedsHydration,
  sha256Hex,
} from "../shared/session-checkpoint.js";

/** Subset of GatewayClient used here — narrow so tests can fake it. */
export interface CheckpointTransport {
  saveSessionCheckpoint(payload: {
    session_id: string;
    revision: number;
    sha256: string;
    size_bytes: number;
    data_base64: string;
  }): Promise<{ ok: boolean; revision?: number; error?: string; latest?: number }>;
  loadSessionCheckpoint(
    sessionId: string,
    opts?: { beforeRevision?: number; metaOnly?: boolean },
  ): Promise<{ found: boolean; revision?: number; sha256?: string; size_bytes?: number; data_base64?: string }>;
}

export type HydrateOutcome = "restored" | "fresh" | "skipped";

/** Integrity-fallback walk depth: latest plus up to 2 older revisions (keep-3 retention). */
const MAX_HYDRATE_ATTEMPTS = 3;

export class SessionCheckpointer {
  private transport: CheckpointTransport;
  /** Last revision known to exist server-side, per session (re-synced lazily). */
  private revisions = new Map<string, number>();
  /** sha256 of the last successful upload — dedups no-op checkpoints. */
  private lastUploadedSha = new Map<string, string>();
  /**
   * Sessions we stopped writing: repeated revision conflict (split-brain
   * signal) or over-cap archives. Cleared only by process restart — both
   * conditions need operator attention, not silent retries.
   */
  private stopped = new Map<string, string>();

  constructor(transport: CheckpointTransport) {
    this.transport = transport;
  }

  /**
   * Restore a session directory from its latest verifiable checkpoint.
   * Never throws: any failure degrades to "fresh" with a loud log — the
   * user's prompt proceeds either way.
   */
  async hydrate(sessionId: string, sessionDir: string): Promise<HydrateOutcome> {
    if (!sessionDirNeedsHydration(sessionDir)) return "skipped";
    try {
      let beforeRevision: number | undefined;
      let latestSeen: number | undefined;
      for (let attempt = 0; attempt < MAX_HYDRATE_ATTEMPTS; attempt++) {
        const result = await this.transport.loadSessionCheckpoint(sessionId, { beforeRevision });
        if (!result.found) break;
        // The first revision we see is the server-side head — later saves
        // must build on it even when we restore an older (intact) revision,
        // otherwise the next save would collide with the corrupt head row.
        latestSeen ??= result.revision;
        const data = Buffer.from(result.data_base64 ?? "", "base64");
        if (!result.sha256 || sha256Hex(data) !== result.sha256) {
          console.warn(
            `[session-checkpoint] sha256 mismatch for ${sessionId} rev ${result.revision}; walking back`,
          );
          beforeRevision = result.revision;
          continue;
        }
        await extractSessionCheckpoint(data, sessionDir);
        this.revisions.set(sessionId, latestSeen ?? result.revision ?? 0);
        this.lastUploadedSha.set(sessionId, result.sha256);
        console.log(
          `[session-checkpoint] restored ${sessionId} from rev ${result.revision} (${result.size_bytes} bytes)`,
        );
        return "restored";
      }
      if (latestSeen !== undefined) {
        // Checkpoints exist but none verified — start fresh above the head.
        this.revisions.set(sessionId, latestSeen);
        console.error(
          `[session-checkpoint] no verifiable checkpoint for ${sessionId} (head rev ${latestSeen}); starting fresh`,
        );
      } else {
        this.revisions.set(sessionId, 0);
      }
      return "fresh";
    } catch (err) {
      console.error(`[session-checkpoint] hydrate failed for ${sessionId}; starting fresh:`, err);
      return "fresh";
    }
  }

  /**
   * Pack and upload the session directory. No-op when content is unchanged
   * since the last upload. Throws transport errors to the caller (which logs
   * and relies on the next trigger); permanently stops on split-brain or
   * over-cap (see `stopped`).
   */
  async checkpoint(sessionId: string, sessionDir: string, reason: string): Promise<void> {
    const stopReason = this.stopped.get(sessionId);
    if (stopReason !== undefined) return;

    let packed;
    try {
      packed = await packSessionDir(sessionDir);
    } catch (err) {
      // Over-cap archives don't shrink on retry — stop re-tarring a huge dir
      // on every release and surface once per process.
      this.stopped.set(sessionId, "over-cap");
      console.error(`[session-checkpoint] stopping checkpoints for ${sessionId}:`, err);
      return;
    }
    if (!packed) return;
    if (this.lastUploadedSha.get(sessionId) === packed.sha256) return;

    let revision = this.revisions.get(sessionId);
    if (revision === undefined) {
      // Long-lived dir without a prior hydrate in this process (local mode,
      // or PVC double-write transition) — re-sync the counter cheaply.
      const head = await this.transport.loadSessionCheckpoint(sessionId, { metaOnly: true });
      revision = head.found ? (head.revision ?? 0) : 0;
    }

    const save = (rev: number) =>
      this.transport.saveSessionCheckpoint({
        session_id: sessionId,
        revision: rev,
        sha256: packed.sha256,
        size_bytes: packed.sizeBytes,
        data_base64: packed.data.toString("base64"),
      });

    let next = revision + 1;
    let result = await save(next);
    if (!result.ok && result.error === "revision_conflict" && typeof result.latest === "number") {
      // A stale counter (e.g. recovered pod) re-syncs once; a real competing
      // writer will conflict again immediately.
      console.warn(
        `[session-checkpoint] revision conflict for ${sessionId} (ours ${next}, server ${result.latest}); re-syncing once`,
      );
      next = result.latest + 1;
      result = await save(next);
    }

    if (result.ok) {
      this.revisions.set(sessionId, next);
      this.lastUploadedSha.set(sessionId, packed.sha256);
      console.log(
        `[session-checkpoint] saved ${sessionId} rev ${next} (${packed.sizeBytes} bytes, ${packed.fileCount} files, trigger=${reason})`,
      );
    } else if (result.error === "revision_conflict") {
      this.stopped.set(sessionId, "revision-conflict");
      console.error(
        `[session-checkpoint] stopping checkpoints for ${sessionId}: repeated revision conflict — ` +
        `a second AgentBox appears to be writing this session (split-brain)`,
      );
    } else {
      throw new Error(`checkpoint.save rejected for ${sessionId}: ${JSON.stringify(result)}`);
    }
  }

  /** Drop in-memory tracking for an explicitly closed session. */
  forget(sessionId: string): void {
    this.revisions.delete(sessionId);
    this.lastUploadedSha.delete(sessionId);
    this.stopped.delete(sessionId);
  }
}
