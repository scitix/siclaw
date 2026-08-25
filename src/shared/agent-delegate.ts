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
  /**
   * SUBMITTED by the peer, never inferred here. An artifact proves the peer REPORTED; it does not
   * prove it FINISHED, and only the peer knows which. Optional on the wire so an older peer's
   * artifact still parses — absent is read as `partial`, the cautious direction.
   */
  task_status?: "complete" | "partial";
}

/** Result-side contract generation. Integer ≥ 1; see the delegation contract §8. */
export const DELEGATION_RESULT_SCHEMA_VERSION = 1;

/** Whether this turn ENDED normally — transport state, independent of what the work achieved. */
export type DelegateTurnStatus = "completed" | "failed" | "interrupted";

/** What the WORK achieved. `unknown` is a normal, common outcome, not an anomaly. */
export type DelegateTaskStatus = "complete" | "partial" | "blocked" | "unknown";

/** What shape the result carries — orthogonal to whether the task finished. */
export type DelegatePayloadKind = "artifact" | "narrative" | "none";

/**
 * Reported ONLY when something was cut, and at the TOP LEVEL rather than inside the field it
 * describes: a per-field marker would have to edit the very text whose integrity is in question,
 * and a reader could not tell a real count from one the peer wrote itself.
 */
export interface DelegateTruncation {
  original_bytes: number;
  omitted_bytes: number;
  /** Fields cut, in the order the algorithm reached them. */
  fields: string[];
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
  /**
   * The contract generation, TOP LEVEL beside `status`. A producer that speaks v1 speaks it
   * ALWAYS — falling back to the old shape for an awkward turn would make this field unreliable
   * as the branch key, which is the one property a reader depends on.
   *
   * Optional in the TYPE only so an older producer's payload still satisfies it. A reader accepts
   * it as a contract only when it is an integer ≥ 1, and treats anything else exactly as absent.
   */
  schema_version?: number;
  /**
   * Did the turn END normally? Transport state, and it is deliberately independent of what the
   * work achieved: `completed` + `task_status: "unknown"` is the plan-only turn — common, and
   * neither a success nor a failure.
   */
  turn_status?: DelegateTurnStatus;
  /**
   * What the WORK achieved. Submitted by `report_findings`, never inferred from the presence of an
   * artifact. `unknown` means no protocol tool was called, so completeness is genuinely unknown.
   */
  task_status?: DelegateTaskStatus;
  /** What the payload IS, orthogonal to whether the task finished. */
  payload_kind?: DelegatePayloadKind;
  /**
   * NEW in v1 — it does not exist on the pre-v1 wire, which carries only `inputQuestion`. Derived
   * from `task_status === "blocked"` so the two cannot disagree.
   */
  next_action?: "ask_user";
  /** Present only when the budget cut something. See the contract §8a. */
  truncation?: DelegateTruncation;
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
