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
 * Transport is synchronous-collect (P0): reuses the SAME machinery as chat.send
 * (getOrCreate + AgentBoxClient.prompt + consumeAgentSse), entirely within siclaw.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import type { CertificateIdentity } from "./security/cert-manager.js";
import type { AgentBoxManager } from "./agentbox/manager.js";
import { AgentBoxClient, type AgentBoxTlsOptions } from "./agentbox/client.js";
import { consumeAgentSse } from "./sse-consumer.js";
import { ensureChatSession, appendMessage } from "./chat-repo.js";
import { resolveAgentModelBinding } from "./agent-model-binding.js";
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

export interface DelegateApiDeps {
  agentBoxManager: AgentBoxManager;
  agentBoxTlsOptions?: AgentBoxTlsOptions;
  frontendClient: FrontendWsClient;
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

  // 1. Authorize: the peer MUST be in this coordinator's roster (config-time
  //    authorization; the box's own claim is never trusted).
  let member: DelegateRosterMember | undefined;
  try {
    const roster = await fetchRoster(deps.frontendClient, coordinatorAgentId);
    member = roster.find((m) => m.id === peerAgentId);
  } catch (err) {
    console.error("[delegate-api] roster lookup failed:", err);
    sendJson(res, 500, { error: "Failed to check delegation authorization" });
    return;
  }
  if (!member) {
    sendJson(res, 403, { error: "peer agent is not in this coordinator's delegation roster" });
    return;
  }

  // 2. Resolve the peer's own model binding (it runs under ITS config, not the coordinator's).
  const binding = await resolveAgentModelBinding(peerAgentId, deps.frontendClient);
  if (!binding || !binding.modelProvider) {
    sendJson(res, 502, { error: `peer agent ${member.name} has no usable model binding` });
    return;
  }

  const delegationId = randomUUID();

