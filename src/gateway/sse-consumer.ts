/**
 * Shared SSE consumer — extracts tool call persistence and result text from
 * an AgentBox event stream.
 *
 * Used by both Portal chat-gateway (web chat) and CronCoordinator (scheduled
 * tasks). Callers add their own behaviour via the `onEvent` callback (e.g.
 * forwarding events to an SSE client).
 *
 * When `persistMessages` is true, every tool call and assistant message is
 * written to chat_messages. The caller is responsible for creating the
 * chat_sessions row before invoking.
 */

import { ErrorCodes } from "../lib/error-envelope.js";
import { AgentBoxClient } from "./agentbox/client.js";
import { appendMessage, incrementMessageCount, updateMessage } from "./chat-repo.js";
import { redactText, type RedactionConfig } from "./output-redactor.js";

// ── Public types ────────────────────────────────────

export type SseEvent = Record<string, unknown>;

export interface SseEventExtras {
  /** DB message ID when a role="tool" row was inserted for this event. */
  dbMessageId?: string;
}

export type OnEventCallback = (
  event: SseEvent,
  eventType: string,
  extras: SseEventExtras,
) => void;

export interface ConsumeAgentSseOptions {
  client: AgentBoxClient;
  sessionId: string;
  userId: string;
  /**
   * When true, persist tool calls and assistant messages to chat_messages.
   * Caller must ensure chat_sessions row for sessionId exists (FK constraint).
   */
  persistMessages?: boolean;
  redactionConfig?: RedactionConfig;
  /** Called for every SSE event after DB writes (so dbMessageId is available). */
  onEvent?: OnEventCallback;
  /** Abort signal — breaks the loop when triggered. */
  signal?: AbortSignal;
  /**
   * Optional explicit turn-start anchor (ms epoch). When provided, used as
   * the basis for ⏳/💭/✍️/turn_total measurements instead of the local
   * `Date.now()` taken when consumeAgentSse begins iterating. Portal sets
   * this at POST receipt so the timing covers the portal→runtime RPC hop
   * the runtime cannot otherwise see.
   */
  turnStartTime?: number;
  /**
   * per-prompt root trace id (from the /api/prompt ack). Stamped onto every
   * assistant/tool row this consumer persists so a whole interaction's agent
   * output shares one trace_id in chat_messages. Absent → rows keep NULL.
   */
  traceId?: string;
}

export interface SseConsumptionResult {
  /** Final assistant text (task_report takes priority over free text). */
  resultText: string;
  /** Raw task_report output, empty string if task_report was not called. */
  taskReportText: string;
  /** Model-level error (e.g. API 404, rate-limit). Empty string if no error. */
  errorMessage: string;
  eventCount: number;
  durationMs: number;
}

// ── Implementation ──────────────────────────────────

const EMPTY_REDACTION: RedactionConfig = { patterns: [] };

/**
 * Inter-event dispatch jitter — the tightest possible gap between two
 * timestamps that come from the SSE event loop's natural pacing rather than
 * any real wall-clock interval. Used by the ttft/thinking dedup below: if
 * the two values differ by less than this, they are treated as the same
 * instant and only one is emitted (avoids double-counting on naive sums).
 *
 * 50ms is a conservative ceiling for a single Node tick + WS hop; bump it
 * if you start seeing duplicate ⏳/💭 badges on first-of-turn messages.
 */
const NOISE_FLOOR_MS = 50;

/**
 * Drop negative timing deltas. Same-process measurements are always ≥0, but
 * cross-process anchors (e.g. portal POST timestamp passed to runtime via
 * RPC) can briefly produce negatives if the two pods' NTP clocks have drifted
 * apart. We treat negatives as "unknown" rather than persist them — downstream
 * (the chat timing badge) interprets absence as unmeasured, which is correct.
 */
