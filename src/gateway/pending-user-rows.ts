/**
 * User rows waiting to be told where they belong in the conversation.
 *
 * A user message is written the moment it arrives, so it cannot be lost. But the box
 * consumes it at a turn boundary that may be seconds later, and a user typing faster than
 * the model answers therefore produces a transcript whose write order is not its
 * processing order — every question ahead of every answer, which is what a reload shows.
 *
 * The processing moment IS observable: the box echoes a user `message_start` when it
 * begins consuming one. This holds the row ids between those two moments, in arrival
 * order, because a box consumes injected messages in the order it was given them. The
 * queue is keyed by row id rather than resolved at the far end, so a replayed echo cannot
 * quietly claim the next unsequenced row and shift everything after it.
 *
 * In memory on purpose: losing it costs ordering keys for the turns in flight during a
 * restart, which is exactly the same outcome as the runtime that never had it.
 */

/** Beyond this many unconsumed rows for one session, the oldest are dropped. */
const MAX_PENDING_PER_SESSION = 200;

export class PendingUserRows {
  private bySession = new Map<string, string[]>();

  /** Remember a row that has been written but not yet processed. */
  push(sessionId: string, messageId: string): void {
    const queue = this.bySession.get(sessionId) ?? [];
    queue.push(messageId);
    // A turn that ends with steers still queued leaves them here; bound the damage
    // rather than growing without limit on a session someone hammers.
    if (queue.length > MAX_PENDING_PER_SESSION) queue.splice(0, queue.length - MAX_PENDING_PER_SESSION);
    this.bySession.set(sessionId, queue);
  }

  /** Take the oldest row still waiting, or nothing when the echo belongs to a turn we did not start. */
  claim(sessionId: string): string | undefined {
    const queue = this.bySession.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const id = queue.shift();
    if (queue.length === 0) this.bySession.delete(sessionId);
    return id;
  }

  /**
   * Drop whatever is left for a session.
   *
   * Called when a turn ends: anything still queued was never consumed — a steer the user
   * sent into a turn that finished first — and it must not be claimed by the NEXT turn's
   * first echo, which would give it a place it never occupied.
   */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Rows still waiting for this session. Diagnostics only. */
  size(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0;
  }
}

/** Process-wide. One Runtime, one set. */
export const pendingUserRows = new PendingUserRows();
