/**
 * Which box serves which session.
 *
 * An agent may run several AgentBox pods. A session's state — its brain, tool set, MCP
 * connections, SSE replay buffer, and above all its background jobs — lives in ONE of
 * them, in memory. `job_stop`'s abort handle is a closure over a running child process:
 * a live async operation, not serialisable state. So a session cannot be moved while it
 * is being served, and this table exists to make sure it never is.
 *
 * The rules, in the order they matter:
 *
 *  1. **Round-robin places, affinity keeps.** RR chooses a box for a session that has
 *     none. It is never re-applied per request — a second turn landing elsewhere would
 *     find none of the first turn's state.
 *
 *  2. **A binding survives as long as its box does.** Raising the replica count relieves
 *     FUTURE sessions; it never migrates existing ones.
 *
 *  3. **One re-binding is legal**: a session that the box has released, when its box is
 *     gone or draining. A released session holds no in-flight turn and no background
 *     work, so moving it costs warm state and nothing else. Without this, a box could
 *     never actually be drained and a scale-up would never rebalance anything.
 *
 * Deliberately pure and in-memory: no clock, no I/O, no K8s. The Runtime is a single
 * replica and therefore the sole writer, so this needs no lease and no coordination —
 * and rebuilding it from the pod list after a restart is correct, because a binding to a
 * box that no longer exists is exactly what rule 3 discards.
 */

/** A box that can currently accept work, as observed this round. */
export interface BoxCandidate {
  boxId: string;
  /** False while the box is being drained for removal or a new image. */
  accepting: boolean;
  /** Turns currently running on the box — the placement score. */
  turnsInFlight: number;
}

export interface PlacementResult {
  boxId: string;
  /** True when this call changed the binding (new session, or a legal re-bind). */
  bound: boolean;
}

export class BoxBindings {
  /** agentId → sessionId → boxId. */
  private byAgent = new Map<string, Map<string, string>>();
  /** agentId → rotor position, so RR does not restart at 0 on every call. */
  private rotor = new Map<string, number>();

  /** The box currently serving a session, if any. */
  get(agentId: string, sessionId: string): string | undefined {
    return this.byAgent.get(agentId)?.get(sessionId);
  }

  /** Sessions bound to a given box. */
  sessionsOn(agentId: string, boxId: string): string[] {
    const map = this.byAgent.get(agentId);
    if (!map) return [];
    return [...map].filter(([, b]) => b === boxId).map(([s]) => s);
  }

  /** How many sessions each box of an agent currently holds. */
  countsByBox(agentId: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const boxId of this.byAgent.get(agentId)?.values() ?? []) {
      counts.set(boxId, (counts.get(boxId) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Decide which box serves `sessionId`, binding it if it has none.
   *
   * `residentSessionIds` is what the boxes report they are actually holding. A session
   * that is bound but NOT resident has been released from box memory, which is the only
   * state in which it may be moved.
   *
   * Returns undefined when no box can take it — the caller has to spawn one rather than
   * pick a draining box and lose the work a moment later.
   */
  place(
    agentId: string,
    sessionId: string,
    candidates: BoxCandidate[],
    residentSessionIds: ReadonlySet<string>,
  ): PlacementResult | undefined {
    const current = this.get(agentId, sessionId);
    if (current !== undefined) {
      const box = candidates.find((c) => c.boxId === current);
      // Rule 2: keep it where it is, even on a box that has stopped accepting NEW
      // sessions — draining means "no new work", not "abandon what you are holding".
      if (box) return { boxId: current, bound: false };
      // Its box is gone. Rule 3 permits a move only if the session is not resident
      // anywhere — but a box that vanished is holding nothing, so this is always legal.
      this.unbind(agentId, sessionId);
    } else if (residentSessionIds.has(sessionId)) {
      // Resident somewhere without a binding: the Runtime restarted and lost the table.
      // Adopting the observation beats placing it somewhere it has no state.
      return undefined;
    }

    const chosen = this.pickRoundRobin(agentId, candidates);
    if (!chosen) return undefined;
    this.bind(agentId, sessionId, chosen);
    return { boxId: chosen, bound: true };
  }

  /**
   * Move sessions off a box that is draining, where that is legal.
   *
   * Only sessions the box has RELEASED are moved; anything still resident stays until the
   * box reports it gone. Returns the sessions actually re-bound.
   */
  rebalanceOff(
    agentId: string,
    drainingBoxId: string,
    candidates: BoxCandidate[],
    residentSessionIds: ReadonlySet<string>,
  ): string[] {
    const moved: string[] = [];
    for (const sessionId of this.sessionsOn(agentId, drainingBoxId)) {
      if (residentSessionIds.has(sessionId)) continue; // still in memory → not movable
      const chosen = this.pickRoundRobin(agentId, candidates.filter((c) => c.boxId !== drainingBoxId));
      if (!chosen) break; // nowhere to go; leave the binding alone
      this.bind(agentId, sessionId, chosen);
      moved.push(sessionId);
    }
    return moved;
  }

  /** Drop bindings to boxes that no longer exist. Safe to run every reconciliation round. */
  retainBoxes(agentId: string, liveBoxIds: ReadonlySet<string>): void {
    const map = this.byAgent.get(agentId);
    if (!map) return;
    for (const [sessionId, boxId] of [...map]) {
      if (!liveBoxIds.has(boxId)) map.delete(sessionId);
    }
    if (map.size === 0) this.byAgent.delete(agentId);
  }

  /** Adopt an observed binding — used to rebuild the table from what boxes report. */
  bind(agentId: string, sessionId: string, boxId: string): void {
    let map = this.byAgent.get(agentId);
    if (!map) {
      map = new Map();
      this.byAgent.set(agentId, map);
    }
    map.set(sessionId, boxId);
  }

  unbind(agentId: string, sessionId: string): void {
    const map = this.byAgent.get(agentId);
    if (!map) return;
    map.delete(sessionId);
    if (map.size === 0) this.byAgent.delete(agentId);
  }

  /** Forget an agent entirely (its boxes are all gone). */
  forget(agentId: string): void {
    this.byAgent.delete(agentId);
    this.rotor.delete(agentId);
  }

  /**
   * Next accepting box, rotating, with ties broken by fewest in-flight turns.
   *
   * Rotation rather than pure least-loaded because in-flight turns is a sample: a burst
   * of placements between two observations would otherwise all pile onto whichever box
   * happened to read as idle.
   */
  private pickRoundRobin(agentId: string, candidates: BoxCandidate[]): string | undefined {
    const open = candidates.filter((c) => c.accepting);
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