function nonNegative(ms: number): number | undefined {
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * Strip pi-agent's `(Empty response: {...})` diagnostic markers that get
 * appended to an assistant message when the model returns content=[]. These
 * are useful in server logs but pollute the persisted trace shown to users.
 * Match uses greedy balanced-brace detection inside the wrapper.
 */
function stripEmptyResponseMarkers(text: string): string {
  return text.replace(/\s*\(Empty response:\s*\{[\s\S]*?\}\)\s*/g, "").trimEnd();
}

/**
 * Pick the subset of tool-result `details` worth persisting as message
 * metadata. The `blocked`/`error` flags are already surfaced via the message's
 * `outcome` column — dropping them here avoids duplicate storage. Anything
 * else (structured data a tool attaches to its result) is passed through so
 * the UI can rebuild from the DB row on history reload without depending on
 * the ephemeral live stream.
 *
 * Redaction is applied via a JSON round-trip so patterns hit string values
 * nested inside arrays/objects. If redaction somehow produces invalid JSON
 * (defensive only — current redactText just substitutes `[REDACTED]` which is
 * safe inside JSON strings), the metadata is dropped rather than persisted
 * corrupt.
 */
function extractPersistableDetails(
  details: Record<string, unknown> | undefined,
  redactionConfig: RedactionConfig,
): Record<string, unknown> | null {
  if (!details) return null;

  const { blocked: _blocked, error: _error, ...rest } = details;
  if (Object.keys(rest).length === 0) return null;

  if (redactionConfig.patterns.length === 0) return rest;

  const serialized = JSON.stringify(rest);
  const redacted = redactText(serialized, redactionConfig);
  try {
    return JSON.parse(redacted) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function routeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function routeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function routeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function compactRouteError(value: unknown, redactionConfig: RedactionConfig): string | undefined {
  const text = routeString(value);
  if (!text) return undefined;
  return redactText(text, redactionConfig).slice(0, 500);
}

function modelRouteSwitchMetadata(evt: SseEvent, redactionConfig: RedactionConfig): Record<string, unknown> | null {
  const fromCandidateKey = routeString(evt.fromCandidateKey);
  const toCandidateKey = routeString(evt.toCandidateKey);
  const fromProvider = routeString(evt.fromProvider);
  const fromModelId = routeString(evt.fromModelId);
  const toProvider = routeString(evt.toProvider);
  const toModelId = routeString(evt.toModelId);
  if (!fromCandidateKey || !toCandidateKey || !fromProvider || !fromModelId || !toProvider || !toModelId) {
    return null;
  }
  return {
    kind: "model_route_notice",
    event_type: "model_route.switch",
    from_candidate_key: fromCandidateKey,
    from_provider: fromProvider,
    from_model_id: fromModelId,
    to_candidate_key: toCandidateKey,
    to_provider: toProvider,
    to_model_id: toModelId,
    failure_kind: routeString(evt.failureKind),
    error_message: compactRouteError(evt.errorMessage, redactionConfig),
    cooldown_until: routeNumber(evt.cooldownUntil),
    attempt: routeNumber(evt.attempt),
  };
}

function modelRouteSuccessMetadata(
  evt: SseEvent,
  latestSwitch: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const candidateKey = routeString(evt.candidateKey);
  const provider = routeString(evt.provider);
  const modelId = routeString(evt.modelId);
  const isFallback = routeBoolean(evt.isFallback);
  const primaryCandidateKey = routeString(evt.primaryCandidateKey);
  if (!candidateKey || !provider || !modelId || isFallback === undefined || !primaryCandidateKey) {
    return null;
  }

  const metadata: Record<string, unknown> = {
    candidate_key: candidateKey,
    provider,
    model_id: modelId,
    is_fallback: isFallback,
    primary_candidate_key: primaryCandidateKey,
    attempt: routeNumber(evt.attempt),
  };

  if (latestSwitch && latestSwitch.to_candidate_key === candidateKey) {
    metadata.switched_from_candidate_key = latestSwitch.from_candidate_key;
    metadata.switched_from_provider = latestSwitch.from_provider;
    metadata.switched_from_model_id = latestSwitch.from_model_id;
    metadata.failure_kind = latestSwitch.failure_kind;
    metadata.error_message = latestSwitch.error_message;
    metadata.cooldown_until = latestSwitch.cooldown_until;
  }

  const recoveredFromCandidateKey = routeString(evt.recoveredFromCandidateKey);
  if (recoveredFromCandidateKey) {
    metadata.recovered_from_candidate_key = recoveredFromCandidateKey;
    metadata.recovered_from_provider = routeString(evt.recoveredFromProvider);
    metadata.recovered_from_model_id = routeString(evt.recoveredFromModelId);
  }

  return metadata;
}

function modelRouteRecoveryMetadata(evt: SseEvent): Record<string, unknown> | null {
  const recoveredFromCandidateKey = routeString(evt.recoveredFromCandidateKey);
  const recoveredFromProvider = routeString(evt.recoveredFromProvider);
  const recoveredFromModelId = routeString(evt.recoveredFromModelId);
  const toCandidateKey = routeString(evt.candidateKey);
  const toProvider = routeString(evt.provider);
  const toModelId = routeString(evt.modelId);
  if (!recoveredFromCandidateKey || !recoveredFromProvider || !recoveredFromModelId || !toCandidateKey || !toProvider || !toModelId) {
    return null;
  }
  return {
    kind: "model_route_notice",
    event_type: "model_route.recovered",
    from_candidate_key: recoveredFromCandidateKey,
    from_provider: recoveredFromProvider,
    from_model_id: recoveredFromModelId,
    to_candidate_key: toCandidateKey,
    to_provider: toProvider,
    to_model_id: toModelId,
    attempt: routeNumber(evt.attempt),
  };
}

function modelRouteNoticeContent(metadata: Record<string, unknown>): string {
  const eventType = routeString(metadata.event_type);
  const toProvider = routeString(metadata.to_provider) ?? "unknown";
  const toModelId = routeString(metadata.to_model_id) ?? "unknown";
  if (eventType === "model_route.recovered") {
    return `Recovered to primary model ${toProvider}/${toModelId}.`;
  }
  const fromProvider = routeString(metadata.from_provider) ?? "unknown";
  const fromModelId = routeString(metadata.from_model_id) ?? "unknown";
  const failureKind = routeString(metadata.failure_kind);
  const reason = failureKind ? ` (${failureKind})` : "";
  return `Switched to fallback model ${toProvider}/${toModelId} after ${fromProvider}/${fromModelId} failed${reason}.`;
}

function attachModelRouteMetadata(
  metadata: Record<string, unknown> | null,
  modelRouteMetadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!modelRouteMetadata) return metadata;
  return {
    ...(metadata ?? {}),
    model_route: modelRouteMetadata,
  };
}

function pushPending<T>(map: Map<string, T[]>, key: string, value: T): void {
  const queue = map.get(key);
  if (queue) queue.push(value);
  else map.set(key, [value]);
}

function shiftPending<T>(map: Map<string, T[]>, key: string): T | undefined {
  const queue = map.get(key);
  if (!queue) return undefined;
  const value = queue.shift();
  if (queue.length === 0) map.delete(key);
  return value;
}

/** Everything captured at tool_execution_start that its tool_execution_end
 *  (and the abort finalizer) needs to complete the row. */
interface PendingToolCall {
  toolName: string;
  /** Raw JSON of the call args (unredacted — redacted at write time). */
  input: string;
  startMs: number;
  /** DB row id of the eagerly-persisted "running" placeholder (persist mode only). */
  messageId?: string;
  preThinkingMs?: number;
}

/** Pairing key for a tool_execution_start/end pair: the invocation-unique
 *  toolCallId when the event carries one, else the tool name (FIFO fallback). */
function toolCallKey(evt: Record<string, unknown>, toolName: string): string {
  const id = evt.toolCallId;
  return typeof id === "string" && id ? id : toolName;
}

export async function consumeAgentSse(opts: ConsumeAgentSseOptions): Promise<SseConsumptionResult> {
  const { client, sessionId, userId, onEvent, signal } = opts;
  const persist = opts.persistMessages === true;
  const redactionConfig = opts.redactionConfig ?? EMPTY_REDACTION;
  // Stamp this turn's root trace id onto every persisted row. traceId is constant
  // for the whole consume run (one prompt = one root trace), so one wrapper covers
  // all append sites; updateMessage is untouched (rows are stamped at append time).
  const appendRow = (input: Parameters<typeof appendMessage>[0]) =>
    appendMessage({ ...input, traceId: opts.traceId ?? null });

  let assistantContent = "";
  let currentMsgText = "";
  let resultText = "";
  let taskReportText = "";
  let errorMessage = "";
  let streamErrorEmitted = false;
  let errorPersisted = false;
  // ── Routed-turn commit gating ──
  // When model routing streams the primary candidate live, this consumer sees a
  // candidate's events BEFORE we know whether it won. So the durable writes
  // (assistant reply + error rows) are deferred to a commit point and dropped on
  // a rollback — the live frontend already rendered them via the SSE relay, so
  // this only governs what survives a reload. Tool rows are NOT deferred: the
  // first tool execution blocks fallback for good (#312), so a tool row is
  // already committed when it appears. Non-routed turns never set isRoutingTurn,
  // so they persist inline exactly as before.
  let isRoutingTurn = false;
  let routingCommitted = false;
  const pendingAssistantOps: Array<() => Promise<void>> = [];
  const pendingErrorOps: Array<() => Promise<void>> = [];
  const flushOps = async (ops: Array<() => Promise<void>>) => {
    const drained = ops.splice(0);
    for (const op of drained) await op();
  };
  // tool_start / model_route_success: the turn is committed. Flush the deferred
  // assistant write; drop any error row buffered from a failed earlier attempt
  // (the turn ultimately produced output / succeeded).
  const commitRoutedTurn = async () => {
    routingCommitted = true;
    pendingErrorOps.length = 0;
    // The turn produced committed output / succeeded — a failed earlier
    // attempt's error must not leak into the returned run summary.
    errorMessage = "";
    await flushOps(pendingAssistantOps);
  };
  // model_route_rollback: the live primary failed and will be retried on the
  // next candidate. Drop everything it buffered and re-arm the per-attempt
  // dedup flags so the next attempt can record (and surface live) its own
  // error, and so the rolled-back attempt's error text doesn't leak into the
  // returned run summary / notifications (mirrors commitRoutedTurn).
  const discardRoutedAttempt = () => {
    pendingAssistantOps.length = 0;
    pendingErrorOps.length = 0;
    errorPersisted = false;
    streamErrorEmitted = false;
    errorMessage = "";
    // The primary's deferred assistant op flipped firstAssistantPersisted when
    // it was enqueued; we're now discarding that op, so undo the flip — else the
    // surviving fallback reply, which becomes the turn's first persisted
    // assistant, is wrongly gated out of ttft_ms (the turn anchor).
    firstAssistantPersisted = false;
  };
  let lastToolName = "";

  // In-flight tool calls awaiting their tool_execution_end. Keyed by the
  // event's toolCallId (stable per invocation): pi-agent runs a same-turn tool
  // batch in PARALLEL, so ends arrive in completion order, not start order —
  // name-FIFO pairing writes call A's result into call B's row (and stamps the
  // wrong dbMessageId on the relayed event, so the live card cross-attaches
  // too). Events lacking a toolCallId fall back to a per-toolName FIFO queue.
  const pendingToolCalls = new Map<string, PendingToolCall[]>();

  let eventCount = 0;
  const startTime = Date.now();

  // ── Per-turn timing capture (for ⏳ TTFT / 💭 thinking / total) ──
  // turnStartTime: server-side anchor for the whole user→assistant turn.
  //   Prefer caller-supplied (portal POST timestamp) over local startTime so
  //   the portal→runtime RPC hop is included in measurements.
  // firstTokenTime: first model output of any kind (text or tool call) — TTFT.
  // lastBoundaryTime: latest moment the model was *given input* — turn start
  //   initially, then bumped to each tool_execution_end. The gap between
  //   lastBoundaryTime and the next emission (text_delta or tool_execution_start)
  //   is what we call "model thinking time" — the part the user previously
  //   couldn't see for tool-call gaps. Single-clock by design.
  const turnStartTime = opts.turnStartTime ?? startTime;
  let firstTokenTime: number | undefined;
  let lastBoundaryTime = turnStartTime;
  let assistantMsgFirstTextTime: number | undefined;
  let pendingThinkingMs: number | undefined;
  // ttft_ms is a turn-scoped anchor (turnStart → first token of the very
  // first assistant message). Persisting it on subsequent messages would
  // make a naive UI sum double-count the same interval N times. Tracked
  // and only emitted once.
  let firstAssistantPersisted = false;
  // Latest persisted assistant message of the turn — so the `agent_end`
  // context-usage snapshot can be merged onto its metadata. Persisting the
  // snapshot lets the frontend restore the context meter when a session is
  // reopened/refreshed (it otherwise only has it from a live agent_end, which a
  // cold session never replays). Overwritten on each assistant message_end, so
  // by agent_end these point at the turn's final assistant message.
  let lastAssistantDbMessageId: string | undefined;
  let lastAssistantContent: string | undefined;
  let lastAssistantMetadata: Record<string, unknown> | undefined;
  // Latest agent_end context-usage snapshot of the turn. agent_end fires BEFORE
  // model_route_success (the commit point that runs the deferred assistant
  // persist on routed turns — i.e. every turn), so the assistant row usually
  // isn't written yet when agent_end arrives. We therefore stash the snapshot
  // here and let the deferred persistAssistant fold it into the row's metadata.
  let capturedContextUsage: Record<string, unknown> | undefined;
  let latestModelRouteSwitch: Record<string, unknown> | null = null;
  let currentModelRouteMetadata: Record<string, unknown> | null = null;

  for await (const event of client.streamEvents(sessionId)) {
    if (signal?.aborted) break;

    const evt = event as SseEvent;
    // Always a string: tool-pushed extra events (e.g. task_event, which carries
    // `kind` not `type`) have no `type`. A bare `eventType.includes(...)` on
    // undefined would throw and kill the whole SSE stream (STREAM_INTERRUPTED).
    const eventType = (evt.type as string | undefined) ?? "";
    eventCount++;

    // Log lifecycle events
    if (
      eventType === "agent_start" || eventType === "agent_end" ||
      eventType === "message_end" || eventType === "message_start" ||
      eventType.includes("error")
    ) {
      console.log(`[sse-consumer] ${userId}: ${eventType}`, JSON.stringify(event).slice(0, 300));
    }

    let dbMessageId: string | undefined;

    // ── Capture context-usage snapshot from agent_end ──────────────────────
    // The brain computes {tokens, contextWindow, percent, inputTokens, ...} and
    // attaches it to agent_end (enrichAgentEndEvent in agentbox/http-server.ts).
    // Persisting it in the last assistant row's metadata lets the frontend
    // restore the context meter on session reopen/refresh (otherwise it's blank
    // until the next live turn). Two delivery orders:
    //   • routed turn (default): agent_end precedes the deferred persist, so the
    //     row isn't written yet — persistAssistant folds capturedContextUsage in.
    //   • immediate persist (non-routed): the row already exists, so patch it now.
    // Best-effort: a persistence failure must never break the SSE stream.
    if (eventType === "agent_end" && persist) {
      const contextUsage = (evt as Record<string, unknown>).contextUsage;
      if (contextUsage && typeof contextUsage === "object") {
        capturedContextUsage = contextUsage as Record<string, unknown>;
        if (lastAssistantDbMessageId) {
          try {
            await updateMessage({
              messageId: lastAssistantDbMessageId,
              sessionId,
              content: lastAssistantContent ?? "",
              metadata: { ...(lastAssistantMetadata ?? {}), context_usage: capturedContextUsage },
            });
          } catch (err) {
            console.warn(`[sse-consumer] ${userId}: failed to persist context_usage:`, err);
          }
        }
      }
    }

    // ── Model route audit + UI notices ──────────────
    if (eventType === "model_route_start") {
      latestModelRouteSwitch = null;
      currentModelRouteMetadata = null;
      isRoutingTurn = true;
      routingCommitted = false;
      discardRoutedAttempt();
    }

    if (eventType === "model_route_switch") {
      const metadata = modelRouteSwitchMetadata(evt, redactionConfig);
      if (metadata) {
        latestModelRouteSwitch = metadata;
        if (persist) {
          dbMessageId = await appendRow({
            sessionId,
            role: "assistant",
            content: modelRouteNoticeContent(metadata),
            metadata,
          });
          await incrementMessageCount(sessionId);
        }
      }
    }

    if (eventType === "model_route_success") {
      const metadata = modelRouteSuccessMetadata(evt, latestModelRouteSwitch);
      const isFallback = metadata?.is_fallback === true;
      const recovered = typeof metadata?.recovered_from_candidate_key === "string";
      currentModelRouteMetadata = metadata && (isFallback || recovered) ? metadata : null;
      if (currentModelRouteMetadata) {
        (evt as Record<string, unknown>).modelRoute = currentModelRouteMetadata;
      }

      const recoveryMetadata = modelRouteRecoveryMetadata(evt);
      if (recoveryMetadata) {
        latestModelRouteSwitch = null;
        if (persist) {
          dbMessageId = await appendRow({
            sessionId,
            role: "assistant",
            content: modelRouteNoticeContent(recoveryMetadata),
            metadata: recoveryMetadata,
          });
          await incrementMessageCount(sessionId);
        }
      }
      if (isRoutingTurn) await commitRoutedTurn();
    }

    // ── Model route: exhausted commits the final attempt's output + error;
    //    rollback discards a failed live primary before the next candidate. ──
    if (eventType === "model_route_exhausted") {
      routingCommitted = true;
      await flushOps(pendingAssistantOps);
      await flushOps(pendingErrorOps);
    }
    if (eventType === "model_route_rollback") {
      discardRoutedAttempt();
      routingCommitted = false;
    }

    // ── DB persistence: tool_execution_end ──────────
    if (eventType === "tool_execution_end") {
      const toolResult = evt.result as {
        content?: Array<{ type: string; text?: string }>;
        details?: Record<string, unknown>;
      } | undefined;
      const text =
        toolResult?.content
          ?.filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("") ?? "";
      const toolName = (evt.toolName as string) || (evt.name as string) || "tool";

      let outcome: "success" | "error" | "blocked" = "success";
      if (toolResult?.details?.blocked) outcome = "blocked";
      else if (toolResult?.details?.error) outcome = "error";

      const pendingCall = shiftPending(pendingToolCalls, toolCallKey(evt, toolName));
      const durationMs = pendingCall ? Date.now() - pendingCall.startMs : undefined;
      const preThinkingMs = pendingCall?.preThinkingMs;
      // Surface duration + pre-thinking on the live event for frontend.
      if (durationMs != null) {
        (evt as Record<string, unknown>).durationMs = durationMs;
      }
      if (preThinkingMs != null) {
        (evt as Record<string, unknown>).preThinkingMs = preThinkingMs;
      }
      const toolInput = pendingCall?.input || "";
      const existingMessageId = pendingCall?.messageId;
      const detailsMeta = extractPersistableDetails(toolResult?.details, redactionConfig);
      // Merge pre-thinking back in — extractPersistableDetails only looks at
      // the tool *result*, so we'd otherwise lose what we recorded at
      // tool_execution_start. We persist the value even when 0/small so the
      // UI can render a 💭 badge on every tool: a 0ms badge on the 2nd-Nth
      // tool of a batch makes "one thinking → many tools" auditable.
      const metadata: Record<string, unknown> | null =
        preThinkingMs != null
          ? { ...(detailsMeta ?? {}), pre_thinking_ms: preThinkingMs }
          : detailsMeta;
      const metadataWithRoute = attachModelRouteMetadata(metadata, currentModelRouteMetadata);
      const delegationId = typeof metadata?.delegation_id === "string" ? metadata.delegation_id : null;

      if (persist) {
        const payload = {
          sessionId,
          content: redactText(text, redactionConfig),
          toolName,
          toolInput: toolInput ? redactText(toolInput, redactionConfig) : null,
          outcome,
          durationMs: durationMs ?? null,
          metadata: metadataWithRoute,
          delegationId,
        };
        if (existingMessageId) {
          await updateMessage({ ...payload, messageId: existingMessageId });
          dbMessageId = existingMessageId;
        } else {
          dbMessageId = await appendRow({ ...payload, role: "tool" });
          await incrementMessageCount(sessionId);
        }
      }

      // task_report detection — use toolName from this event, not lastToolName
      // (lastToolName tracks the last *started* tool, unreliable with parallel calls)
      if (toolName === "task_report" && text) {
        taskReportText = text;
      }
      // Bump the model-input boundary: the model now has the tool result and
      // any subsequent thinking/text/tool-use is computed from this point.
      lastBoundaryTime = Date.now();
    }

    // ── DB persistence: message_update (accumulate assistant text) ──
    if (eventType === "message_update") {
      const ame = evt.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (ame?.type === "text_delta" && ame.delta) {
        const nowAtDelta = Date.now();
        if (firstTokenTime === undefined) firstTokenTime = nowAtDelta;
        if (assistantMsgFirstTextTime === undefined) {
          assistantMsgFirstTextTime = nowAtDelta;
          // Boundary-based: covers thinking after the previous tool result
          // (or from turn start), not just the gap inside one assistant
          // message. The thinking is fully attributed to *this* text bubble.
          pendingThinkingMs = nowAtDelta - lastBoundaryTime;
        }
        // Bump boundary on every text delta so a tool emitted right after
        // text doesn't double-count the same thinking interval. The text
        // bubble already showed 💭 for that gap; the tool's pre-thinking
        // measures only the (typically tiny) handoff after text emission.
        lastBoundaryTime = nowAtDelta;
        assistantContent += ame.delta;
        currentMsgText += ame.delta;
      }
    }

    // ── message_start: reset per-message accumulator ──
    if (eventType === "message_start") {
      currentMsgText = "";
      const message = evt.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant") {
        // Per-message resets only — the boundary anchor (turn-start /
        // last tool_execution_end) is intentionally NOT touched here, so
        // pre-text thinking time still counts gaps that started before
        // this message_start fired.
        assistantMsgFirstTextTime = undefined;
        pendingThinkingMs = undefined;
      }
    }

    // ── tool_execution_start: capture input + start time ──
    if (eventType === "tool_execution_start" || eventType === "tool_start") {
      // First tool execution commits the routed turn (fallback is now blocked):
      // flush any assistant text deferred before this point so the tool row
      // lands after it in the transcript.
      if (isRoutingTurn && !routingCommitted) await commitRoutedTurn();
      const nowAtStart = Date.now();
      if (firstTokenTime === undefined) firstTokenTime = nowAtStart;
      const startToolName = (evt.toolName as string) || (evt.name as string) || "tool";
      const args = evt.args as Record<string, unknown> | undefined;
      const rawToolInput = args ? JSON.stringify(args) : "";
      // Pre-tool thinking: gap between the previous model-input boundary
      // (turn start, or the previous tool_execution_end) and this tool's
      // start. This is the model's "I just got new info, deciding what to
      // do next" interval — invisible until we measured it explicitly.
      // nonNegative() drops cross-pod clock-drift artefacts; absence
      // downstream means "unknown", which is the correct semantics.
      const preThinkingMs = nonNegative(nowAtStart - lastBoundaryTime);
      const pendingCall: PendingToolCall = {
        toolName: startToolName,
        input: rawToolInput,
        startMs: nowAtStart,
      };
      if (preThinkingMs !== undefined) pendingCall.preThinkingMs = preThinkingMs;
      pushPending(pendingToolCalls, toolCallKey(evt, startToolName), pendingCall);
      lastToolName = startToolName;
      // Surface on the live event so frontend can render 💭 immediately.
      if (preThinkingMs !== undefined) {
        (evt as Record<string, unknown>).preThinkingMs = preThinkingMs;
      }

      if (persist) {
        // pre_thinking_ms is durable telemetry, NOT debug-only. Persisted on
        // every tool row even when ~0ms because a near-zero value on the 2nd-
        // Nth tool of a batch is the visible proof that those tools came from
        // a single model "thinking burst" — not noise to filter out. Once
        // production rows carry this field, downstream consumers (analytics,
        // replay, audit reports) may rely on its presence; keep it stable.
        const startMetadata: Record<string, unknown> = {
          status: "running",
          started_at: new Date(nowAtStart).toISOString(),
        };
        if (preThinkingMs !== undefined) {
          startMetadata.pre_thinking_ms = preThinkingMs;
        }
        const startMetadataWithRoute = attachModelRouteMetadata(startMetadata, currentModelRouteMetadata);
        dbMessageId = await appendRow({
          sessionId,
          role: "tool",
          content: "",
          toolName: startToolName,
          toolInput: rawToolInput ? redactText(rawToolInput, redactionConfig) : null,
          outcome: null,
          durationMs: null,
          metadata: startMetadataWithRoute,
        });
        pendingCall.messageId = dbMessageId;
        await incrementMessageCount(sessionId);
      }
    }

    // ── message_end / turn_end: persist assistant message + extract result ──
    if (eventType === "message_end" || eventType === "turn_end") {
      const message = evt.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant") {
        // Capture model-level errors (e.g. API 404, rate-limit) and surface
        // them upstream as a single stream_error event so the proxy/frontend
        // can render an inline error bubble instead of silently stopping.
        // Dedupe within one consume run — pi-agent retries internally, which
        // would otherwise produce one bubble per retry attempt.
        if (message.stopReason === "error" && message.errorMessage) {
          errorMessage = String(message.errorMessage);
          if (onEvent && !streamErrorEmitted) {
            streamErrorEmitted = true;
            onEvent(
              {
                type: "stream_error",
                error: {
                  code: ErrorCodes.MODEL_ERROR,
                  message: errorMessage,
                  retriable: true,
                },
              },
              "stream_error",
              {},
            );
          }
          // Persist the error as its own DB row so it survives a page refresh
          // or session re-open. The live frontend error bubble is client-only
          // (role="error", no DB row) and is dropped once history reloads from
          // the DB — without this row a failed turn reloads as just the user
          // message. The motivating case is model-routing exhausting during
          // setup: it emits a synthetic error message_end with EMPTY content,
          // so the assistantContent persist path below skips it entirely and
          // nothing about the failure reaches the database. Dedup per consume
          // run (pi-agent can retry and emit several error message_ends).
          if (persist && !errorPersisted) {
            errorPersisted = true;
            const errorContent = redactText(errorMessage, redactionConfig);
            const persistError = async () => {
              await appendRow({
                sessionId,
                role: "assistant",
                content: errorContent,
                metadata: {
                  kind: "error_response",
                  error_code: ErrorCodes.MODEL_ERROR,
                  retriable: true,
                },
              });
              await incrementMessageCount(sessionId);
            };
            // On a routed turn this error belongs to a candidate that may yet be
            // replaced by a successful fallback — defer it to the commit point
            // (only an exhausted turn actually writes it; success/rollback drop
            // it). Non-routed turns write inline.
            if (isRoutingTurn && !routingCommitted) pendingErrorOps.push(persistError);
            else await persistError();
          }
        }

        // Extract text for resultText
        let extracted = "";
        const content = message.content;
        if (typeof content === "string" && content) {
          extracted = content;
        } else if (Array.isArray(content)) {
          extracted = (content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("");
        }
        resultText = extracted || currentMsgText || resultText;

        // Build timing metadata for this assistant message. Audit-friendly
        // by construction: every interval is non-overlapping with every
        // other badge in the same turn, so a naive sum across all chat
        // bubbles equals turn_total_ms (within event-dispatch noise).
        //
        //   ⏳ ttft_ms       — first message only (turn-anchor; would
        //                       otherwise double-count if put on every msg)
        //   💭 thinking_ms   — boundary → first text_delta (per message)
        //   ✍️ output_ms    — first text_delta → message_end (per message)
        //   turn_total_ms    — kept for the last message as audit cross-check
        const nowAtEnd = Date.now();
        // turn_total may be slightly negative under cross-pod clock drift
        // (portal-supplied turnStartTime ahead of runtime's nowAtEnd); drop
        // it in that case rather than persist garbage.
        const turnTotal = nonNegative(nowAtEnd - turnStartTime);
        const timing: Record<string, number> = {};
        if (turnTotal !== undefined) timing.turn_total_ms = turnTotal;
        if (!firstAssistantPersisted && firstTokenTime !== undefined) {
          const ttft = nonNegative(firstTokenTime - turnStartTime);
          if (ttft !== undefined) timing.ttft_ms = ttft;
        }
        if (pendingThinkingMs !== undefined) {
          // Suppress thinking_ms on the first assistant message when ttft is
          // already on the row — they cover the same interval (turnStart →
          // first text token), within event-dispatch jitter. After the first
          // message, ttft is omitted and thinking_ms takes over.
          const overlapsTtft =
            timing.ttft_ms !== undefined &&
            Math.abs(pendingThinkingMs - timing.ttft_ms) < NOISE_FLOOR_MS;
          const safeThinking = nonNegative(pendingThinkingMs);
          if (!overlapsTtft && safeThinking !== undefined) {
            timing.thinking_ms = safeThinking;
          }
        }
        if (assistantMsgFirstTextTime !== undefined) {
          // Text streaming time — was previously invisible. Captures the
          // model's wall-clock cost of emitting the message body.
          const out = nonNegative(nowAtEnd - assistantMsgFirstTextTime);
          if (out !== undefined) timing.output_ms = out;
        }
        // Attach timing onto the live event so the SSE consumer (frontend)
        // can render badges immediately without waiting for DB reload.
        (evt as Record<string, unknown>).timing = timing;
        if (currentModelRouteMetadata) {
          (evt as Record<string, unknown>).modelRoute = currentModelRouteMetadata;
        }

        // Persist assistant message (skip entirely if it's purely an empty-
        // response marker — keeps the trace free of pi-agent diagnostics)
        if (persist && assistantContent) {
          const cleaned = stripEmptyResponseMarkers(assistantContent);
          if (cleaned.length > 0) {
            const assistantRowContent = redactText(cleaned, redactionConfig);
            const assistantRowMetadata = {
              timing,
              ...(currentModelRouteMetadata ? { model_route: currentModelRouteMetadata } : {}),
            };
            const persistAssistant = async () => {
              // Fold in the context-usage snapshot if agent_end already arrived
              // (the routed/default order — agent_end precedes this commit). The
              // closure reads capturedContextUsage at RUN time, not definition time.
              const rowMetadata = capturedContextUsage
                ? { ...assistantRowMetadata, context_usage: capturedContextUsage }
                : assistantRowMetadata;
              const id = await appendRow({
                sessionId,
                role: "assistant",
                content: assistantRowContent,
                metadata: rowMetadata,
              });
              // Remember the turn's latest assistant row so a later agent_end (the
              // immediate/non-routed order) can patch the snapshot onto its metadata.
              lastAssistantDbMessageId = id;
              lastAssistantContent = assistantRowContent;
              lastAssistantMetadata = rowMetadata;
              await incrementMessageCount(sessionId);
            };
            // Flip the first-assistant flag NOW (not inside the deferred op):
            // ttft_ms is the turn anchor and is computed above from this flag, so
            // a second assistant message_end in the same routed turn must already
            // see it set, even though the op itself may not run until commit. The
            // op-internal flip lagged and let a 2nd deferred row re-emit ttft.
            firstAssistantPersisted = true;
            // On a routed turn the primary streams live before we know it won;
            // defer the durable write to the commit point so a failed primary's
            // reply isn't left in the DB after a fallback takes over.
            if (isRoutingTurn && !routingCommitted) pendingAssistantOps.push(persistAssistant);
            else await persistAssistant();
          }
          assistantContent = "";
        }
        // Reset per-message thinking marker so the next assistant message
        // gets its own measurement (firstTokenTime stays — turn-scoped).
        // Note: lastBoundaryTime is NOT touched here — text deltas already
        // advanced it, and a pure tool-use assistant message (no text)
        // intentionally leaves the boundary at the previous tool/turn-start
        // so the *next* tool's pre-thinking covers the full reasoning gap.
        pendingThinkingMs = undefined;
        assistantMsgFirstTextTime = undefined;
      } else if (message?.role === "toolResult" && lastToolName === "task_report") {
        // task_report via turn_end (alternative emission path)
        const content = message.content;
        const text = typeof content === "string" ? content
          : Array.isArray(content)
            ? (content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("")
            : "";
        if (text) taskReportText = text;
      }
      currentMsgText = "";
      if (message?.role === "toolResult") lastToolName = "";
    }

    // ── Callback for caller-specific logic (WS forwarding, DP tracking, etc.) ──
    if (onEvent) {
      onEvent(evt, eventType, { dbMessageId });
    }

    // Do NOT break on agent_end — the brain may retry (empty-response guard)
    // which emits another agent_start/agent_end cycle. The loop ends naturally
    // when the agentbox closes the SSE stream after prompt() fully resolves.
  }

  // ── Abort finalization ───────────────────────────────────────────────
  // The loop above breaks on `signal.aborted` (L205) the moment the user hits Stop. At that
  // point any tool whose tool_execution_start row was persisted but never got a matching
  // tool_execution_end is left with outcome=null / metadata.status="running" — so it would
  // spin forever in the UI and a history refetch would re-paint it as running. Finalize those
  // rows here as "stopped" (mirroring a background job's stopped representation: outcome stays
  // null, metadata.status="stopped"), and persist any partial assistant text so the words the
  // model already streamed don't vanish on the next refetch.
  if (persist && signal?.aborted) {
    for (const queue of pendingToolCalls.values()) {
      for (const pendingCall of queue) {
        if (!pendingCall.messageId) continue;
        const stoppedMeta: Record<string, unknown> = {
          status: "stopped",
          started_at: new Date(pendingCall.startMs).toISOString(),
        };
        try {
          // updateMessage REPLACES columns (it is not a partial patch), so we must re-send
          // toolName + toolInput or they'd be NULLed — leaving the stopped card with no identity.
          await updateMessage({
            messageId: pendingCall.messageId,
            sessionId,
            content: "",
            toolName: pendingCall.toolName,
            toolInput: pendingCall.input ? redactText(pendingCall.input, redactionConfig) : null,
            outcome: null,
            metadata: stoppedMeta,
          });
        } catch (err) {
          console.warn(`[sse-consumer] ${userId}: failed to finalize aborted tool row ${pendingCall.messageId}:`, err);
        }
      }
    }
    if (assistantContent) {
      const cleaned = stripEmptyResponseMarkers(assistantContent);
      if (cleaned.length > 0) {
        try {
          await appendRow({
            sessionId,
            role: "assistant",
            content: redactText(cleaned, redactionConfig),
            metadata: { incomplete: true },
          });
          await incrementMessageCount(sessionId);
        } catch (err) {
          console.warn(`[sse-consumer] ${userId}: failed to persist partial assistant message on abort:`, err);
        }
      }
      assistantContent = "";
    }
  }

  // Fallback: if no message_end arrived but we have accumulated text
  if (!resultText && currentMsgText) {
    resultText = currentMsgText;
  }

  // Defensive: a routed turn normally ends on success / exhausted / rollback,
  // which already flushed or dropped these. If the stream ends without one
  // (transport drop), flush whatever is still pending so a real answer or a
  // terminal error is not silently lost.
  await flushOps(pendingAssistantOps);
  await flushOps(pendingErrorOps);

  const durationMs = Date.now() - startTime;
  console.log(`[sse-consumer] ${userId} session=${sessionId}: ${eventCount} events, ${durationMs}ms`);

  // Redact secrets from returned text. Tool results and assistant messages
  // are already redacted before being written to chat_messages above, but the
  // return values (resultText / taskReportText / errorMessage) are consumed by
  // task-coordinator / chat-gateway for agent_task_runs.result_text and
  // user-facing notifications, both of which bypass the per-message redaction.
  // Match the per-message redaction to keep the run summary and trace view
  // consistent.
  const cleanedResult = stripEmptyResponseMarkers(taskReportText || resultText);
  const finalResultText = redactText(cleanedResult, redactionConfig);
  return {
    resultText: finalResultText,
    taskReportText: redactText(stripEmptyResponseMarkers(taskReportText), redactionConfig),
    errorMessage: redactText(errorMessage, redactionConfig),
    eventCount,
    durationMs,
  };
}
