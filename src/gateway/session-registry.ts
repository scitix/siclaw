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
 *
 * A delegated leg is the one case where the owning agent is NOT the executing
 * one, so the record also carries the session's delegation target — see
 * `SessionRecord.targetAgentId`.
 */

const DEFAULT_CAPACITY = 10_000;

export interface SessionRecord {
  userId: string;
  agentId: string;
  /**
   * For a delegated leg: the agent the session was delegated TO, i.e. the peer
   * whose AgentBox actually runs the turn. The row's `agentId` deliberately stays
   * the delegating coordinator so it keeps ownership of the conversation, which
   * makes this the only field naming the executor. Absent for a top-level session.
   */
  targetAgentId?: string;
  /**
   * True when this record's owner and user were read from the `chat_sessions` row
   * itself rather than assembled by a caller. It certifies THOSE FIELDS, so
   * `remember()` drops it the moment a caller overwrites them. Two separate gates
   * depend on it:
   *
   *  - an ABSENT `targetAgentId` means "this session has no delegation target"
   *    rather than "this entry predates knowing one";
   *  - `agentId` can be trusted to name the session's OWNER. A leg relayed to
   *    another Runtime is cached there under the PEER by `chat.send`, so a
   *    non-authoritative record can name the peer as owner — which an owner-only
   *    gate must not take at face value, or the peer gains the very rewrite
   *    access that gate exists to withhold.
   *
   * The 3-arg `remember()` callers know nothing about delegation fields, and a
   * cache hit never consults the row again, so without this flag both gates would
   * answer from whichever caller happened to populate the entry first.
   */
  authoritative?: boolean;
  lastSeen: number;
}

