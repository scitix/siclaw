/**
 * Gateway internal endpoints for siclaw-native agent-to-agent delegation.
 *
 *   POST /api/internal/delegate   — a coordinator box delegates a bounded task
 *                                    to a peer agent; the gateway prompts the
 *                                    peer (which runs under its OWN capabilities /
 *                                    persona — delegation does not force read-only),
 *                                    drains its event stream, and returns the
 *                                    collected steps + artifact.
 *   GET  /api/internal/delegates  — the coordinator's roster (authorization +
 *                                    manifest), proxied from Portal.
 *
 * Authorization is by mTLS cert identity: the calling box's cert IS the
 * coordinator agent. The gateway re-validates that the requested peer is in the
 * coordinator's roster (defense in depth — never trust the box's own claim).
 *
 * Transport is synchronous-collect (P0): same-Runtime peers reuse the local
 * AgentBox path; cross-Runtime peers are routed through the management plane
 * and their live events are collected over the reverse Runtime event lane.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import type { CertificateIdentity } from "./security/cert-manager.js";
import type { AgentBoxManager } from "./agentbox/manager.js";
import { AgentBoxClient, type AgentBoxTlsOptions } from "./agentbox/client.js";
import { consumeAgentSse } from "./sse-consumer.js";
import { sessionTurnLocks } from "./session-turn-lock.js";
import { ensureChatSession, appendMessage, getMessages, bindMessageTraceId, warnTraceBindFailure, validTraceId } from "./chat-repo.js";
import { resolveAgentModelBinding } from "./agent-model-binding.js";
import { a2aTransportConfig, runA2aDelegation, type A2aTransportConfig } from "./delegate-a2a-transport.js";
import { buildRedactionConfigForModelConfig, redactText } from "./output-redactor.js";
import { parsePositiveIntEnv } from "../core/subagent-registry.js";
import type {
  DelegateRequest, DelegateResponse, DelegateArtifact, DelegatesResponse, DelegateRosterMember, DelegateStep } from "../shared/agent-delegate.js";

/**
 * How many of the coordinator conversation's most-recent delegations to a given
 * peer remain resumable. A follow-up can only continue a session within this
 * window; anything older starts fresh. Bounds "resume a stale session from far
 * back" in a long-running (never-switched) conversation.
 */
const RECENT_DELEGATION_LIMIT = 8;
const DEFAULT_REMOTE_DELEGATION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Recovery reads a GROWING window of the newest rows rather than walking a
 * timestamp cursor. `created_at` has one-second granularity (see migrate.ts —
 * TIMESTAMP(3) is not portable across both engines), so a cursor set to a page's
 * oldest timestamp silently skips every other row written in that same second,
 * which is most of a busy turn. Re-reading a slightly larger window costs one
 * extra query per step and cannot skip anything.
 */
const REMOTE_RESULT_WINDOW_START = 200;
const REMOTE_RESULT_WINDOW_MAX = 20_000;

// Trace ids from another process (the box's prompt ack, a remote terminal event) are
// gated through chat-repo's validTraceId at ingestion: a malformed id from a buggy or
// differently-versioned peer would otherwise be persisted verbatim as the tool row's
// child_trace_id (a link that matches nothing) while the opening-row bind for the same
// value fails on the server's stricter check — a half-written link.

/**
 * The control plane keeps its own relay lease and tears the relay down when it
 * goes idle for longer. Waiting past that point cannot succeed — the events we
 * are waiting for have no route left — so an operator raising the window above it
 * would only convert a clean timeout into a longer one. Clamp instead, loudly.
 */
const MAX_REMOTE_DELEGATION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;


interface DelegationRoute {
  local: boolean;
  sourceRuntimeId: string;
  targetRuntimeId: string;
}

interface DelegationRelayEnvelope {
  delegationId?: string;
  sessionId?: string;
  event?: Record<string, unknown>;
}

/**
 * Delegations whose consumer has already gone away *because it finished*.
 *
 * Reliable control delivery is retried until the source acknowledges it, and the
 * acknowledgement means "this Runtime no longer needs the frame". A terminal that
 * was consumed and then re-delivered (its first ack lost) satisfies that, but a
 * live-consumer-only check would reject it and leave the control plane retrying
 * forever — which keeps its relay alive, and a relay that later expires aborts by
 * (agent, session), killing whatever new turn is reusing that peer session.
 *
 * Bounded and insertion-ordered: only the recent tail can plausibly be re-sent.
 */
