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

/** box → gateway: delegate a bounded task to a peer agent. */
export interface DelegateRequest {
  /** Target peer agent id (must be in the coordinator's roster). */
  peerAgentId: string;
  /** The bounded task / question for the peer. */
  text: string;
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
