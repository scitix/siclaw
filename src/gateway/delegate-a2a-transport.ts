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
 * waitingTaskId }. A process restart drops it, and the next delegation to the
 * same peer thread starts a fresh remote context — same degradation the
 * legacy relay has for its in-flight state.
 */
import { randomUUID } from "node:crypto";

export interface A2aTransportConfig {
  baseUrl: string; // e.g. http://<internal-a2a-service>:<port>
  token: string; // workload bearer credential
}

/** Reads the feature flag; undefined = legacy transport. */
export function a2aTransportConfig(env: NodeJS.ProcessEnv = process.env): A2aTransportConfig | undefined {
  if (env.SICLAW_DELEGATION_TRANSPORT !== "a2a") return undefined;
  const baseUrl = env.SICLAW_INNER_A2A_URL?.replace(/\/$/, "");
  const token = env.SICLAW_INNER_A2A_TOKEN;
  if (!baseUrl || !token) {
    console.warn("[delegate-a2a] SICLAW_DELEGATION_TRANSPORT=a2a but SICLAW_INNER_A2A_URL/TOKEN are not both set; falling back to the legacy transport");
    return undefined;
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

export interface A2aDelegationArgs {
  cfg: A2aTransportConfig;
  peerAgentId: string;
  text: string;
  /** The local peer-session row id — the continuation key. */
  localSessionId: string;
  parentSessionId?: string;
  parentTurnId?: string;
  delegationId: string;
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

  // ── open the event stream ──────────────────────────────────────────────────
  // A waiting thread resumes its ORIGINAL task (message:send with taskId), then
  // follows the same task's stream; anything else opens a new task on the
  // thread's remote context (or a fresh one) via message:stream.
  let response: Response;
  try {
    if (thread?.waitingTaskId) {
      const resumeRes = await fetch(`${agentBase}/message:send`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          message: {
            role: "ROLE_USER",
            taskId: thread.waitingTaskId,
            messageId: randomUUID(),
            parts: [{ text: args.text }],
          },
        }),
      });
      if (!resumeRes.ok) {
        return { error: `resume rejected by the control plane (${resumeRes.status}): ${await safeText(resumeRes)}` };
      }
      taskId = thread.waitingTaskId;
      thread.waitingTaskId = undefined;
      response = await fetch(`${agentBase}/tasks/${encodeURIComponent(taskId)}:subscribe`, {
        method: "POST",
        headers,
        signal,
      });
    } else {
      response = await fetch(`${agentBase}/message:stream`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          message: {
            role: "ROLE_USER",
            ...(thread?.contextId ? { contextId: thread.contextId } : {}),
            parts: [{ text: args.text }],
          },
          metadata: {
            "siclaw.investigationId": args.delegationId,
            ...(args.parentSessionId ? { "siclaw.parentSessionId": args.parentSessionId } : {}),
            ...(args.parentTurnId ? { "siclaw.parentTurnId": args.parentTurnId } : {}),
          },
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
  let artifactText = "";
  let remoteSessionId = "";
  let outcome: A2aDelegationOutcome | undefined;

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
    if (state === "TASK_STATE_INPUT_REQUIRED") {
      // The peer paused for a human answer. Remember the waiting task so the
      // coordinator's NEXT delegation to this peer thread delivers the answer
      // into the SAME task (and therefore the same remote session).
      rememberThread(args.localSessionId, {
        contextId: threads.get(args.localSessionId)?.contextId ?? "",
        waitingTaskId: taskId,
      });
      args.observe({ type: "input_required", question: redact(statusText) });
      return {}; // turn over; the delegate result reports input_required
    }
    if (TERMINALS.has(state)) return settleTerminal(state, su.status?.message, su.metadata?.errorCode);
    return undefined;
  };

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
    // plane's projection is durable even when a stream drops.
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
