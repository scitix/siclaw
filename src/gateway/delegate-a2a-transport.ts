/**
 * Experimental A2A transport for delegation (default OFF).
 *
 * When SICLAW_DELEGATION_TRANSPORT=a2a, delegate_to_agent stops using the
 * private start/event/control relay and instead submits the peer task to the
 * management plane's inner A2A profile — the same durable Task/Segment core
 * that serves external callers. The model-side tool experience is unchanged:
 * this module translates A2A frames back into the peer-event shapes the
 * coordinator side already consumes.
 *
 * What the caller keeps owning: the local peer-session row (ownership,
 * lineage, reuse policy). What moves to the control plane: task state,
 * waiting/resume, budgets, retries. During the dual-stack period the A2A
 * Task/Segment is the source of truth for EXECUTION state; the local row is a
 * read-model projection.
 *
 * Continuation mapping is process-local: localPeerSessionId → { contextId,
 * waitingTaskId }. A restart drops it, so before opening a brand-new task the
 * transport asks the control plane whether this context already has a PARKED
 * task to adopt (see recoverParkedTask) — the durable side is authoritative,
 * and the in-process map is only a cache of it.
 *
 * Idempotency: every message carries a STABLE messageId derived from the
 * logical answer it delivers, so a retried attempt is recognised as the same
 * message rather than creating a duplicate task or a duplicate resume.
 */
import { createHash } from "node:crypto";

export interface A2aTransportConfig {
  baseUrl: string; // e.g. https://<internal-a2a-service>:<port>
  token: string; // workload bearer credential
}

/** Media type for the structured context part carried alongside the task text. */
const CONTEXT_MEDIA_TYPE = "application/vnd.siclaw.context+json";

/**
 * Reads the feature flag; undefined = legacy transport.
 *
 * THROWS rather than downgrading when the flag is on but the endpoint is
 * unusable. A silent fallback here was the worst possible outcome: the operator
 * who set the flag believes delegations are running on the durable A2A path —
 * with its task state, budgets and retries — while they are quietly still on
 * the legacy relay. A loud failure at startup/dispatch is recoverable; a
 * mistaken belief about which transport is in use is not.
 */
