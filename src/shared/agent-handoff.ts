/**
 * Handoff transfers ownership of one conversation between authorized Agents.
 * The receiver continues the shared history and answers the user directly.
 * The control plane owns authorization and execution state; Runtime emits a
 * handoff_requested event and discovers destinations through the internal API.
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
  /** Legacy full manifest only; absent in the internal index. Configured, not live reachability. */
  clusters?: string[];
  /** Bound host names, same purpose. */
  hosts?: string[];
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

/** Bounded on-demand discovery; no credentials or full inventory in the result. */
export const HANDOFF_SEARCH_PATH = "/api/internal/handoff-targets/search";
export interface HandoffSearchQuery {
  kind: "cluster" | "host" | "capability" | "agent";
  query: string;
  offset?: number;
  limit?: number;
}
export interface HandoffSearchMatch {
  id: string; name: string; routeKey: string; agentType: string; description: string;
  matches: { kind: string; id?: string; name: string; ip?: string }[];
  matchCount: number;
}
export interface HandoffSearchResponse {
  targets: HandoffSearchMatch[];
  total: number;
  nextOffset?: number;
}
