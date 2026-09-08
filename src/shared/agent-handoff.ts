/**
 * Wire types for a HANDOFF — one agent passing ownership of a conversation to
 * another, with the user seeing one agent throughout.
 *
 * Not delegation. Delegation is a call: the coordinator asks a peer, gets an
 * artifact back, and keeps the turn (`agent-delegate.ts`). A handoff is a
 * TRANSFER: the receiving agent owns the session from that point on, answers the
 * user directly, and the sender is gone from the conversation until someone
 * hands it back. There is no card, no artifact, and nothing to restate.
 *
 * Why it exists: one Agent per network region (a region's cluster APIs, host
 * SSH, internal MCP and model endpoints are reachable only from a box sitting
 * inside it), but ONE agent as far as the user is concerned. The facade takes
 * the first turn and transfers to whichever region owns the target resource.
 *
 * The box↔gateway contract is one call:
 *   - box → gateway: GET /api/internal/handoff-targets  (→ HandoffTargetsResponse)
 *
 * The transfer itself is NOT an HTTP call. The tool emits a `handoff_requested`
 * control event and ends the turn; the control plane validates the target
 * against the facade's roster, flips the session's executing agent, and
 * re-dispatches the brief to it on the SAME response stream. The runtime never
 * writes that state itself — one writer, and it is the one that can authorize.
 */

/** Where a handoff-target list is fetched from (mTLS internal API). */
export const HANDOFF_TARGETS_PATH = "/api/internal/handoff-targets";

/**
 * The `routeKey` a hand-BACK to the facade always uses. The facade is not one of
 * its own backends, so it has no roster row and no route_key of its own; the
 * control plane recognises the hand-back by the target ID, and this constant is
 * only what the tool calls that choice.
 */
export const FACADE_ROUTE_KEY = "facade";

/** One agent this agent may hand the conversation to. */
export interface HandoffTarget {
  id: string;
  name: string;
  /**
   * Stable short key naming this route (`cn`, `intl`, …), unique per facade.
   * It is what the model picks, so it must read as a PLACE or a DOMAIN rather
   * than as an agent instance — the model is choosing where the work happens,
   * not who it delegates to.
   */
  routeKey: string;
  description: string;
  /** Optional for rolling upgrades. Missing type must not imply unrestricted Custom. */
  agentType?: string;
  /** Same semantics as config.getAgentInfo; null explicitly selects Custom defaults. */
  toolCapabilities?: string[] | null;
  /** Configured bindings, not a live tool-health or network reachability guarantee. */
  skills?: string[];
  knowledgeBases?: string[];
  mcpServers?: string[];
  /** False means coverage/binding lookup failed; empty lists must not imply no resources. */
  resourcesResolved?: boolean;
  /** True for the facade itself — the hand-back, always `routeKey: "facade"`. */
  isFacade: boolean;
  /** Bound cluster names: WHICH resources this target can actually reach. */
  clusters: string[];
  /** Bound host names, same purpose. */
  hosts: string[];
}

/** gateway → box: who this agent may hand off to. */
export interface HandoffTargetsResponse {
  /**
   * The facade at the head of this roster — the agent the user thinks they are
   * talking to. Empty when this agent is in no roster at all (an ordinary agent,
   * which then gets no transfer tool).
   */
  facadeAgentId: string;
  targets: HandoffTarget[];
}

/**
 * The event a transfer tool emits. It travels the ws CONTROL lane (the control plane's
 * `controlEventTypes`), not the best-effort event lane: a dropped
 * `handoff_requested` would leave the turn ended with nobody picking the
 * conversation up, which the user would read as the agent going silent.
 */
export interface HandoffRequestedEvent extends Record<string, unknown> {
  type: "handoff_requested";
  traceContext?: import("./handoff-trace.js").HandoffTraceContext;
  targetAgentId: string;
  newEvidence?: string;
  /** What the receiving agent is being asked to do, in the sender's words. */
  brief: string;
}

/** Control-plane-owned, per-request policy; never supplied by a model or channel payload. */
export interface HandoffPolicy {
  remaining: number;
  visitedAgentIds: string[];
  history: { from: string; to: string; brief: string; newEvidence?: string }[];
}

export function parseHandoffPolicy(value: unknown): HandoffPolicy | undefined {
  if (value === undefined) return undefined;
  const p = value as HandoffPolicy;
  if (!p || !Number.isInteger(p.remaining) || p.remaining < 0 || p.remaining > 2
    || !Array.isArray(p.visitedAgentIds) || p.visitedAgentIds.length > 3 || !p.visitedAgentIds.every(v => typeof v === "string")
    || !Array.isArray(p.history) || p.history.length > 2
    || !p.history.every(s => s && typeof s.from === "string" && typeof s.to === "string" && typeof s.brief === "string" && (s.newEvidence === undefined || typeof s.newEvidence === "string"))) {
    throw new Error("Invalid conversation handoff policy");
  }
  return { remaining: p.remaining, visitedAgentIds: [...p.visitedAgentIds], history: p.history.map(s => ({ ...s })) };
}

export function handoffRefusal(policy: HandoffPolicy | undefined, targetId: string, evidence: string): string | undefined {
  if (!policy) return undefined;
  const finish = "Continue the user's request yourself. Explain verified findings, unresolved limits and the specific information or access needed. Do not delegate the main request to bypass this restriction.";
  if (policy.remaining === 0) return `No further transfers are available for this request. ${finish}`;
  if (policy.visitedAgentIds.at(-1) === targetId) return `You already own this conversation. ${finish}`;
  if (!policy.visitedAgentIds.includes(targetId)) return undefined;
  const normalize = (s: string) => s.toLowerCase().trim().replace(/\s+/gu, " ");
  const normalized = normalize(evidence);
  if (!normalized || policy.history.some(s => normalized === normalize(s.newEvidence ?? "") || normalized === normalize(s.brief))) {
    return `That agent already participated in this request. A return requires new verified evidence and why it enables that agent to proceed; repeating the request is not progress. If no such evidence exists, ${finish}`;
  }
  return undefined;
}
