/**
 * Session Registry — maps `sessionId` to the user who owns the session.
 *
 * AgentBox is user-unaware (see docs/superpowers/specs/2026-04-18-agentbox-
 * agent-scoped-identity-design.md). User attribution for outbound Upstream
 * audit is recovered at the Runtime boundary via this registry:
 *
 *  - Channel / web / task entry points call `rememberSession(sessionId, userId)`
 *    after ensuring a chat session with Upstream.
 *  - AgentBox → Runtime internal-api callbacks carry `sessionId` in the body.
 *    Handlers call `resolveUser(sessionId)` before forwarding to Upstream.
 *
 * This is an in-process LRU. Entries are lost on runtime restart; downstream
 * Upstream calls that land after a restart attribute to an empty user_id until
 * the next chat message re-populates the mapping. Cross-runtime consistency
 * is not required — each runtime serves its own agent pods.
 */

const DEFAULT_CAPACITY = 10_000;

export interface SessionRecord {
  userId: string;
  agentId: string;
  lastSeen: number;
}

export class SessionRegistry {
  private map = new Map<string, SessionRecord>();

  constructor(private readonly capacity = DEFAULT_CAPACITY) {}

  /** Record that `sessionId` belongs to `userId` on `agentId`. Updates recency. */
  remember(sessionId: string, userId: string, agentId: string): void {
    if (!sessionId) return;
    // Re-insert to refresh LRU position.
    this.map.delete(sessionId);
    this.map.set(sessionId, { userId, agentId, lastSeen: Date.now() });
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest) this.map.delete(oldest);
    }
  }

  /** Resolve `sessionId` to a userId. Returns empty string when unknown. */
  resolveUser(sessionId: string | undefined): string {
    if (!sessionId) return "";
    const rec = this.map.get(sessionId);
    if (!rec) return "";
    rec.lastSeen = Date.now();
    return rec.userId;
  }

  /** Full record lookup. Returns `undefined` when unknown. */
  get(sessionId: string | undefined): SessionRecord | undefined {
    if (!sessionId) return undefined;
    return this.map.get(sessionId);
  }

  /** Drop an entry (e.g. when a session is terminated). */
  forget(sessionId: string): void {
    this.map.delete(sessionId);
  }

  get size(): number {
    return this.map.size;
  }
}

/** Shared singleton for the runtime process. */
export const sessionRegistry = new SessionRegistry();