  // Resolve the peer session id + owner. The peer session is PERSISTED (openable +
  // analyzable) as a child of the coordinator session: agent_id = coordinator (the
  // read-model/URL agent, so the existing parent-link auth in resolveReadableSession
  // applies), target_agent_id = the real executor. The coordinator picks new-vs-reuse
  // by context: passing a prior peerSessionId continues that peer thread (context
  // retained), else a fresh session. Reuse is re-validated to belong to THIS
  // coordinator (parent + target match) — never trust the box's raw id.
  let ownerUserId = coordinatorAgentId; // fallback; parent-link auth still grants the human
  let peerSessionId: string = randomUUID();
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
      // Transient: we cannot confirm ownership, so reject rather than risk mis-linking.
      console.error("[delegate-api] parent session validation failed (RPC error):", err);
      sendJson(res, 503, { error: "could not validate parentSessionId; please retry" });
      return;
    }
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
    // reads naturally (and a reuse turn appends its new task).
    await appendMessage({ sessionId: peerSessionId, role: "user", content: text, parentSessionId: trustedParent, delegationId, targetAgentId: peerAgentId });
  } catch (err) {
    console.warn("[delegate-api] failed to persist peer session:", err);
  }

  const steps: string[] = [];
  let artifact: DelegateArtifact | null = null;
  let finalText = "";
  // Set when the peer calls request_input (emits an `input_required` event) and ends
  // its turn asking a human clarification. Surfaced as a distinct result status so the
  // coordinator relays the question instead of treating the (often empty) turn as done.
  let inputQuestion = "";

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

  // Propagate Stop: when the coordinator aborts, its delegateStream destroys the
  // HTTP request → this response's socket closes. Break the drain loop AND cancel
  // the peer's own turn (otherwise the peer keeps running headless).
  const peerAbort = new AbortController();
  let finished = false;
  let peerClient: AgentBoxClient | undefined;
  res.on("close", () => {
    if (finished) return; // normal completion, not a client abort
    peerAbort.abort();
    // Abort by peerSessionId — known BEFORE the prompt round-trip and equal to the
    // box session id we prompt with. Using the post-prompt `promptResult.sessionId`
    // left a gap: a Stop during getOrCreate (pod spawn, 10-30s) + the prompt HTTP
    // round-trip found it still undefined, so the peer turn ran headless to
    // completion (wasted model quota + box CPU, result discarded). Once peerClient
    // exists the prompt has been dispatched, so aborting by peerSessionId reaches it.
    if (peerClient) {
      peerClient.abortSession(peerSessionId).catch((err) => {
        console.warn(`[delegate-api] failed to abort peer session ${peerSessionId}:`, err);
      });
    }
  });

  // Surface the peer session id immediately (it's known now) so the coordinator's
  // card can offer "open full session" LIVE, before the final result arrives.
  writeFrame({ type: "delegate_session", peerSessionId });

  try {
    const handle = await deps.agentBoxManager.getOrCreate(peerAgentId);
    const client = new AgentBoxClient(handle.endpoint, 30000, deps.agentBoxTlsOptions);
    peerClient = client;
    // Cancellation during cold spawn: if the coordinator disconnected while
    // getOrCreate was still spawning the peer pod, the close handler fired with
    // peerClient still undefined (nothing to abort yet) and the peer turn has NOT
    // started. Bail BEFORE prompt() so we never dispatch a turn that would then run
    // headless with no consumer.
    if (peerAbort.signal.aborted) {
      finished = true;
      try { res.end(); } catch { /* client already gone */ }
      return;
    }
    const promptResult = await client.prompt({
      sessionId: peerSessionId,
      userId: ownerUserId,
      text,
      agentId: peerAgentId,
      modelProvider: binding.modelProvider,
      modelId: binding.modelId,
      modelConfig: binding.modelConfig,
      modelRouting: binding.modelRouting,
      systemPromptTemplate: binding.systemPrompt ?? undefined,
      origin: "api",
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

    const consumption = await consumeAgentSse({
      client,
      sessionId: promptResult.sessionId,
      userId: ownerUserId,
      // Stop propagation: break the drain loop the moment the coordinator aborts.
      signal: peerAbort.signal,
      // Persist the peer session's rows so the coordinator can open its full
      // session and it survives for later analysis.
      persistMessages: true,
      onEvent: (evt: Record<string, unknown>) => {
        const e = evt as any;
        // Relay the raw peer event live — the coordinator box translates it into
        // the coordinator card's live steps.
        writeFrame({ type: "peer_event", event: evt });
        // Also publish to the peer session's OWN live channel so an opened
        // PeerSessionView (subscribed to …/sessions/{peerSessionId}/events)
        // streams the peer's full session live (mirrors delegation.emit_chat_event).
        try { deps.frontendClient.emitEvent("chat.event", { sessionId: peerSessionId, event: evt }); } catch { /* best-effort live mirror */ }
        if (e?.type === "delegation_artifact") {
          artifact = {
            findings: String(e.findings ?? ""),
            actions_taken: String(e.actions_taken ?? ""),
            residual_state: String(e.residual_state ?? ""),
          };
          return;
        }
        if (e?.type === "input_required") {
          // The peer asked a human clarification and will end its turn. Capture the
          // question; the final result surfaces it as status "input_required".
          if (typeof e.question === "string" && e.question.trim()) inputQuestion = e.question.trim();
          return;
        }
        // Count tool steps for the final summary; capture the narrative fallback.
        // Count ONCE per tool call — on `tool_execution_end` only. Matching every
        // event whose type contains "tool" (start + update + end) inflated the
        // count 2-3× per call (a "4 tool calls" run reported as 12).
        const t = String(e?.type ?? "");
        if (t === "tool_execution_end") {
          const label = e.toolName ?? e.tool ?? e.name ?? e.title;
          if (typeof label === "string" && label) steps.push(label);
        }
        // An AUTONOMOUS peer ends with a normal assistant message (no report_findings).
        // ACCUMULATE its assistant narrative — a peer often ends with a big report
        // message followed by a short closing remark ("以上就是结论…"). Taking only the
        // LAST message would hand the coordinator just that closing line, which reads
        // as a truncated/empty result. Joining preserves the actual report; the tail
        // is kept at result time so the conclusion always survives the cap.
        if (t === "message_end" && e.message?.role === "assistant") {
          const parts: Array<{ type?: string; text?: string }> = e.message.content ?? [];
          const txt = parts.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
          if (txt) finalText = finalText ? `${finalText}\n\n${txt}` : txt;
        } else if (typeof e?.text === "string" && e.text.trim()) {
          finalText = finalText ? `${finalText}\n\n${e.text}` : e.text;
        } else if (typeof e?.content === "string" && e.content.trim()) {
          finalText = finalText ? `${finalText}\n\n${e.content}` : e.content;
        }
      },
    });

    // consumeAgentSse reports MODEL-level failures (provider 4xx/5xx, rate-limit,
    // routing exhaustion) via `errorMessage` WITHOUT throwing. Without this check
    // the endpoint below would emit ok:true/"done" for a turn the peer never
    // actually completed — a false-success delegation the coordinator relays as a
    // real answer. Surface it as a failed result instead.
    if (consumption.errorMessage) {
      finished = true;
      console.error(`[delegate-api] delegation to ${peerAgentId} failed (model error): ${consumption.errorMessage}`);
      writeFrame({
        type: "delegate_result",
        result: { ok: false, peerAgentId, peerName: member.name, status: "failed", steps, peerSessionId, error: consumption.errorMessage } satisfies DelegateResponse,
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