const SETTLED_DELEGATION_MEMORY = 512;
const settledDelegations = new Set<string>();



interface DelegationExecutionOutcome {
  error?: string;
  stopped?: boolean;
}

export interface DelegateApiDeps {
  agentBoxManager: AgentBoxManager;
  agentBoxTlsOptions?: AgentBoxTlsOptions;
  frontendClient: FrontendWsClient;
  /**
   * The Runtime's shutdown gate. This endpoint starts AgentBox work of its own, so it
   * has to honour the same admission fence as an ordinary turn: accepting a delegation
   * the process will not be around to supervise leaves the peer running on a box that
   * outlives the Runtime, with a coordinator waiting on a result that never comes.
   *
   * One sample at entry is not enough. Everything between here and the dispatch is
   * awaited — roster, model binding, route, session reuse, persistence, the session
   * lock, and locally a box spawn — so a handler can observe "not shutting down", pause
   * in any of those, and dispatch after shutdown has taken its one look. The gate is
   * therefore re-read immediately before dispatch, and the handler registers a
   * cancellation so a delegation ALREADY dispatched is wound down by that same
   * shutdown rather than outliving it.
   */
  shutdownGate?: {
    isShuttingDown: () => boolean;
    register: (cancel: () => Promise<void> | void) => () => void;
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Fetch a coordinator's roster (peer agents it may delegate to) from Portal. */
async function fetchRoster(
  frontendClient: FrontendWsClient,
  coordinatorAgentId: string,
): Promise<DelegateRosterMember[]> {
  const data = await frontendClient.request("config.getDelegates", { agentId: coordinatorAgentId }) as { members?: DelegateRosterMember[] };
  return data.members ?? [];
}

type DurableRemoteResult =
  | { status: "found"; finalText: string }
  | { status: "empty" }
  | { status: "failed"; error: string };



/**
 * Salvage the trace link from a terminal that arrived AFTER its delegation's
 * live subscriber was gone (coordinator Stop, relay idle-timeout, or a source
 * restart that emptied the settled set): the target kept retrying delivery and
 * the id is right here in-process. Binding the opening user row makes the leg's
 * trace complete, so the leg stays reachable from the tool row's
 * child_session_id even though that row's own child_trace_id was already
 * persisted without it.
 *
 * Best-effort by design: the boundary walk is the shared findTurnBoundary (the
 * current turn's opening row is the durable marker), and the bind RPC is
 * NULL-to-value idempotent, so a re-delivered terminal repeating this is
 * harmless. The memo below keeps a redelivery storm from re-walking the history
 * — terminal retries back off for ~63s per delegation, so one walk per
 * delegation id is all a correct sender ever needs.
 */
const salvagedDelegations = new Set<string>();
const SALVAGED_DELEGATIONS_CAP = 512;

/** GET /api/internal/delegates — the calling coordinator's roster. */
export async function handleDelegates(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const members = await fetchRoster(frontendClient, identity.agentId);
    sendJson(res, 200, { members } satisfies DelegatesResponse);
  } catch (err) {
    console.error("[delegate-api] delegates error:", err);
    sendJson(res, 500, { error: "Failed to resolve delegation roster" });
  }
}

/** POST /api/internal/delegate — run a bounded task on a peer agent (under its own config). */
export async function handleDelegate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  deps: DelegateApiDeps,
): Promise<void> {
  const coordinatorAgentId = identity.agentId;
  let body: DelegateRequest;
  try {
    body = (await readJsonBody(req)) as DelegateRequest;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }
  const peerAgentId = body?.peerAgentId;
  const text = body?.text;
  if (!peerAgentId || !text) {
    sendJson(res, 400, { error: "peerAgentId and text are required" });
    return;
  }

  // Register cancellation before the first asynchronous authorization/config
  // lookup. EventEmitter does not replay `close`, so installing this only at the
  // SSE phase misses a Stop that arrives during those awaits and can dispatch a
  // headless turn after the HTTP consumer has gone away.
  const peerAbort = new AbortController();
  let finished = false;
  let peerClient: AgentBoxClient | undefined;
  // Names the local peer turn so a Stop cannot reach a LATER turn on this reused
  // peer session (delegation reuse is by design — see the session-reuse note above).
  const localTurnId = randomUUID();
  let delegationId = "";
  let peerSessionId = "";
  let remoteStartRequested = false;
  // The peer turn's own root trace id, once the runtime serving it reports one
  // (local: the box's prompt ack; remote: the terminal event). A delegated turn
  // is its OWN trace, so this is what the delegate_result carries back for the
  // coordinator to persist as the cross-trace link — and what the opening user
  // row below is bound to, since that row is appended before the trace exists.
  let peerTraceId: string | undefined;
  // The opening user row's id, kept so peerTraceId can be bound to it later.
  let openingMessageId = "";
  const bindOpeningRowTrace = (traceId: string | undefined) => {
    if (!traceId || !openingMessageId) return;
    // openingMessageId is deliberately NOT cleared here: it is a per-request local
    // (a reused peer session's next turn is a NEW handleDelegate call with its own
    // opening row), and the bind RPC is value-idempotent server-side — so a
    // re-delivered remote terminal retrying the bind is harmless, while clearing
    // before the fire-and-forget settles would let one transient RPC failure
    // permanently strand the opening row at trace_id NULL.
    const messageId = openingMessageId;
    void bindMessageTraceId(messageId, peerSessionId, traceId).catch((err) => {
      warnTraceBindFailure("delegated prompt", peerSessionId, messageId, err);
    });
  };
  /**
   * Wind this delegation down, RETURNING the abort it issues — once.
   *
   * MEMOIZED, because a disconnect and a shutdown are the same wind-down arriving from
   * two directions. A disconnect starts it fire-and-forget and lets the handler settle;
   * a shutdown that follows must be able to wait for that very attempt rather than
   * finding nothing to wait for and exiting underneath it.
   *
   * The attempt RETRIES a refusal rather than resolving on it. Converting a failed abort
   * into a completed wind-down is the same mistake as reporting an unconfirmed Stop as
   * success: for a local peer there is no relay lease to fall back on, and the box
   * outlives the Runtime, so the prompt would simply keep running.
   */
  const CANCEL_ATTEMPTS = 3;
  let cancellation: Promise<void> | undefined;
  const runCancellation = async (): Promise<void> => {
    // Aborting the signal is the whole cancellation now: the transport reacts by
    // sending the task's own `:cancel` to the control plane, which owns the peer
    // turn. The two paths this used to choose between — a `delegation.abort` RPC
    // for a remote leg, a direct AgentBox abort for a local one — existed only
    // because this process was running the peer itself.
    peerAbort.abort();
    if (!peerClient) return; // nothing reached a box
    for (let attempt = 1; attempt <= CANCEL_ATTEMPTS; attempt += 1) {
      try {
        await peerClient.abortSession(peerSessionId, localTurnId);
        return;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (attempt === CANCEL_ATTEMPTS) {
          console.warn(`[delegate-api] could not stop peer session ${peerSessionId} after ${attempt} attempt(s): ${detail}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
  };
  const cancelPeerWork = (): Promise<void> => {
    if (finished) return cancellation ?? Promise.resolve();
    cancellation ??= runCancellation();
    return cancellation;
  };
  const onResponseClose = () => { void cancelPeerWork(); };
  res.on("close", onResponseClose);
  if (res.destroyed) onResponseClose();
  const cancelled = () => peerAbort.signal.aborted || res.destroyed;

  if (deps.shutdownGate?.isShuttingDown()) {
    // Refusing is an answer the coordinator can act on; an unsupervised peer turn is not.
    sendJson(res, 503, { error: "Runtime is shutting down; delegation was not started" });
    return;
  }

  // 1. Authorize: the peer MUST be in this coordinator's roster (config-time
  //    authorization; the box's own claim is never trusted).
  let member: DelegateRosterMember | undefined;
  try {
    const roster = await fetchRoster(deps.frontendClient, coordinatorAgentId);
    member = roster.find((m) => m.id === peerAgentId);
  } catch (err) {
    if (cancelled()) return;
    console.error("[delegate-api] roster lookup failed:", err);
    sendJson(res, 500, { error: "Failed to check delegation authorization" });
    return;
  }
  if (cancelled()) return;
  if (!member) {
    sendJson(res, 403, { error: "peer agent is not in this coordinator's delegation roster" });
    return;
  }

  // 2. Resolve the peer's own model binding (it runs under ITS config, not the coordinator's).
  const binding = await resolveAgentModelBinding(peerAgentId, deps.frontendClient);
  if (cancelled()) return;
  if (!binding || !binding.modelProvider) {
    sendJson(res, 502, { error: `peer agent ${member.name} has no usable model binding` });
    return;
  }

  // ⚠️ NO ROUTE LOOKUP. The control plane derives the peer's Runtime from the
  // peer row inside the roster predicate it already evaluates, so asking for it
  // here would be asking the caller's process to decide something the
  // authorization step has to decide anyway. The incident this lookup was
  // written for — a coordinator Runtime creating a correctly configured peer in
  // the wrong network environment — is now impossible by construction: this
  // process never places a peer at all.
  if (cancelled()) return;

  delegationId = randomUUID();

  // Resolve the peer session id + owner. The peer session is PERSISTED (openable +
  // analyzable) as a child of the coordinator session: agent_id = coordinator (the
  // read-model/URL agent, so the existing parent-link auth in resolveReadableSession
  // applies), target_agent_id = the real executor. The coordinator picks new-vs-reuse
  // by context: passing a prior peerSessionId continues that peer thread (context
  // retained), else a fresh session. Reuse is re-validated to belong to THIS
  // coordinator (parent + target match) — never trust the box's raw id.
  let ownerUserId = coordinatorAgentId; // fallback; parent-link auth still grants the human
  // ⚠️ No on-behalf-of identity is derived here any more. The peer executes as
  // ITS OWN owner, resolved control-plane side from the peer agent's row, so
  // this leg has nobody's authority to lend. `ownerUserId` below is row
  // ownership for the local peer-session record and nothing else.
  peerSessionId = randomUUID();
  // The caller-supplied parent is trusted ONLY once bound to THIS coordinator's mTLS
  // identity. Gates user_id adoption, session reuse, AND parent linkage.
  let parentTrusted = false;
  if (body.parentSessionId) {
    // Parent validation must SUCCEED to proceed. resolveReadableSession later grants
    // the peer session to the parent's OWNER, so linking to an unvalidated parent could
    // expose it to the wrong user. Fail CLOSED on both an identity mismatch AND an RPC
    // error we can't verify through — never continue on an unverified parent.
    let parent: { found?: boolean; user_id?: string; agent_id?: string } | undefined;
    try {
      parent = await deps.frontendClient.request("chat.resolveSession", { session_id: body.parentSessionId }) as typeof parent;
    } catch (err) {
      if (cancelled()) return;
      // Transient: we cannot confirm ownership, so reject rather than risk mis-linking.
      console.error("[delegate-api] parent session validation failed (RPC error):", err);
      sendJson(res, 503, { error: "could not validate parentSessionId; please retry" });
      return;
    }
    if (cancelled()) return;
    // Bind parentSessionId to the caller's cert identity: a parent whose agent_id is
    // not this coordinator means the box is pointing at another agent's session.
    // (Pre-stream: headers not yet sent, plain JSON.)
    if (!parent?.found || parent.agent_id !== coordinatorAgentId) {
      sendJson(res, 403, { error: "parentSessionId does not belong to this coordinator" });
      return;
    }
    if (parent.user_id) {
      ownerUserId = parent.user_id;
    }
    parentTrusted = true;

    // Recency-bounded reuse: only continue a session among this coordinator
    // conversation's RECENT delegations to this peer (ownership + staleness bound).
    // Unlike parent validation, a reuse-lookup failure is NON-fatal — fall back to a
    // fresh session rather than reject the whole delegation.
    if (body.peerSessionId) {
      try {
        const recent = await deps.frontendClient.request("chat.recentDelegationSessions", {
          parent_session_id: body.parentSessionId, target_agent_id: peerAgentId, limit: RECENT_DELEGATION_LIMIT,
        }) as { ids?: string[] };
        if (recent?.ids?.includes(body.peerSessionId)) {
          peerSessionId = body.peerSessionId; // owned by this coordinator chain AND recent → continue it
        } else {
          console.warn(`[delegate-api] peerSessionId ${body.peerSessionId} is not among the coordinator's recent ${RECENT_DELEGATION_LIMIT} delegations to ${peerAgentId}; starting a fresh peer session`);
        }
      } catch (err) {
        console.warn("[delegate-api] recent-delegation lookup failed; using a fresh peer session:", err);
      }
      if (cancelled()) return;
    }
  }

  // Persist the peer session row (idempotent upsert; reuse keeps the same row) so
  // the coordinator can OPEN its full session and it survives for later analysis.
  // Link the parent ONLY when validated — never persist an unverified parent ref
  // (resolveReadableSession would otherwise grant the peer session to its owner).
  const trustedParent = parentTrusted ? body.parentSessionId ?? null : null;
  try {
    await ensureChatSession(
      peerSessionId, coordinatorAgentId, ownerUserId,
      `Delegation → ${member.name}`, text.slice(0, 500), "delegation",
      { parentSessionId: trustedParent, parentAgentId: coordinatorAgentId, delegationId, targetAgentId: peerAgentId },
    );
    // Persist the delegated task as the opening user turn so the opened session
    // reads naturally (and a reuse turn appends its new task). The row is written
    // BEFORE the peer turn exists, so its trace id is bound later (bindOpeningRowTrace)
    // — the same append-then-bind pattern chat.send uses for its prompt row.
    openingMessageId = await appendMessage({ sessionId: peerSessionId, role: "user", content: text, parentSessionId: trustedParent, delegationId, targetAgentId: peerAgentId });
  } catch (err) {
    if (cancelled()) return;
    console.warn("[delegate-api] failed to persist peer session:", err);
    // ⚠️ ALWAYS FATAL NOW. The peer always executes elsewhere — the control
    // plane dispatches it — and it skips initial persistence so this side can
    // preserve coordinator ownership and parent lineage. Without this row every
    // append from the peer's side is rejected, so a turn whose result cannot be
    // durably attached must not be started. This used to be tolerated for a
    // "local" leg, a distinction that no longer exists.
    sendJson(res, 503, { error: "Could not persist the delegated session; delegation was not started" });
    return;
  }
  if (cancelled()) return;

  const steps: DelegateStep[] = [];
  let artifact: DelegateArtifact | null = null;
  let finalText = "";
  // Set when the peer calls request_input (emits an `input_required` event) and ends
  // its turn asking a human clarification. Surfaced as a distinct result status so the
  // coordinator relays the question instead of treating the (often empty) turn as done.
  let inputQuestion = "";
  let remoteErrorMessage = "";

  // Live-relay: from here we stream Server-Sent Events. Each peer chat.event is
  // forwarded verbatim as a `peer_event` frame so the coordinator box can render
  // the peer's steps LIVE; a final `delegate_result` frame carries the outcome.
  // (Pre-stream validation errors above returned plain JSON with a non-200 code;
  //  the box's delegateStream reads those as an error before switching to SSE.)
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const writeFrame = (obj: unknown) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
  };

  const observePeerEvent = (evt: Record<string, unknown>, mirrorToPeerChannel: boolean) => {
    const e = evt as any;
    // Relay the raw peer event live — the coordinator box translates it into
    // the coordinator card's live steps.
    writeFrame({ type: "peer_event", event: evt });
    // Local execution consumes AgentBox SSE directly, so publish a mirror for an
    // opened PeerSessionView. A remote target Runtime already published this
    // exact chat.event to ControlPlane; mirroring again would duplicate the transcript.
    if (mirrorToPeerChannel) {
      try { deps.frontendClient.emitEvent("chat.event", { sessionId: peerSessionId, event: evt }); } catch { /* best-effort live mirror */ }
    }
    if (e?.type === "delegation_artifact") {
      artifact = {
        findings: String(e.findings ?? ""),
        actions_taken: String(e.actions_taken ?? ""),
        residual_state: String(e.residual_state ?? ""),
      };
      return;
    }
    if (e?.type === "input_required") {
      if (typeof e.question === "string" && e.question.trim()) inputQuestion = e.question.trim();
      return;
    }
    if (e?.type === "stream_error") {
      remoteErrorMessage = typeof e.error === "string"
        ? e.error
        : typeof e.error?.message === "string"
          ? e.error.message
          : "delegated peer stream failed";
    }
    const t = String(e?.type ?? "");
    if (t === "tool_execution_end") {
      const label = e.toolName ?? e.tool ?? e.name ?? e.title;
      if (typeof label === "string" && label) {
        // Card-render shape, not a bare name: `kind` is what the card branches on.
        // A peer's spawn_subagent shows up here like any other tool — the sub-agent's
        // OWN execution lives in the peer's session, reachable by opening it.
        steps.push({
          kind: "tool",
          toolName: label,
          ...(typeof e.durationMs === "number" ? { durationMs: e.durationMs } : {}),
        });
      }
    }
    if (t === "message_end" && e.message?.role === "assistant") {
      const parts: Array<{ type?: string; text?: string }> = e.message.content ?? [];
      const txt = parts.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
      if (txt) finalText = finalText ? `${finalText}\n\n${txt}` : txt;
    } else if (typeof e?.text === "string" && e.text.trim()) {
      finalText = finalText ? `${finalText}\n\n${e.text}` : e.text;
    } else if (typeof e?.content === "string" && e.content.trim()) {
      finalText = finalText ? `${finalText}\n\n${e.content}` : e.content;
    }
  };

  // Surface the peer session id immediately (it's known now) so the coordinator's
  // card can offer "open full session" LIVE, before the final result arrives.
  writeFrame({ type: "delegate_session", peerSessionId });


  // The peer task runs as a durable A2A task on the management plane's internal
  // entrance; this bridge translates its frames back into the same
  // observePeerEvent vocabulary, so the coordinator tool experience and the SSE
  // frame protocol are unchanged.
  // The local peer-session row stays the coordinator-side read model; the final
  // answer is mirrored into it at terminal so "open full session" still reads.
  const runA2aTransportDelegation = async (cfg: A2aTransportConfig): Promise<DelegationExecutionOutcome> => {
    const redactionConfig = buildRedactionConfigForModelConfig(binding.modelConfig as never);
    const result = await runA2aDelegation({
      cfg,
      // The control plane checks this against the authenticated Runtime and then
      // decides the roster question itself, which is what moves delegation
      // authorization out of this process.
      coordinatorAgentId,
      peerAgentId,
      text,
      localSessionId: peerSessionId,
      parentSessionId: trustedParent ?? undefined,
      ...(body.evidenceRefs?.length ? { evidenceRefs: body.evidenceRefs } : {}),
      delegationId,
      signal: peerAbort.signal,
      observe: (evt) => observePeerEvent(evt, true),
      redact: (t) => redactText(t, redactionConfig),
    });
    if (result.stopped) return { stopped: true };
    if (result.error) return { error: result.error };
    // Mirror the settled answer into the local read-model row (best-effort —
    // the durable execution transcript lives on the control-plane side).
    if (finalText) {
      try {
        await appendMessage({ sessionId: peerSessionId, role: "assistant", content: finalText });
      } catch (err) {
        console.warn("[delegate-api] could not mirror the A2A answer into the peer session row:", err);
      }
    }
    return {};
  };


  // One turn at a time for this peer session — the AgentBox's 409 only sees its own
  // sessions, so with more than one box two delegations could run on two boxes at once.
  // Acquired INSIDE the try because the SSE response headers are already written.
  let releaseTurn: (() => void) | undefined;
  let unregisterFromShutdown: (() => void) | undefined;
  try {
    // Serialize both local and remote continuation of one peer session. The
    // target Runtime has its own in-flight guard, but the source owns reuse and
    // can reject a duplicate before creating cross-Runtime work.
    releaseTurn = await sessionTurnLocks.acquire(peerSessionId);
    // Register the wind-down HERE, not at the top of the handler: everything from this
    // point is inside the try/finally below, so the hook is released on every exit. An
    // earlier registration leaked one closure per rejected request — authorization,
    // binding, route, parent, persistence — for the lifetime of the Runtime, and
    // shutdown would later invoke stale hooks. Nothing before this point has peer work
    // to wind down anyway; the gate re-read below is what covers that window.
    unregisterFromShutdown = deps.shutdownGate?.register(() => cancelPeerWork());
    // Re-read the gate HERE, not only at entry: this is the last moment before work
    // reaches a box, and everything in between was awaited.
    if (deps.shutdownGate?.isShuttingDown()) {
      finished = true;
      writeFrame({
        type: "delegate_result",
        result: { ok: false, peerAgentId, peerName: member.name, status: "failed", steps, peerSessionId, error: "Runtime is shutting down; delegation was not started" } satisfies DelegateResponse,
      });
      res.end();
      return;
    }
    // Stop may have arrived while waiting behind an earlier turn. Bail before
    // delegation.start so an abort cannot race ahead of a not-yet-started relay.
    if (peerAbort.signal.aborted) {
      finished = true;
      try { res.end(); } catch { /* client already gone */ }
      return;
    }

    // A2A is the only transport. The private relay it replaced — a local
    // AgentBox call plus a cross-Runtime event relay through four
    // `delegation.*` RPCs — is gone: authorization now belongs to the control
    // plane's roster check rather than to this process, and routing to the
    // peer's Runtime is the control plane's job too.
    const outcome = await runA2aTransportDelegation(a2aTransportConfig());
    if (outcome.stopped) {
      finished = true;
      try { res.end(); } catch { /* client already gone */ }
      return;
    }
    if (outcome.error) {
      finished = true;
      console.error(`[delegate-api] delegation to ${peerAgentId} failed: ${outcome.error}`);
      writeFrame({
        type: "delegate_result",
        // peerTraceId rides failure frames too: a failed leg still persisted rows
        // under its trace, and failed legs are exactly what a review drills into.
        result: { ok: false, peerAgentId, peerName: member.name, status: "failed", steps, peerSessionId, peerTraceId, error: outcome.error } satisfies DelegateResponse,
      });
      res.end();
      return;
    }
  } catch (err) {
    // A client-abort cancellation surfaces here as the drain loop breaking; treat
    // it as a clean stop, not a failure the coordinator should see as an error.
    finished = true;
    if (peerAbort.signal.aborted) {
      writeFrame({
        type: "delegate_result",
        result: { ok: false, peerAgentId, peerName: member.name, status: "failed", steps, peerSessionId, peerTraceId, error: "delegation stopped" } satisfies DelegateResponse,
      });
      res.end();
      return;
    }
    console.error(`[delegate-api] delegation to ${peerAgentId} failed:`, err);
    writeFrame({
      type: "delegate_result",
      result: { ok: false, peerAgentId, peerName: member.name, status: "failed", steps, peerSessionId, peerTraceId, error: err instanceof Error ? err.message : String(err) } satisfies DelegateResponse,
    });
    res.end();
    return;
  } finally {
    releaseTurn?.();
    // A disconnect may have started the wind-down and left it pending. Unregistering now
    // would leave a shutdown an instant later with neither the hook nor any tracked work,
    // free to exit while that abort is still on the wire — so the hook outlives the
    // handler until its own cancellation settles.
    const releaseHook = () => { try { unregisterFromShutdown?.(); } catch { /* already gone */ } };
    if (cancellation) void cancellation.finally(releaseHook);
    else releaseHook();
  }

  finished = true;
  // Keep the TAIL of the accumulated narrative so the report + conclusion survive
  // (they come last); drop only very early intermediate reasoning if over budget.
  const MAX_FINAL_TEXT = 12000;
  const finalTextCapped = finalText.length > MAX_FINAL_TEXT ? `…\n${finalText.slice(-MAX_FINAL_TEXT)}` : finalText;
  // The peer asked a human clarification (request_input) and ended its turn — report
  // it as a distinct status so the coordinator relays the question and delivers the
  // answer by continuing THIS peerSessionId, rather than treating an often-empty turn
  // as a finished "done" result.
  if (inputQuestion) {
    writeFrame({
      type: "delegate_result",
      result: {
        ok: true, peerAgentId, peerName: member.name, status: "input_required",
        inputQuestion, steps, finalText: finalTextCapped || undefined, peerSessionId, peerTraceId,
      } satisfies DelegateResponse,
    });
    res.end();
    return;
  }
  writeFrame({
    type: "delegate_result",
    result: {
      ok: true, peerAgentId, peerName: member.name, status: "done", artifact, steps,
      finalText: finalTextCapped || undefined, peerSessionId, peerTraceId,
    } satisfies DelegateResponse,
  });
  res.end();
}
