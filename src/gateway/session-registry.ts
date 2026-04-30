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
 * The map is an in-process LRU cache. On miss, an injected resolver (Portal
 * RPC) is consulted so attribution survives Runtime restarts: the
 * `chat_sessions` row is the source of truth, and the registry merely
 * accelerates lookup.
 */

const DEFAULT_CAPACITY = 10_000;

export interface SessionRecord {
  userId: string;
  agentId: string;
  lastSeen: number;
}

export type SessionResolver = (
  sessionId: string,
) => Promise<{ userId: string; agentId: string } | null>;

export class SessionRegistry {
  private map = new Map<string, SessionRecord>();
  private resolver?: SessionResolver;
  /**
   * In-flight resolver promises keyed by sessionId. Coalesces concurrent
   * cache misses for the same sid into one upstream RPC — relevant right
   * after a Runtime restart, when many buffered AgentBox callbacks can
   * arrive simultaneously and would otherwise fan out N identical RPCs.
   */
  private inflight = new Map<string, Promise<SessionRecord | undefined>>();

  constructor(private readonly capacity = DEFAULT_CAPACITY) {}

  /** Inject a fallback resolver (e.g. Portal RPC). Pass `undefined` to clear. */
  setResolver(resolver: SessionResolver | undefined): void {
    this.resolver = resolver;
  }

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

  /**
   * Resolve `sessionId` to a userId. On cache miss, calls the injected
   * resolver and back-fills. Returns empty string when unknown.
   */
  async resolveUser(sessionId: string | undefined): Promise<string> {
    const rec = await this.lookup(sessionId);
    return rec ? rec.userId : "";
  }

  /**
   * Full record lookup. On cache miss, calls the injected resolver and
   * back-fills. Returns `undefined` when unknown.
   */
  async get(sessionId: string | undefined): Promise<SessionRecord | undefined> {
    return this.lookup(sessionId);
  }

  /** Cache-only peek; no fallback. Useful in tests and tight sync paths. */
  peek(sessionId: string | undefined): SessionRecord | undefined {
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

  private async lookup(sessionId: string | undefined): Promise<SessionRecord | undefined> {
    if (!sessionId) return undefined;
    const cached = this.map.get(sessionId);
    if (cached) {
      cached.lastSeen = Date.now();
      return cached;
    }
    if (!this.resolver) return undefined;

    // Single-flight: piggyback on any in-flight resolver call for this sid.
    const inflight = this.inflight.get(sessionId);
    if (inflight) return inflight;

    const resolver = this.resolver;
    const promise = (async () => {
      try {
        const fetched = await resolver(sessionId);
        if (!fetched) return undefined;
        this.remember(sessionId, fetched.userId, fetched.agentId);
        return this.map.get(sessionId);
      } finally {
        this.inflight.delete(sessionId);
      }
    })();
    this.inflight.set(sessionId, promise);
    return promise;
  }
}

/** Shared singleton for the runtime process. */
export const sessionRegistry = new SessionRegistry();
