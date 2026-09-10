/** Current authenticated turns, never reconstructed from persisted session ownership. */
export class SandboxTurnContext {
  private sessions = new Map<string, { blocked: boolean; turns: Map<symbol, { agentId: string; userId: string; web: boolean }> }>();

  enter(sessionId: string, agentId: string, userId: string, origin?: string, delegated = false): () => void {
    const state = this.sessions.get(sessionId) ?? { blocked: false, turns: new Map() };
    const entries = state.turns;
    // A rejected/steered foreign entry must not restore authority to the turn
    // it may already have influenced. Clear only after every live entry ends.
    if (delegated || origin !== "web" || [...entries.values()].some(e => e.agentId !== agentId || e.userId !== userId)) state.blocked = true;
    const key = Symbol();
    entries.set(key, { agentId, userId, web: !delegated && origin === "web" });
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
      if (!entry.web || entry.agentId !== agentId || !entry.userId || (user && entry.userId !== user)) return "";
      user = entry.userId;
    }
    return user;
  }
}
