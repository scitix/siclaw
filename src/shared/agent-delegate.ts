/**
 * Wire types for siclaw-native agent-to-agent delegation (caller side).
 *
 * A coordinator AgentBox delegates a bounded read-only task to a PEER agent
 * (its own box, reached via the gateway) and gets a structured artifact back.
 * These types are the box↔gateway contract:
 *   - box → gateway:  POST /api/internal/delegate       (DelegateRequest → DelegateResponse)
 *   - box → gateway:  GET  /api/internal/delegates       (→ DelegatesResponse, the roster)
 *
 * Transport is synchronous-collect for P0: the gateway prompts the peer, drains
 * its event stream, and returns the collected steps + the peer's
 * `delegation_artifact`. Live streaming into the coordinator's card is a later
 * increment on the same shapes.
 */

/** The peer's structured result (mirrors report_findings / delegation_artifact). */
export interface DelegateArtifact {
  findings: string;
  actions_taken: string;
  residual_state: string;
}

/**
 * A span context flattened for the wire.
 *
 * NOT an OTel SpanContext object: this crosses a process boundary and is JSON, so it carries only
 * the two hex ids and the flags byte. The receiving side rebuilds a remote parent from them. Kept
 * deliberately minimal — anything richer would tie the two processes to one tracing SDK version.
 */
export interface WireSpanContext {
  traceId: string;
  spanId: string;
  traceFlags?: number;
}

/** box → gateway: delegate a bounded task to a peer agent. */
export interface DelegateRequest {
  /** Target peer agent id (must be in the coordinator's roster). */
  peerAgentId: string;
  /** The bounded task / question for the peer. */
  text: string;
  /**
   * The coordinator turn's root trace id, so the peer's turn joins the SAME trace instead of
   * starting its own. Without it a delegation is unobservable as one call tree: every coordinator
   * trace sampled showed sessionCount 1, with the peer's work sitting in a separate trace nobody
   * could reach from it.
   *
   * Optional on purpose — absent means "no trace to join", which is the pre-existing behaviour and
   * is what an older caller sends. The peer then generates its own id exactly as before.
   */
  traceId?: string;
  /**
   * The `delegate_to_agent` tool span, when the coordinator could capture it. Makes the peer's root
   * span a CHILD of the tool call rather than a sibling rooted at the same trace — the difference
   * between "these turns are related" and an actual call tree.
   *
   * Independent of `traceId`: the span may be uncapturable (tracing disabled, parent trace already
   * ended) while the trace id is still known and still worth joining.
   */
  parentSpanContext?: WireSpanContext;
  /**
   * The coordinator's tool-call id for this delegation. Correlates the peer's turn with the exact
   * tool row that dispatched it — a coordinator may run several delegations concurrently, and
   * session ids alone cannot say which row is which.
   */
  toolCallId?: string;
  /** Coordinator's session id (metadata / correlation + peer-session lineage/ownership). */
  parentSessionId?: string;
  /**
   * Continue an EXISTING peer session (the id a prior delegation returned) so the
   * peer retains context across turns. Omit to start a fresh peer session. The
   * gateway re-validates the id belongs to this coordinator (parent + target
   * match) before reusing it; an unowned/unknown id falls back to a new session.
   */
  peerSessionId?: string;
}

/** gateway → box: outcome of a delegated task. */
export interface DelegateResponse {
  ok: boolean;
  peerAgentId: string;
  peerName?: string;
  /**
   * "input_required": the peer called `request_input` and ended its turn asking a
   * human clarification (see `inputQuestion`). The coordinator must relay the
   * question to the human and deliver the answer by delegating again with the same
   * `peerSessionId` (the peer resumes from its retained context).
   */
  status: "done" | "failed" | "input_required";
  /** The peer's clarification question when status === "input_required". */
  inputQuestion?: string;
  /** The peer's structured artifact, if it called report_findings. */
  artifact?: DelegateArtifact | null;
  /** Human-meaningful step labels the peer took (for the progress card). */
  steps: string[];
  /** The peer's final assistant narrative (fallback when no artifact). */
  finalText?: string;
  /**
   * The peer session id this delegation ran in (persisted + openable). The
   * coordinator surfaces it on the card (to open the full session) and may pass
   * it back as DelegateRequest.peerSessionId to continue the same peer thread.
   */
  peerSessionId?: string;
  error?: string;
}

/** A peer agent the coordinator may delegate to, with its derived manifest. */
export interface DelegateRosterMember {
  id: string;
  name: string;
  description: string;
  /** Bound cluster names (derived) — helps the coordinator route by resource. */
  clusters: string[];
  /** Bound host names (derived). */
  hosts: string[];
}

/** gateway → box: the coordinator's delegation roster (authorization + manifest). */
export interface DelegatesResponse {
  members: DelegateRosterMember[];
}