export function a2aTransportConfig(env: NodeJS.ProcessEnv = process.env): A2aTransportConfig | undefined {
  if (env.SICLAW_DELEGATION_TRANSPORT !== "a2a") return undefined;
  const baseUrl = env.SICLAW_INNER_A2A_URL?.replace(/\/$/, "");
  const token = env.SICLAW_INNER_A2A_TOKEN;
  if (!baseUrl || !token) {
    throw new Error(
      "SICLAW_DELEGATION_TRANSPORT=a2a requires both SICLAW_INNER_A2A_URL and SICLAW_INNER_A2A_TOKEN. " +
      "Refusing to fall back to the legacy transport silently: set both, or unset " +
      "SICLAW_DELEGATION_TRANSPORT to use the legacy transport deliberately.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`SICLAW_INNER_A2A_URL is not a valid URL: ${baseUrl}`);
  }
  // A long-lived workload bearer token over plaintext HTTP is a credential
  // anyone on the path can lift and replay. Refused by default; the escape hatch
  // exists for a local/in-cluster loopback where TLS is genuinely absent, and it
  // announces itself every time so it cannot become the accidental norm.
  if (parsed.protocol !== "https:") {
    if (env.SICLAW_INNER_A2A_ALLOW_PLAINTEXT !== "1") {
      throw new Error(
        `SICLAW_INNER_A2A_URL must use https: (got ${parsed.protocol}). A long-lived bearer token over ` +
        "plaintext can be captured and replayed. Set SICLAW_INNER_A2A_ALLOW_PLAINTEXT=1 to accept that " +
        "risk deliberately (e.g. a loopback address).",
      );
    }
    console.warn(
      `[delegate-a2a] SICLAW_INNER_A2A_URL is plaintext (${parsed.protocol}//${parsed.host}) and ` +
      "SICLAW_INNER_A2A_ALLOW_PLAINTEXT=1 is set: the workload bearer token is sent unencrypted.",
    );
  }
  return { baseUrl, token };
}

interface ThreadState {
  contextId: string;
  waitingTaskId?: string;
}

// localPeerSessionId → remote thread. Bounded: delegation reuse is already
// recency-bounded upstream, so a small LRU-ish cap is plenty.
const threads = new Map<string, ThreadState>();
const THREADS_MAX = 500;

function rememberThread(localSessionId: string, state: ThreadState): void {
  if (threads.size >= THREADS_MAX && !threads.has(localSessionId)) {
    const oldest = threads.keys().next().value;
    if (oldest !== undefined) threads.delete(oldest);
  }
  threads.set(localSessionId, state);
}

/** Test hook. */
export function __resetA2aThreads(): void {
  threads.clear();
}

/**
 * A messageId that is the SAME for every attempt at delivering the same logical
 * message, and different for any other.
 *
 * The previous code sent `randomUUID()` on each attempt, which meant the
 * idempotency key existed but could never match: replay protection was
 * structurally dead, and a retried resume could deliver the same answer twice.
 * Deriving it from the delegation, the target task and the text makes a retry
 * indistinguishable from the original — which is exactly what the control
 * plane's de-duplication needs.
 */
export function stableMessageId(parts: Array<string | undefined>): string {
  return createHash("sha256").update(parts.map((p) => p ?? "").join(":"), "utf8").digest("hex");
}

export interface A2aDelegationArgs {
  cfg: A2aTransportConfig;
  peerAgentId: string;
  text: string;
  /** The local peer-session row id — the continuation key. */
  localSessionId: string;
  parentSessionId?: string;
  parentTurnId?: string;
  delegationId: string;
  /**
   * The HUMAN this delegated work is being done for — the delegating turn's own
   * userId. Sent as trusted metadata so the peer side can authorize, audit and
   * apply no-self-approval against the ORIGINATING user instead of collapsing
   * every delegated call onto the workload's service identity.
   *
   * NEVER fabricated: when the originating user is unknown the field is omitted
   * entirely, because a plausible-looking placeholder would be worse than an
   * absent value — it would attribute actions to someone who did not ask for
   * them, and satisfy a check that was meant to fail.
   */
  onBehalfOfUserId?: string;
  /**
   * References to the evidence behind the delegated task (ids/URIs), carried as
   * a structured data part. References only — never inlined file bytes.
   */
  evidenceRefs?: string[];
  signal: AbortSignal;
  /**
   * Receives fabricated chat.event-shaped peer events (tool_execution_end /
   * input_required / stream_error / message_end) — the exact vocabulary the
   * delegation observer already understands.
   */
  observe: (evt: Record<string, unknown>) => void;
  /** Applied to any model-visible text crossing back to the coordinator. */
  redact?: (text: string) => string;
}

export interface A2aDelegationOutcome {
  error?: string;
  stopped?: boolean;
  /** The remote task id (correlation; carried for diagnostics). */
  taskId?: string;
  /** The control-plane runtime session actually executing the peer turn. */
  remoteSessionId?: string;
}

const TERMINALS = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"]);

/** Runs one delegation leg over the inner A2A profile. */
export async function runA2aDelegation(args: A2aDelegationArgs): Promise<A2aDelegationOutcome> {
  const { cfg, peerAgentId, signal } = args;
  const redact = args.redact ?? ((t: string) => t);
  const thread = threads.get(args.localSessionId);

  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    "Content-Type": "application/json",
  };
  const agentBase = `${cfg.baseUrl}/inner/a2a/agents/${encodeURIComponent(peerAgentId)}`;

  let taskId = "";
  let cancelSent = false;
  const cancelRemote = async (): Promise<void> => {
    if (!taskId || cancelSent) return;
    cancelSent = true;
    try {
      await fetch(`${agentBase}/tasks/${encodeURIComponent(taskId)}:cancel`, { method: "POST", headers });
    } catch {
      /* best-effort; the control plane's own expiry converges an orphaned wait */
    }
  };

  /** The task's text plus, when present, its evidence references. */
  const messageParts = (): unknown[] => {
    const parts: unknown[] = [{ text: args.text }];
    if (args.evidenceRefs?.length) {
      parts.push({ data: { evidence_refs: args.evidenceRefs }, mediaType: CONTEXT_MEDIA_TYPE });
    }
    return parts;
  };

  /** Metadata sent on BOTH the open and the resume, so neither loses lineage. */
  const messageMetadata = (): Record<string, string> => ({
    "siclaw.investigationId": args.delegationId,
    ...(args.parentSessionId ? { "siclaw.parentSessionId": args.parentSessionId } : {}),
    ...(args.parentTurnId ? { "siclaw.parentTurnId": args.parentTurnId } : {}),
    // Omitted rather than defaulted when unknown — see A2aDelegationArgs.
    ...(args.onBehalfOfUserId ? { "siclaw.onBehalfOfUserId": args.onBehalfOfUserId } : {}),
  });

  // ── frame handling (declared before dispatch: a terminal task can arrive in
  //    the resume RESPONSE or from a GET, not only from the stream) ───────────
  let artifactText = "";
  let remoteSessionId = "";
  let outcome: A2aDelegationOutcome | undefined;

  const settleTerminal = (state: string, message: any, errorCode: unknown): A2aDelegationOutcome => {
    if (state === "TASK_STATE_COMPLETED") {
      const text = redact(artifactText.trim());
      if (text) {
        args.observe({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
      }
      return { taskId, remoteSessionId };
    }
    const detail = String(message?.parts?.[0]?.text ?? "") || String(errorCode ?? "") || state;
    args.observe({ type: "stream_error", error: { message: redact(detail) } });
    return { error: redact(detail), taskId, remoteSessionId };
  };

  const handleFrame = (frame: any): A2aDelegationOutcome | undefined => {
    const task = frame?.task;
    if (task?.id) {
      taskId = String(task.id);
      const contextId = String(task.contextId ?? "");
      remoteSessionId = String(task.metadata?.sessionId ?? "");
      if (contextId) rememberThread(args.localSessionId, { ...threads.get(args.localSessionId), contextId });
      const state = String(task.status?.state ?? "");
      if (TERMINALS.has(state)) {
        // A terminal SNAPSHOT (the turn finished before our subscribe attached)
        // carries the whole answer in task.artifacts — no artifactUpdate frames
        // will follow. Harvest it, but only when nothing streamed, so a normal
        // flow never double-counts.
        if (!artifactText) {
          for (const artifact of task.artifacts ?? []) {
            for (const part of artifact?.parts ?? []) {
              if (typeof part?.text === "string") artifactText += part.text;
            }
          }
        }
        return settleTerminal(state, task.status?.message, task.metadata?.errorCode);
      }
      if (state === "TASK_STATE_INPUT_REQUIRED") {
        // A PARKED snapshot: reached when a task settles into a wait before we
        // attach, or when a GET recovers the state after a dropped stream. Same
        // handling as the streamed statusUpdate below.
        return parkOnInputRequired(String(task.status?.message?.parts?.[0]?.text ?? ""));
      }
      return undefined;
    }
    const au = frame?.artifactUpdate;
    if (au?.artifact?.parts) {
      for (const part of au.artifact.parts) {
        if (typeof part?.text === "string") artifactText += part.text;
      }
      return undefined;
    }
    const su = frame?.statusUpdate;
    if (!su) return undefined;
    const state = String(su.status?.state ?? "");
    const statusText = String(su.status?.message?.parts?.[0]?.text ?? "");
    if (state === "TASK_STATE_WORKING") {
      const tool = su.metadata?.currentTool;
      if (typeof tool === "string" && tool) {
        args.observe({ type: "tool_execution_end", toolName: tool });
      }
      return undefined;
    }
    if (state === "TASK_STATE_INPUT_REQUIRED") return parkOnInputRequired(statusText);
    if (TERMINALS.has(state)) return settleTerminal(state, su.status?.message, su.metadata?.errorCode);
    return undefined;
  };

  /**
   * The peer paused for a human answer. Remember the waiting task so the
   * coordinator's NEXT delegation to this peer thread delivers the answer into
   * the SAME task (and therefore the same remote session).
   */
  function parkOnInputRequired(question: string): A2aDelegationOutcome {
    rememberThread(args.localSessionId, {
      contextId: threads.get(args.localSessionId)?.contextId ?? "",
      waitingTaskId: taskId,
    });
    args.observe({ type: "input_required", question: redact(question) });
    return {}; // turn over; the delegate result reports input_required
  }

  /** One durable read of a task's current state; undefined when unavailable. */
  const getTask = async (id: string): Promise<any | undefined> => {
    if (!id) return undefined;
    try {
      const res = await fetch(`${agentBase}/tasks/${encodeURIComponent(id)}`, { method: "GET", headers, signal });
      if (!res.ok) return undefined;
      return await res.json();
    } catch {
      return undefined;
    }
  };

  /**
   * Recover a continuation the in-process map lost (restart, or a dropped
   * input_required frame): the control plane's own listing is authoritative.
   * Parked tasks appear under the `working` filter, so a task in
   * INPUT_REQUIRED is the one to adopt — resuming it keeps the peer's context
   * instead of stranding it and opening a duplicate.
   */
  const recoverParkedTask = async (contextId: string): Promise<string | undefined> => {
    if (!contextId) return undefined;
    try {
      const url = `${agentBase}/tasks?contextId=${encodeURIComponent(contextId)}&status=working`;
      const res = await fetch(url, { method: "GET", headers, signal });
      if (!res.ok) return undefined;
      const body = (await res.json()) as any;
      const list: any[] = Array.isArray(body) ? body : Array.isArray(body?.tasks) ? body.tasks : [];
      const parked = list.find((t) => String(t?.status?.state ?? "") === "TASK_STATE_INPUT_REQUIRED");
      const id = parked?.id ? String(parked.id) : undefined;
      if (id) console.log(`[delegate-a2a] adopted parked task ${id} for context ${contextId}`);
      return id;
    } catch {
      return undefined;
    }
  };

  // ── open the event stream ──────────────────────────────────────────────────
  // A waiting thread resumes its ORIGINAL task (message:send with taskId), then
  // follows the same task's stream; anything else opens a new task on the
  // thread's remote context (or a fresh one) via message:stream.
  let waitingTaskId = thread?.waitingTaskId;
  if (!waitingTaskId && thread?.contextId) {
    // No local continuation, but this thread HAS a remote context: ask before
    // opening a new task, or a parked peer is abandoned mid-question.
    waitingTaskId = await recoverParkedTask(thread.contextId);
    if (signal.aborted) return { stopped: true };
  }

  let response: Response;
  try {
    if (waitingTaskId) {
      const resumeRes = await fetch(`${agentBase}/message:send`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          message: {
            role: "ROLE_USER",
            taskId: waitingTaskId,
            // Stable across retries of THIS answer to THIS task.
            messageId: stableMessageId([args.delegationId, waitingTaskId, args.text]),
            parts: messageParts(),
          },
          metadata: messageMetadata(),
        }),
      });
      if (!resumeRes.ok) {
        return { error: `resume rejected by the control plane (${resumeRes.status}): ${await safeText(resumeRes)}` };
      }
      taskId = waitingTaskId;
      if (thread) thread.waitingTaskId = undefined;

      // FAST COMPLETION. The resume response may already carry the terminal
      // Task — a short answer can finish before we could subscribe. Reading it
      // is not an optimisation: the control plane answers 400
      // UNSUPPORTED_OPERATION for a subscribe on a terminal task, so
      // unconditionally subscribing reported every fast task as a FAILURE.
      const resumeBody = await safeJson(resumeRes);
      const settledOnResume = resumeBody?.task ? handleFrame({ task: resumeBody.task }) : undefined;
      if (settledOnResume) {
        return { ...settledOnResume, taskId: settledOnResume.taskId ?? taskId, remoteSessionId: settledOnResume.remoteSessionId ?? remoteSessionId };
      }

      const subscribeRes = await fetch(`${agentBase}/tasks/${encodeURIComponent(taskId)}:subscribe`, {
        method: "POST",
        headers,
        signal,
      });
      // A refusal here means the task settled between the resume and the
      // subscribe — the state we want exists, we just cannot stream it. Read it
      // once instead of reporting a transport failure for a task that finished.
      if (subscribeRes.status === 400 || subscribeRes.status === 409) {
        const snapshot = await getTask(taskId);
        const settled = snapshot?.task ?? snapshot;
        const settledOutcome = settled ? handleFrame({ task: settled }) : undefined;
        if (settledOutcome) {
          return { ...settledOutcome, taskId: settledOutcome.taskId ?? taskId, remoteSessionId: settledOutcome.remoteSessionId ?? remoteSessionId };
        }
        return {
          error: `control plane refused to stream task ${taskId} (${subscribeRes.status}) and its state could not be read`,
          taskId,
          remoteSessionId,
        };
      }
      response = subscribeRes;
    } else {
      response = await fetch(`${agentBase}/message:stream`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          message: {
            role: "ROLE_USER",
            ...(thread?.contextId ? { contextId: thread.contextId } : {}),
            // Stable for THIS delegation leg, so a retried open cannot create a
            // second task for one logical request.
            messageId: stableMessageId([args.delegationId, "open", thread?.contextId, args.text]),
            parts: messageParts(),
          },
          metadata: messageMetadata(),
        }),
      });
    }
  } catch (err) {
    if (signal.aborted) return { stopped: true };
    return { error: `control-plane dispatch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (signal.aborted) {
    await cancelRemote();
    return { stopped: true };
  }
  if (!response.ok || !response.body) {
    return { error: `control plane refused the delegation (${response.status}): ${await safeText(response)}` };
  }

  // ── consume frames ─────────────────────────────────────────────────────────
  try {
    for await (const frame of sseFrames(response.body, signal)) {
      outcome = handleFrame(frame);
      if (outcome) break;
    }
  } catch (err) {
    if (signal.aborted) {
      await cancelRemote();
      return { stopped: true, taskId, remoteSessionId };
    }
    return { error: `delegation stream failed: ${err instanceof Error ? err.message : String(err)}`, taskId, remoteSessionId };
  }
  if (signal.aborted) {
    await cancelRemote();
    return { stopped: true, taskId, remoteSessionId };
  }
  if (!outcome) {
    // Stream ended without a terminal frame — ask the task once; the control
    // plane's projection is durable even when a stream drops. (This fallback was
    // documented here but never implemented: the code reported an error while
    // the answer sat readable on the durable side.)
    const snapshot = await getTask(taskId);
    const settled = snapshot?.task ?? snapshot;
    const recovered = settled ? handleFrame({ task: settled }) : undefined;
    if (recovered) {
      return { ...recovered, taskId: recovered.taskId ?? taskId, remoteSessionId: recovered.remoteSessionId ?? remoteSessionId };
    }
    return { error: "delegation stream ended before a terminal state", taskId, remoteSessionId };
  }
  return { ...outcome, taskId: outcome.taskId ?? taskId, remoteSessionId: outcome.remoteSessionId ?? remoteSessionId };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 512);
  } catch {
    return "";
  }
}

/** Parses a JSON body, tolerating an empty or non-JSON one (ack-only replies). */
async function safeJson(res: Response): Promise<any | undefined> {
  try {
    const text = await res.text();
    if (!text.trim()) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Minimal SSE reader: yields each `data: {json}` frame as a parsed object. */
async function* sseFrames(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue; // heartbeats/comments
          try {
            yield JSON.parse(line.slice(6));
          } catch {
            /* skip malformed frame */
          }
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}
