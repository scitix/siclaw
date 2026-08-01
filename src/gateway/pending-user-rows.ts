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

interface PendingRow {
  messageId: string;
  /** What was written, used only to reject an echo that clearly is not this row. */
  text: string;
}

export class PendingUserRows {
  private bySession = new Map<string, PendingRow[]>();

  /**
   * Remember a row the box has ACCEPTED but not yet started processing.
   *
   * Pushed after acceptance, never before: a message still queued behind the turn lock,
   * or one whose delivery failed, has not been handed to any box — leaving it here would
   * let the next echo claim it, giving it a place in the conversation it never occupied
   * and leaving the message actually being answered without one.
   */
  push(sessionId: string, messageId: string, text: string): void {
    const queue = this.bySession.get(sessionId) ?? [];
    queue.push({ messageId, text });
    // A turn that ends with steers still queued leaves them here; bound the damage
    // rather than growing without limit on a session someone hammers.
    if (queue.length > MAX_PENDING_PER_SESSION) queue.splice(0, queue.length - MAX_PENDING_PER_SESSION);
    this.bySession.set(sessionId, queue);
  }

  /**
   * Take the oldest row still waiting, if the echo plausibly belongs to it.
   *
   * The text is a GUARD, not an identity: the box wraps what it was given (a mode preamble
   * is prepended), so this asks whether the echo contains the row's text, and never uses it
   * to search. Without the guard a REPLAYED echo — a routed turn re-runs the prompt on its
   * next candidate, and the replay reaches this consumer — would claim the row behind it,
   * ordering a steer the box has not consumed yet.
   */
  claim(sessionId: string, echoedText?: string): string | undefined {
    const queue = this.bySession.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const head = queue[0];
    if (echoedText !== undefined && head.text.length > 0 && !echoedText.includes(head.text)) return undefined;
    queue.shift();
    if (queue.length === 0) this.bySession.delete(sessionId);
    return head.messageId;
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
