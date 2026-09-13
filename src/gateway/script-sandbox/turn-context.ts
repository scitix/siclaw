/** Current authenticated turns, never reconstructed from persisted session ownership. */
export class SandboxTurnContext {
  private sessions = new Map<string, { blocked: boolean; turns: Map<symbol, { agentId: string; userId: string; web: boolean; current: boolean }> }>();

  enter(sessionId: string, agentId: string, userId: string, origin?: string): () => void {
    const state = this.sessions.get(sessionId) ?? { blocked: false, turns: new Map() };
    const entries = state.turns;
    // A rejected/steered foreign entry must not restore authority to the turn
    // it may already have influenced. Clear only after every live entry ends.
    if (origin !== "web" || [...entries.values()].some(e => e.userId !== userId)) state.blocked = true;
    // A trusted Web handoff replaces the executor while its source may still
    // be releasing the terminal event. Never restore source authority later.
    if ([...entries.values()].some(e => e.current && e.agentId !== agentId)) {
      for (const entry of entries.values()) entry.current = false;
    }
    const key = Symbol();
    entries.set(key, { agentId, userId, web: origin === "web", current: true });
    this.sessions.set(sessionId, state);
    return () => {
      entries.delete(key);
      if (!entries.size && this.sessions.get(sessionId) === state) this.sessions.delete(sessionId);
    };
  }

  user(sessionId: string, agentId: string): string {
    const state = this.sessions.get(sessionId);
    const entries = state?.turns;
    if (state?.blocked || !entries?.size) return "";
    let user = "";
    for (const entry of entries.values()) {
      if (!entry.current) continue;
      if (!entry.web || entry.agentId !== agentId || !entry.userId || (user && entry.userId !== user)) return "";
      user = entry.userId;
    }
    return user;
  }
}
