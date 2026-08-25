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
import { ensureChatSession, appendMessage, bindMessageTraceId, getMessages } from "./chat-repo.js";
import { resolveAgentModelBinding } from "./agent-model-binding.js";
import { parsePositiveIntEnv } from "../core/subagent-registry.js";
import type {
  DelegateRequest, DelegateResponse, DelegateArtifact, DelegatesResponse, DelegateRosterMember,
} from "../shared/agent-delegate.js";

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

/**
 * The control plane keeps its own relay lease and tears the relay down when it
 * goes idle for longer. Waiting past that point cannot succeed — the events we
 * are waiting for have no route left — so an operator raising the window above it
 * would only convert a clean timeout into a longer one. Clamp instead, loudly.
 */
const MAX_REMOTE_DELEGATION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Maximum silence between matching remote relay events. The environment value
 * is in seconds so operators can extend deep diagnostic turns without allowing
 * a disconnected relay to wait forever.
 */
export function getRemoteDelegationIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = parsePositiveIntEnv(
    env.SICLAW_REMOTE_DELEGATION_IDLE_TIMEOUT,
    DEFAULT_REMOTE_DELEGATION_IDLE_TIMEOUT_MS,
    { unitMs: true },
  );
  if (configured <= MAX_REMOTE_DELEGATION_IDLE_TIMEOUT_MS) return configured;
  console.warn(
    `[delegate-api] SICLAW_REMOTE_DELEGATION_IDLE_TIMEOUT=${configured}ms exceeds the control plane's relay lease; clamping to ${MAX_REMOTE_DELEGATION_IDLE_TIMEOUT_MS}ms`,
  );
  return MAX_REMOTE_DELEGATION_IDLE_TIMEOUT_MS;
}

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

function markDelegationSettled(delegationId: string): void {
  if (!delegationId) return;
  settledDelegations.delete(delegationId);
  settledDelegations.add(delegationId);
  while (settledDelegations.size > SETTLED_DELEGATION_MEMORY) {
    const oldest = settledDelegations.values().next().value as string | undefined;
    if (oldest === undefined) break;
    settledDelegations.delete(oldest);
  }
}

/** Whether a control frame for this delegation was already consumed to completion. */
export function isDelegationSettled(delegationId: string): boolean {
  return settledDelegations.has(delegationId);
}

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
 * Read the authoritative remote answer after the terminal event. Live relay
 * frames are best-effort progress signals and may be dropped individually; the
 * current delegated user row is the durable boundary marker. The session lock
 * guarantees that later rows up to prompt_done belong to this turn even when a
 * peer session is reused.
 */
