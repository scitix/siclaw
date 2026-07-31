/**
 * Where a session's next turn should run.
 *
 * A session is NOT owned by a box. The only thing that pins it is live work: while a box
 * is running its turn or still has background sub-agents for it, that box holds the
 * session's in-memory conversation and is the one appending to its transcript, so the
 * next request has to go there. The boxes report this themselves — a session stays
 * resident while background work defers its release — so the answer is observed, never
 * remembered.
 *
 * With no live work, the session is free. It goes wherever the load says, which is what
 * lets a scale-up actually relieve existing conversations rather than only new ones.
 *
 * The last box is kept only as a PREFERENCE. Returning to it skips rebuilding the tool
 * environment — MCP connections are re-initialised on a cold session, and the debug-pod
 * cache is keyed per box, so a follow-up about the same node pays a pod cold start
 * elsewhere. It is a latency win, never a correctness rule: losing the whole hint map
 * changes nothing but speed.
 *
 * Correctness against two concurrent turns is NOT this module's job — that is the
 * Runtime's per-session turn lock (session-turn-lock.ts). This module only decides where
 * a turn that is allowed to start should go.
 */

/** A box that can currently accept work, as observed this round. */
export interface BoxCandidate {
  boxId: string;
  /** False while the box is being drained for removal or a new image. */
  accepting: boolean;
  /** Turns currently running on the box — the placement score. */
  turnsInFlight: number;
}

/** Cap on remembered per-session hints for one agent. */
const MAX_HINTS_PER_AGENT = 5_000;

export interface PlacementResult {
  boxId: string;
  /** True when the session moved to a different box than last time. */
  bound: boolean;
}

export class BoxBindings {
  /** agentId → sessionId → last box that served it. A hint; safe to lose entirely. */
  private lastBox = new Map<string, Map<string, string>>();
  /** agentId → rotor position, so round-robin does not restart at 0 on every call. */
  private rotor = new Map<string, number>();

  /** The box that last served a session, if this Runtime still remembers. */
  get(agentId: string, sessionId: string): string | undefined {
    return this.lastBox.get(agentId)?.get(sessionId);
  }

  /**
   * Decide where this session's next turn runs.
   *
   * `holder` is the box currently reported to be holding the session — a turn in flight or
   * background sub-agents still running under it. When set, that is the answer: the
   * conversation is in that box's memory and it is the one writing the transcript.
   *
   * Otherwise the session is free. The last box wins only if it is still accepting and no
   * more loaded than the least-loaded one, so a preference never keeps a session on a box
   * that has become the busy one.
   *
   * Returns undefined when nothing can take it — the caller must spawn rather than hand
   * the turn to a box that is about to be removed.
   */
  place(
    agentId: string,
    sessionId: string,
    candidates: BoxCandidate[],
    holder: string | undefined,
  ): PlacementResult | undefined {
    if (holder && candidates.some((c) => c.boxId === holder)) {
      this.remember(agentId, sessionId, holder);
      return { boxId: holder, bound: false };
    }

    const open = candidates.filter((c) => c.accepting);
    if (open.length === 0) return undefined;

    const previous = this.get(agentId, sessionId);
    const prev = previous ? open.find((c) => c.boxId === previous) : undefined;
    if (prev) {
      const lightest = Math.min(...open.map((c) => c.turnsInFlight));
      if (prev.turnsInFlight <= lightest) {
        this.remember(agentId, sessionId, prev.boxId);
        return { boxId: prev.boxId, bound: false };
      }
    }

    const chosen = this.pickRoundRobin(agentId, open);
    if (!chosen) return undefined;
    this.remember(agentId, sessionId, chosen);
    return { boxId: chosen, bound: previous !== chosen };
  }

  /** Record which box served a session, for the next turn's preference. */
  remember(agentId: string, sessionId: string, boxId: string): void {
    let map = this.lastBox.get(agentId);
    if (!map) {
      map = new Map();
      this.lastBox.set(agentId, map);
    }
    map.set(sessionId, boxId);
    // The hint is per-session and unbounded otherwise; a busy agent would accumulate one
    // entry per session forever. Losing an old hint costs a cold tool environment once.
    if (map.size > MAX_HINTS_PER_AGENT) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  forget(agentId: string, sessionId: string): void {
    const map = this.lastBox.get(agentId);
    if (!map) return;
    map.delete(sessionId);
    if (map.size === 0) this.lastBox.delete(agentId);
  }

  /** Drop hints pointing at boxes that no longer exist. */
  retainBoxes(agentId: string, liveBoxIds: ReadonlySet<string>): void {
    const map = this.lastBox.get(agentId);
    if (!map) return;
    for (const [sessionId, boxId] of [...map]) {
      if (!liveBoxIds.has(boxId)) map.delete(sessionId);
    }
    if (map.size === 0) this.lastBox.delete(agentId);
  }

  /** Forget an agent entirely (its boxes are all gone). */
  forgetAgent(agentId: string): void {
    this.lastBox.delete(agentId);
    this.rotor.delete(agentId);
  }

  /**
   * Next box, rotating, with the least-loaded winning.
   *
   * In-flight turns is the primary criterion; rotation only breaks ties. That matters
   * because the count is a sample taken up to a couple of seconds ago — with every box
   * reading equal (all idle, the common case) pure least-loaded would put a whole burst
   * onto whichever box was listed first.
   */
  private pickRoundRobin(agentId: string, open: BoxCandidate[]): string | undefined {
    if (open.length === 0) return undefined;
    const start = (this.rotor.get(agentId) ?? 0) % open.length;
    const rotated = [...open.slice(start), ...open.slice(0, start)];
    this.rotor.set(agentId, (start + 1) % open.length);

    let best = rotated[0];
    for (const c of rotated) {
      if (c.turnsInFlight < best.turnsInFlight) best = c;
    }
    return best.boxId;
  }
}