export type SessionResolver = (
  sessionId: string,
) => Promise<{ userId: string; agentId: string; targetAgentId?: string } | null>;

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

  /**
   * Record that `sessionId` belongs to `userId` on `agentId`. Updates recency.
   * `targetAgentId` is the delegation target when the session is a delegated leg;
   * omitting it PRESERVES an already-cached target rather than clearing it.
   */
  remember(sessionId: string, userId: string, agentId: string, targetAgentId?: string): void {
    if (!sessionId) return;
    const cached = this.map.get(sessionId);
    // A session's delegation target is fixed when its row is created, and the
    // 3-arg callers (chat.send, scheduled tasks, channels) have no reason to know
    // it. Carry a cached target forward instead of letting one of them blank it:
    // dropping it re-closes the ownership gate on the delegated peer's AgentBox
    // until the entry happens to be evicted, which is a silent regression.
    //
    // `||`, not `??`: an empty string is a caller that did not supply a target,
    // not one asking to clear it.
    const target = targetAgentId || cached?.targetAgentId;
    // Provenance certifies THE FIELDS IT WAS READ WITH, so it survives only while
    // those fields do. A caller that leaves owner and user alone cannot unlearn
    // that the row was consulted; one that overwrites them has replaced the very
    // thing the flag vouches for.
    //
    // Carrying it across an owner rewrite is what makes the flag a lie, and the
    // sequence is ordinary rather than adversarial: the resolver caches
    // {coordinator, target: peer, authoritative}, then the Runtime the leg was
    // relayed to handles `chat.send` and calls remember(sid, userId, peer). The
    // entry would then claim the peer as an AUTHORITATIVE owner, which is exactly
    // the assertion `sessionOwnedByIdentity` skips its re-read on — reopening
    // update_message, update_tool_message and channel delivery to the peer without
    // the row ever being asked.
    const identityIntact = cached?.agentId === agentId && cached?.userId === userId;
    this.write(sessionId, {
      userId,
      agentId,
      ...(target ? { targetAgentId: target } : {}),
      ...(cached?.authoritative && identityIntact ? { authoritative: true } : {}),
    });
  }

  /**
   * Cache a record read from the `chat_sessions` row, marked as such so an
   * absent target is answerable from cache instead of triggering another read.
   */
  private rememberFromSource(
    sessionId: string,
    fetched: { userId: string; agentId: string; targetAgentId?: string },
  ): void {
    if (!sessionId) return;
    this.write(sessionId, {
      userId: fetched.userId,
      agentId: fetched.agentId,
      ...(fetched.targetAgentId ? { targetAgentId: fetched.targetAgentId } : {}),
      authoritative: true,
    });
  }

  /** Insert (re-inserting to refresh LRU position) and evict past capacity. */
  private write(sessionId: string, record: Omit<SessionRecord, "lastSeen">): void {
    this.map.delete(sessionId);
    this.map.set(sessionId, { ...record, lastSeen: Date.now() });
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

  /**
   * Drop an entry (e.g. when a session is terminated). Also tombstones any
   * in-flight resolver for the same sid so its eventual response cannot
   * silently re-insert the entry we just invalidated.
   */
  forget(sessionId: string): void {
    this.map.delete(sessionId);
    this.tombstones.add(sessionId);
    this.inflight.delete(sessionId);
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * Sessions invalidated while a resolver call was in flight. The resolver
   * promise must check this set on settle and skip `remember()` — otherwise
   * an explicit `forget()` can be undone by a racing Portal response.
   */
  private tombstones = new Set<string>();

  private async lookup(sessionId: string | undefined): Promise<SessionRecord | undefined> {
    if (!sessionId) return undefined;
    const cached = this.map.get(sessionId);
    if (cached) {
      cached.lastSeen = Date.now();
      return cached;
    }
    return this.resolveAndStore(sessionId);
  }

  /**
   * Read one session from the source of truth and back-fill, IGNORING any cached
   * entry. For a caller holding a record whose provenance cannot answer its
   * question — see internal-api's ownership gates, which can neither distinguish
   * "this leg has no delegation target" from "this entry was cached before the
   * target was known", nor trust a relayed leg's cached `agentId` to name the
   * owner, without asking the row.
   *
   * Deliberately not part of the read path: on a cache hit `get()` must stay
   * local. Callers reach for this only for a record whose `authoritative` is
   * unset, which bounds it to one extra read per session per cache lifetime.
   */
  async refresh(sessionId: string | undefined): Promise<SessionRecord | undefined> {
    if (!sessionId) return undefined;
    return this.resolveAndStore(sessionId);
  }

  /**
   * Consult the resolver for one session and cache the result, coalescing
   * concurrent callers for the same sid into a single RPC — relevant right after
   * a Runtime restart, when a burst of buffered AgentBox callbacks arrives at
   * once and would otherwise fan out N identical reads.
   */
  private async resolveAndStore(sessionId: string): Promise<SessionRecord | undefined> {
    if (!this.resolver) return undefined;

    const inflight = this.inflight.get(sessionId);
    if (inflight) return inflight;

    const resolver = this.resolver;
    // Snapshot any pre-existing tombstone so this read starts fresh; we only
    // honor tombstones created while THIS resolver call is in flight.
    this.tombstones.delete(sessionId);
    const promise = (async () => {
      try {
        const fetched = await resolver(sessionId);
        if (!fetched) return undefined;
        // If forget() raced us while the RPC was outstanding, do NOT re-insert.
        // Awaiters of THIS call still get the fetched record so the in-flight
        // callback can still attribute, but the next miss goes to Portal afresh.
        if (this.tombstones.has(sessionId)) {
          return { ...fetched, authoritative: true, lastSeen: Date.now() };
        }
        this.rememberFromSource(sessionId, fetched);
        return this.map.get(sessionId);
      } finally {
        this.inflight.delete(sessionId);
        this.tombstones.delete(sessionId);
      }
    })();
    this.inflight.set(sessionId, promise);
    return promise;
  }
}

/** Shared singleton for the runtime process. */
export const sessionRegistry = new SessionRegistry();