async function recoverRemoteResult(
  peerSessionId: string,
  delegationId: string,
): Promise<DurableRemoteResult> {
  // Widen the window until this turn's opening row is inside it. A fixed window
  // would make recovery a function of how chatty the turn was: tool rows are
  // messages too, so one tool-heavy investigation can bury its own opening row and
  // have its finished answer reported as unrecoverable.
  let turnMessages: Awaited<ReturnType<typeof getMessages>> = [];
  let boundaryFound = false;
  for (let limit = REMOTE_RESULT_WINDOW_START; !boundaryFound; limit *= 2) {
    let window: Awaited<ReturnType<typeof getMessages>>;
    try {
      window = await getMessages(peerSessionId, { limit });
    } catch (err) {
      console.warn(`[delegate-api] failed to recover remote delegation ${delegationId} from chat history:`, err);
      return { status: "failed", error: "Remote delegation completed, but its result could not be recovered" };
    }

    let boundary = -1;
    for (let i = window.length - 1; i >= 0; i -= 1) {
      if (window[i].role === "user" && window[i].delegationId === delegationId) {
        boundary = i;
        break;
      }
    }
    if (boundary >= 0) {
      turnMessages = window.slice(boundary + 1);
      boundaryFound = true;
      break;
    }
    // A window that came back short IS the whole session: widening cannot reveal
    // a boundary row that is not there.
    if (window.length < limit || limit >= REMOTE_RESULT_WINDOW_MAX) break;
    // Doubling blindly would overshoot the stated ceiling on the last step
    // (12800 → 25600); land exactly on it instead.
    limit = Math.min(limit, REMOTE_RESULT_WINDOW_MAX / 2);
  }
  if (!boundaryFound) {
    return { status: "failed", error: "Remote delegation completed, but its durable turn boundary was not found" };
  }

  const persistedError = [...turnMessages].reverse().find((message) =>
    message.role === "assistant" &&
    message.metadata?.kind === "error_response" &&
    message.content.trim().length > 0,
  );
  if (persistedError) return { status: "failed", error: persistedError.content.trim() };

  const assistantText = turnMessages
    .filter((message) =>
      message.role === "assistant" &&
      message.metadata?.kind !== "error_response" &&
      message.content.trim().length > 0,
    )
    .map((message) => message.content.trim())
    .join("\n\n");
  if (assistantText) return { status: "found", finalText: assistantText };

  return { status: "empty" };
}

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
  let route: DelegationRoute | undefined;
  let delegationId = "";
  let peerSessionId = "";
  let remoteStartRequested = false;
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
    peerAbort.abort();
    const remote = route && !route.local && remoteStartRequested && delegationId;
    if (!remote && !peerClient) return; // nothing reached a box
    for (let attempt = 1; attempt <= CANCEL_ATTEMPTS; attempt += 1) {
      try {
        if (remote) await deps.frontendClient.request("delegation.abort", { delegationId }, 10_000);
        else await peerClient!.abortSession(peerSessionId, localTurnId);
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

  // Direct chat already routes agent_id → runtime_id in ControlPlane. Delegation must
  // make the same placement decision before touching the local AgentBoxManager;
  // otherwise a coordinator Runtime can create a correctly configured peer in
  // the wrong network environment. Fail closed if the control plane cannot
  // prove the route — a local fallback would recreate the incident.
  try {
    route = await deps.frontendClient.request("delegation.resolveRoute", {
      coordinatorAgentId,
      peerAgentId,
    }) as DelegationRoute;
    if (
      typeof route?.local !== "boolean" ||
      !route.sourceRuntimeId ||
      !route.targetRuntimeId ||
      route.local !== (route.sourceRuntimeId === route.targetRuntimeId)
    ) {
      throw new Error("invalid delegation route response");
    }
  } catch (err) {
    if (cancelled()) return;
    console.error("[delegate-api] delegation route lookup failed:", err);
    sendJson(res, 503, { error: "Could not resolve the peer Runtime; delegation was not started" });
    return;
  }
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
    if (parent.user_id) ownerUserId = parent.user_id;
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
  /** The delegated opening user row, bound to a trace id once the peer's box reports one. */
  let delegatedUserMessageId: string | undefined;
  try {
    await ensureChatSession(
      peerSessionId, coordinatorAgentId, ownerUserId,
      `Delegation → ${member.name}`, text.slice(0, 500), "delegation",
      { parentSessionId: trustedParent, parentAgentId: coordinatorAgentId, delegationId, targetAgentId: peerAgentId },
    );
    // Persist the delegated task as the opening user turn so the opened session
    // reads naturally (and a reuse turn appends its new task).
    //
    // The id is KEPT so the row can be bound to a trace id once one is known. It cannot be stamped
    // here: this runs before dispatch, and the authoritative id is the one the peer's box actually
    // used. Every other prompt entry point (web, channels) already does this backfill; delegation
    // was the one that did not, which is why a delegated turn's rows never joined the coordinator's
    // trace in the DB even after the span context started propagating.
    delegatedUserMessageId = await appendMessage({
      sessionId: peerSessionId, role: "user", content: text,
      parentSessionId: trustedParent, delegationId, targetAgentId: peerAgentId,
      // The coordinator tool call that commissioned this session. This is where the tool-row
      // correlation is actually MADE — the join is a DB join, so the id has to be on a row, and
      // this side already holds it. Concurrent delegations make session lineage insufficient on
      // its own: several peer sessions can share one parent turn, and only this says which
      // `delegate_to_agent` row each answers.
      ...(body.toolCallId ? { metadata: { delegation_tool_call_id: body.toolCallId } } : {}),
    });
  } catch (err) {
    if (cancelled()) return;
    console.warn("[delegate-api] failed to persist peer session:", err);
    // The target Runtime deliberately skips initial persistence so the source
    // can preserve coordinator ownership and parent lineage. Without this row,
    // every target-side append would be rejected; do not start a remote turn
    // whose result cannot be durably attached to the delegated session.
    if (!route.local) {
      sendJson(res, 503, { error: "Could not persist the delegated session; delegation was not started" });
      return;
    }
  }
  if (cancelled()) return;

  const steps: string[] = [];
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
      if (typeof label === "string" && label) steps.push(label);
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

  const runRemoteDelegation = async (): Promise<DelegationExecutionOutcome> => {
    let resolveRemoteDone: (() => void) | undefined;
    let rejectRemoteDone: ((err: Error) => void) | undefined;
    const remoteDone = new Promise<void>((resolve, reject) => {
      resolveRemoteDone = resolve;
      rejectRemoteDone = reject;
    });
    // Cancellation can reject this while we are still awaiting delegation.start, which
    // is before anything awaits remoteDone — an unhandled rejection that takes the
    // process's exit code with it. Marking it handled here changes nothing about the
    // await below, which still observes the rejection.
    void remoteDone.catch(() => {});

    const idleTimeoutMs = getRemoteDelegationIdleTimeoutMs();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdleWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => rejectRemoteDone?.(new Error("remote delegation relay timed out")),
        idleTimeoutMs,
      );
      idleTimer.unref?.();
    };
    armIdleWatchdog();

    const onAbort = () => rejectRemoteDone?.(new Error("delegation stopped"));
    peerAbort.signal.addEventListener("abort", onAbort, { once: true });
    const unsubscribe = deps.frontendClient.subscribe("delegation.event", (data) => {
      const envelope = data as DelegationRelayEnvelope;
      if (envelope?.delegationId !== delegationId || envelope.sessionId !== peerSessionId || !envelope.event) return false;
      armIdleWatchdog();
      observePeerEvent(envelope.event, false);
      const type = String((envelope.event as any)?.type ?? "");
      if (type === "prompt_done" || type === "done") {
        if ((envelope.event as any).aborted === true) {
          const reason = typeof (envelope.event as any).reason === "string"
            ? (envelope.event as any).reason.trim()
            : "";
          remoteErrorMessage = reason
            ? `Remote delegation was interrupted: ${reason}`
            : "Remote delegation was interrupted";
        }
        resolveRemoteDone?.();
      }
      return true;
    });

    try {
      remoteStartRequested = true;
      await deps.frontendClient.request("delegation.start", {
        delegationId,
        coordinatorAgentId,
        peerAgentId,
        sessionId: peerSessionId,
        prompt: {
          sessionId: peerSessionId,
          userId: ownerUserId,
          // The source declares the persistence contract; the management
          // plane reasserts it at the trust boundary before chat.send.
          skipInitialPersistence: true,
          text,
          agentId: peerAgentId,
          modelProvider: binding.modelProvider,
          modelId: binding.modelId,
          modelConfig: binding.modelConfig,
          modelRouting: binding.modelRouting,
          systemPrompt: binding.systemPrompt ?? undefined,
          origin: "api",
          // TOP LEVEL, not nested under `delegation` — the management plane's router RECONSTRUCTS
          // prompt.delegation, so a field placed inside it is dropped in transit. Absent means
          // "no trace to join", which is what an older caller sends and what the peer already
          // handles by generating its own id.
          traceId: body.traceId,
          parentSpanContext: body.parentSpanContext,
          delegationToolCallId: body.toolCallId,
          delegation: {
            delegationId,
            parentSessionId: body.parentSessionId,
            parentAgentId: coordinatorAgentId,
            readOnly: false,
          },
        },
      });
      // Cross-Runtime: the target persists its own turn rows, so all this side can bind is the
      // opening user row it wrote itself — and the only id available is the one we SENT, since no
      // prompt ack comes back through this path. That is the right id anyway: the peer adopts it,
      // so both ends land in the coordinator's trace. If the target is old enough not to adopt it,
      // its rows carry a different id and the delegation is ungroupable — the same shortfall as
      // before this change, not a new one.
      if (delegatedUserMessageId && body.traceId) {
        void bindMessageTraceId(delegatedUserMessageId, peerSessionId, body.traceId).catch((bindErr) => {
          console.warn("[delegate-api] failed to bind trace id to the delegated user row:", bindErr);
        });
      }
      if (peerAbort.signal.aborted) {
        await deps.frontendClient.request("delegation.abort", { delegationId }, 10_000).catch(() => {});
        throw new Error("delegation stopped");
      }
      await remoteDone;
    } catch (err) {
      // A source-side timeout/disconnect must not leave the target turn running
      // headless. Abort is idempotent; the router reports alreadyFinished when
      // prompt_done won the race.
      if (remoteStartRequested) {
        await deps.frontendClient.request("delegation.abort", { delegationId }, 10_000).catch(() => {});
      }
      throw err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      peerAbort.signal.removeEventListener("abort", onAbort);
      unsubscribe();
      // From here a re-delivered control frame has no live consumer, and that is
      // the expected steady state rather than a delivery failure.
      markDelegationSettled(delegationId);
    }

    if (remoteErrorMessage) return { error: remoteErrorMessage };
    const recovered = await recoverRemoteResult(peerSessionId, delegationId);
    if (recovered.status === "failed") return { error: recovered.error };
    // Never return text reassembled from a best-effort relay: one dropped frame
    // can leave a non-empty but silently truncated answer. Artifact-only and
    // input-required turns may legitimately have no persisted assistant text.
    finalText = recovered.status === "found" ? recovered.finalText : "";
    if (recovered.status === "empty" && !artifact && !inputQuestion) {
      return { error: "Remote delegation completed without a recoverable result" };
    }
    return {};
  };

  const runLocalDelegation = async (): Promise<DelegationExecutionOutcome> => {
    const handle = await deps.agentBoxManager.getOrCreate(peerAgentId, undefined, peerSessionId);
    sessionTurnLocks.noteBox(peerSessionId, handle.boxId, handle.endpoint);
    const client = new AgentBoxClient(handle.endpoint, 30000, deps.agentBoxTlsOptions);
    peerClient = client;
    // Cancellation during cold spawn: if the coordinator disconnected while
    // getOrCreate was still spawning the peer pod, the close handler fired with
    // peerClient still undefined (nothing to abort yet) and the peer turn has NOT
    // started. Bail BEFORE prompt() so we never dispatch a turn that would then run
    // headless with no consumer.
    if (peerAbort.signal.aborted) return { stopped: true };

    const promptResult = await client.prompt({
      sessionId: peerSessionId,
      turnId: localTurnId,
      userId: ownerUserId,
      text,
      agentId: peerAgentId,
      modelProvider: binding.modelProvider,
      modelId: binding.modelId,
      modelConfig: binding.modelConfig,
      modelRouting: binding.modelRouting,
      systemPromptTemplate: binding.systemPrompt ?? undefined,
      origin: "api",
      // Same fields as the remote path, and top-level for the same reason — a peer reached
      // in-process must land in the coordinator's trace exactly as a remote one does, or the
      // call tree depends on where the box happens to be scheduled.
      traceId: body.traceId,
      parentSpanContext: body.parentSpanContext,
      delegationToolCallId: body.toolCallId,
      delegation: {
        delegationId,
        parentSessionId: body.parentSessionId,
        parentAgentId: coordinatorAgentId,
        // The coordinator does NOT constrain the peer: a delegated agent runs
        // under ITS OWN configuration (capabilities, persona, model) — the two
        // agents manage their own permissions independently. The marker exists
        // for the result-artifact contract, anti-recursion, and audit, not to
        // downgrade the peer. (An explicit read-only delegation tier is a future
        // opt-in; it is not imposed here.)
        readOnly: false,
      },
    });

    // The box's own answer for this turn's root trace id — the id it ADOPTED from body.traceId, or
    // one it generated when none was supplied or tracing could not attach. Prefer it over what we
    // sent: it is what the peer's spans actually carry, so using it keeps rows and spans agreeing
    // even against a box that did not adopt.
    const peerTraceId = promptResult.traceId ?? body.traceId;
    if (delegatedUserMessageId) {
      void bindMessageTraceId(delegatedUserMessageId, promptResult.sessionId, peerTraceId).catch((bindErr) => {
        console.warn("[delegate-api] failed to bind trace id to the delegated user row:", bindErr);
      });
    }

    const consumption = await consumeAgentSse({
      client,
      sessionId: promptResult.sessionId,
      userId: ownerUserId,
      // Stop propagation: break the drain loop the moment the coordinator aborts.
      signal: peerAbort.signal,
      // Persist the peer session's rows so the coordinator can open its full
      // session and it survives for later analysis.
      persistMessages: true,
      // Without this every persisted peer row lands with trace_id NULL, and the delegation is
      // ungroupable in the DB no matter how well the span context propagates. Spans and rows are
      // SEPARATE mechanisms: the acceptance metrics for delegation (parent/child linkage, whether a
      // specialist re-resolves identity) are answered from rows, not from spans.
      traceId: peerTraceId,
      onEvent: (evt: Record<string, unknown>) => observePeerEvent(evt, true),
    });

    // consumeAgentSse reports MODEL-level failures without throwing. Surface
    // those as failed delegation results rather than false ok:true completions.
    return consumption.errorMessage ? { error: consumption.errorMessage } : {};
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

    const outcome = route.local
      ? await runLocalDelegation()
      : await runRemoteDelegation();
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
        result: { ok: false, peerAgentId, peerName: member.name, status: "failed", steps, peerSessionId, error: outcome.error } satisfies DelegateResponse,
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
        result: { ok: false, peerAgentId, peerName: member.name, status: "failed", steps, peerSessionId, error: "delegation stopped" } satisfies DelegateResponse,
      });
      res.end();
      return;
    }
    console.error(`[delegate-api] delegation to ${peerAgentId} failed:`, err);
    writeFrame({
      type: "delegate_result",
      result: { ok: false, peerAgentId, peerName: member.name, status: "failed", steps, peerSessionId, error: err instanceof Error ? err.message : String(err) } satisfies DelegateResponse,
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
        inputQuestion, steps, finalText: finalTextCapped || undefined, peerSessionId,
      } satisfies DelegateResponse,
    });
    res.end();
    return;
  }
  writeFrame({
    type: "delegate_result",
    result: {
      ok: true, peerAgentId, peerName: member.name, status: "done", artifact, steps,
      finalText: finalTextCapped || undefined, peerSessionId,
    } satisfies DelegateResponse,
  });
  res.end();
}
