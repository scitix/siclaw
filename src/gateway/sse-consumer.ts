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

import { randomUUID } from "node:crypto";
import { AssistantItemStream } from "./assistant-item-stream.js";
import { assistantTextBlocks, type AssistantItem } from "../shared/assistant-items.js";
import type { ChatMessageMetadata } from "../shared/message-kinds.js";
import { persistableToolDetails, toolResultOutcome } from "../shared/tool-result-metadata.js";
import { ErrorCodes } from "../lib/error-envelope.js";
import { AgentBoxClient } from "./agentbox/client.js";
import { appendMessage, incrementMessageCount, updateMessage } from "./chat-repo.js";
import { redactText, type RedactionConfig } from "./output-redactor.js";
import {
  appendKnowledgeSourceCitations,
  knowledgeCitationsMetadata,
  normalizeKnowledgeSourceCitations,
  type KnowledgeSourceCitation,
} from "../shared/knowledge-citations.js";
import { llmCallFromMessage, type LlmCallEnvelope } from "../core/llm-call-recorder.js";
import {
  buildThinkingRow,
  eventClock,
  isModelCallRowEnvelope,
  LlmCallTimeline,
  redactLlmCallEnvelope,
  toolDurationMs,
} from "./llm-call-rows.js";

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

/**
 * What a turn stops saying once it has handed the conversation away — see the
 * cut in the event loop.
 *
 * Everything here is OUTPUT: it is rendered to the person watching, or written
 * to the transcript, or both. Everything NOT here is turn lifecycle
 * (`agent_start` / `agent_end` / `turn_end` / `agent_settled`, the routing
 * events, compaction and retry) and must keep flowing: those are what the
 * client balances its "still working" state on, and swallowing one leaves the
 * spinner running under an answer that already arrived.
 */
const HANDOFF_MUTED_EVENT_TYPES = new Set([
  "message_start",
  "message_update",
  "message_end",
  "tool_start",
  "tool_execution_start",
  "agent_message",
  "knowledge_sources",
]);

/**
 * ⚠️ CLOSERS ARE NOT MUTED BY TYPE. Muting an event that CLOSES something the
 * client already drew leaves that thing open forever, and the client reads
 * "something is still open" as "the agent is still working".
 *
 * That is exactly how the previous version of this cut broke:
 * `transfer_to_agent` emits `handoff_requested` from inside its own execute(),
 * so its `tool_execution_end` lands AFTER the flag is set — it was muted, the
 * transfer's tool row stayed `running` for good, and the spinner ran forever
 * underneath the finished answer.
 *
 * So a closer is muted only when THIS cut also hid its opener (see
 * `mutedToolCalls`); a closer for a tool that started before the handoff goes
 * out. Letting an unmatched one through would be worse than noise: the console
 * attaches a result with no matching row to the last still-running tool.
 */
const HANDOFF_PAIRED_CLOSERS = new Set([
  "tool_end",
  "tool_execution_update",
  "tool_execution_end",
]);

export interface ConsumeAgentSseOptions {
  client: Pick<AgentBoxClient, "streamEvents"> & { readonly conversationEvents?: boolean };
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
  /**
   * Called when the box starts processing a user message it was given.
   *
   * This echo is the only place the PROCESSING order of user input is observable: a steer
   * is written down the moment it arrives, but the box consumes it at a turn boundary that
   * may be seconds later, and a user typing faster than the model answers would otherwise
   * leave every question ordered before every answer. Fired for the turn's opening prompt
   * as well as for each steer, so one rule covers every user row.
   */
  onUserMessageStarted?: (echoedText: string) => void | Promise<void>;
  /** Abort signal — breaks the loop when triggered. */
  signal?: AbortSignal;
  /**
   * per-prompt root trace id (from the /api/prompt ack). Stamped onto every
   * assistant/tool row this consumer persists so a whole interaction's agent
   * output shares one trace_id in chat_messages. Absent → rows keep NULL.
   */
  traceId?: string;
  /** Control-plane logical turn identity, shared by all items in this execution. */
  turnId?: string;
  /**
   * The agent that RAN this turn, stamped onto every assistant/tool row.
   *
   * Only interesting once a session can change hands: a handed-over session's
   * transcript is a single conversation answered by two different agents, and
   * this column is the only thing that says which turn was whose. Without it an
   * operator reading the transcript — or an analysis pass attributing a bad
   * answer — sees one undifferentiated stream under the facade's name.
   *
   * Absent → rows keep NULL, which is what every pre-handoff caller wants: the
   * session's own agent_id already answers the question when nothing moved.
   */
  agentId?: string;
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
 * Strip pi-agent's `(Empty response: {...})` diagnostic markers that get
 * appended to an assistant message when the model returns content=[]. These
 * are useful in server logs but pollute the persisted trace shown to users.
 * Match uses greedy balanced-brace detection inside the wrapper.
 */
function stripEmptyResponseMarkers(text: string): string {
  return text.replace(/\s*\(Empty response:\s*\{[\s\S]*?\}\)\s*/g, "").trimEnd();
}

/**
 * Whether an assistant `message_end` actually delivered something.
 *
 * Used to decide that an internal retry RECOVERED an earlier failure. A
 * non-error `stopReason` alone does not mean that: an empty 200 arrives as
 * `stop` with zero content blocks (pi retries exactly this), and a Stop arrives
 * as `aborted`. Treating either as recovery erases the provider's verdict.
 */
export function messageProducedOutput(message: Record<string, unknown>): boolean {
  if (message.stopReason === "error" || message.stopReason === "aborted") return false;
  const content = message.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return (content as Array<{ type?: string; text?: string }>).some(
    (c) => c?.type === "toolCall" || (c?.type === "text" && (c.text ?? "").trim().length > 0),
  );
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

export function modelRouteSwitchMetadata(evt: SseEvent, redactionConfig: RedactionConfig): ChatMessageMetadata | null {
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

function modelRouteRecoveryMetadata(evt: SseEvent): ChatMessageMetadata | null {
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

export function modelRouteNoticeContent(metadata: Record<string, unknown>): string {
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
  /** Toolset captured at start; stable even when parallel calls end out of order. */
  toolset?: string;
  /** Raw JSON of the call args (unredacted — redacted at write time). */
  input: string;
  /** Agentbox-clock start, when the runtime stamped one. Pairs with `endedAt`. */
  startedAt?: number;
  /** Gateway-clock start. Always set, and the fallback both ends fall back to together. */
  localStartMs: number;
  /** What `metadata.started_at` reports: the agentbox stamp when there is one. */
  startMs: number;
  /** DB row id of the eagerly-persisted "running" placeholder (persist mode only). */
  messageId?: string;
  /** `llm_round` / `tool_call_id` captured at start; re-stamped at end (updateMessage replaces metadata). */
  roundMeta: Record<string, unknown>;
}

/** Pairing key for a tool_execution_start/end pair: the invocation-unique
 *  toolCallId when the event carries one, else the tool name (FIFO fallback). */
function toolCallKey(evt: Record<string, unknown>, toolName: string): string {
  const id = evt.toolCallId;
  return typeof id === "string" && id ? id : toolName;
}

export async function consumeAgentSse(opts: ConsumeAgentSseOptions): Promise<SseConsumptionResult> {
  const { client, sessionId, userId, onEvent, onUserMessageStarted, signal } = opts;
  const persist = opts.persistMessages === true;
  const redactionConfig = opts.redactionConfig ?? EMPTY_REDACTION;
  // Stamp this turn's root trace id onto every persisted row. traceId is constant
  // for the whole consume run (one prompt = one root trace), so one wrapper covers
  // all append sites; updateMessage is untouched (rows are stamped at append time).
  const appendRow = (input: Parameters<typeof appendMessage>[0]) =>
    appendMessage({
      ...input,
      traceId: opts.traceId ?? null,
      // Who answered this turn. See ConsumeAgentSseOptions.agentId — the only
      // record of that once a session can be handed to another agent.
      fromAgentId: input.fromAgentId ?? opts.agentId ?? null,
    });

  let assistantContent = "";
  let currentMsgText = "";
  let resultText = "";
  let taskReportText = "";
  let errorMessage = "";
  /**
   * The error to show for this turn, or null when there isn't one (yet).
   *
   * Buffered rather than emitted on sight. pi-agent retries internally, so a
   * turn can produce several error `message_end`s; the FIRST one is the least
   * informative — it is typically the transport giving up ("Request timed
   * out.") while the retry that follows carries the provider's actual verdict
   * ("unsupported_protocol"). Emitting on sight showed the operator the timeout
   * and dropped the verdict. Buffering also means a retry that SUCCEEDS leaves
   * no error bubble at all, instead of a red bubble sitting above the answer.
   */
  let pendingStreamError: string | null = null;
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
  let pendingKnowledgeSources: unknown = null;
  // Keep the registered union until the user turn ends. Each independently
  // delivered answer needs its sources even if an earlier message cited them.
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
    pendingStreamError = null;
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
  /**
   * Emit the buffered error and write its row. Idempotent, and called from the
   * loop's `finally` as well as the normal tail so a mid-stream throw still
   * leaves the operator with an explanation and a row that survives reload.
   */
  const flushTerminalError = async () => {
    // Assistant rows first: on a failed routed turn both can be pending, and a
    // partial reply belongs above the error that ended it, not below.
    //
    // Called at every TURN boundary, not just at the end of the stream. One
    // request can carry several independent turns — a user who steers while the
    // agent is working adds a question to the run in flight — and the
    // suppression this buffering exists for ("an internal retry recovered it,
    // leave nothing behind") is only ever true WITHIN one turn. Held to the end
    // of the request instead, a later turn succeeding would erase the failures
    // of every earlier one, and those turns would reload as questions with no
    // answers and no explanation.
    await flushOps(pendingAssistantOps);
    if (onEvent && pendingStreamError) {
      onEvent(
        {
          type: "stream_error",
          error: { code: ErrorCodes.MODEL_ERROR, message: pendingStreamError, retriable: true },
        },
        "stream_error",
        {},
      );
    }
    pendingStreamError = null;
    await flushOps(pendingErrorOps);
  };
  const discardRoutedAttempt = () => {
    pendingAssistantOps.length = 0;
    pendingErrorOps.length = 0;
    pendingFailedLlmCalls = [];
    pendingKnowledgeSources = null;
    pendingStreamError = null;
    errorMessage = "";
  };
  let lastToolName = "";

  // ── LLM-call timeline bookkeeping ──
  // timeline: value-based envelope dedup plus the latest agent-loop round,
  //   stamped onto the tool rows it issued (metadata.llm_round). pi-agent emits
  //   message_end before that turn's tool_execution_start, so "latest" is right.
  // attemptLlmCalls: envelopes of the model calls made by the routing attempt
  //   in flight. A failed attempt's rows are dropped (rollback / never
  //   committed), but the calls happened and their time is real — they are
  //   carried onto the model_route_notice row as `discarded_llm_calls` instead.
  // pendingFailedLlmCalls: in-turn provider retries are revocable as user-facing
  //   errors, but their calls still belong in the timing timeline. They are
  //   written as empty model-call rows if a later retry recovers, or all but the
  //   final one are written before the terminal error row.
  const timeline = new LlmCallTimeline();
  let attemptLlmCalls: LlmCallEnvelope[] = [];
  let pendingFailedLlmCalls: LlmCallEnvelope[] = [];
  const takeDiscardedLlmCalls = (): LlmCallEnvelope[] | undefined => {
    if (attemptLlmCalls.length === 0) return undefined;
    const drained = attemptLlmCalls;
    attemptLlmCalls = [];
    return drained;
  };
  const persistCallOnlyRows = async (envelopes: LlmCallEnvelope[]) => {
    for (const envelope of envelopes) {
      await appendRow({
        sessionId,
        role: "assistant",
        content: "",
        metadata: { llm_call: redactLlmCallEnvelope(envelope, (text) => redactText(text, redactionConfig)) },
      });
    }
  };
  const commitRecoveredLlmCalls = async () => {
    const recovered = pendingFailedLlmCalls;
    pendingFailedLlmCalls = [];
    if (recovered.length === 0 || !persist) return;
    const op = () => persistCallOnlyRows(recovered);
    if (isRoutingTurn && !routingCommitted) pendingAssistantOps.push(op);
    else await op();
  };

  // In-flight tool calls awaiting their tool_execution_end. Keyed by the
  // event's toolCallId (stable per invocation): pi-agent runs a same-turn tool
  // batch in PARALLEL, so ends arrive in completion order, not start order —
  // name-FIFO pairing writes call A's result into call B's row (and stamps the
  // wrong dbMessageId on the relayed event, so the live card cross-attaches
  // too). Events lacking a toolCallId fall back to a per-toolName FIFO queue.
  const pendingToolCalls = new Map<string, PendingToolCall[]>();

  let eventCount = 0;
  const startTime = Date.now();

  // Latest persisted assistant message of the turn — so the `agent_end`
  // context-usage snapshot can be merged onto its metadata. Persisting the
  // snapshot lets the frontend restore the context meter when a session is
  // reopened/refreshed (it otherwise only has it from a live agent_end, which a
  // cold session never replays). Overwritten on each assistant message_end, so
  // by agent_end these point at the turn's final assistant message.
  let assistantEndedInStep = false;
  const assistantItems = new AssistantItemStream();
  const itemTurnId = opts.turnId ?? opts.traceId ?? randomUUID();
  const startedItems = new Set<string>();
  const emitItem = (item: AssistantItem, completed: boolean, dbId?: string, delta?: string, metadata?: Record<string, unknown>) => {
    const type = delta !== undefined ? "item/agentMessage/delta" : completed ? "item/completed" : "item/started";
    const scope = { threadId: sessionId, turnId: itemTurnId, itemId: item.id };
    if (!startedItems.has(item.id) && type !== "item/started") {
      onEvent?.({ type: "item/started", ...scope, sequence: 0,
        item: { type: "agentMessage", id: item.id, text: "", phase: item.phase } }, "item/started", {});
    }
    startedItems.add(item.id);
    onEvent?.({ type, ...scope, sequence: item.sequence, ...metadata,
      ...(delta !== undefined ? { delta: redactText(delta, redactionConfig) } : {}),
      ...(delta === undefined ? { item: { type: "agentMessage", id: item.id, text: redactText(item.text, redactionConfig), phase: item.phase } } : {}),
      assistantItem: { ...item, text: undefined },
    }, type, { dbMessageId: dbId });
  };
  let lastAssistantDbMessageId: string | undefined;
  let lastAssistantContent: string | undefined;
  let lastAssistantMetadata: Record<string, unknown> | undefined;
  // Latest agent_end context-usage snapshot of the turn. agent_end fires BEFORE
  // model_route_success (the commit point that runs the deferred assistant
  // persist on routed turns — i.e. every turn), so the assistant row usually
  // isn't written yet when agent_end arrives. We therefore stash the snapshot
  // here and let the deferred persistAssistant fold it into the row's metadata.
  let capturedContextUsage: Record<string, unknown> | undefined;
  /** This turn handed the conversation away; see the cut inside the loop. */
  let handoffRequested = false;
  /** Tool invocations whose START this cut hid, so their END is hidden too. */
  const mutedToolCalls = new Set<string>();
  let latestModelRouteSwitch: Record<string, unknown> | null = null;
  let currentModelRouteMetadata: Record<string, unknown> | null = null;
  // try/finally, not a bare fall-through: the terminal error is BUFFERED
  // (last one wins), so a stream that dies mid-turn — pod recycled, transport
  // dropped — would otherwise take the operator's only explanation of the
  // failure with it, and leave no row for the reload either.
  try {
    for await (const event of client.streamEvents(sessionId, { signal })) {
      if (signal?.aborted) break;

      const evt = { ...event as SseEvent };
      // Always a string: tool-pushed extra events (e.g. task_event, which carries
      // `kind` not `type`) have no `type`. A bare `eventType.includes(...)` on
      // undefined would throw and kill the whole SSE stream (STREAM_INTERRUPTED).
      const eventType = (evt.type as string | undefined) ?? "";
      eventCount++;

      // ── After a handoff, this agent's turn is over ────────────────────────
      //
      // `transfer_to_agent` is terminal BY CONTRACT, and its result text tells
      // the model to stop. A model does not have to obey, and observed in the
      // test environment it did not: after handing the conversation away the
      // facade retried the tool that had just failed, ran another one, and wrote
      // a paragraph concluding "the transfer seems broken, it came back to me".
      // That paragraph then reached the user AHEAD of the answer the receiving
      // agent was already producing — the exact opposite of the one-continuous-
      // answer property the whole design exists for — and, worse, it was
      // PERSISTED, so every later turn would read it as history.
      //
      // So the cut is made here rather than trusted to the prompt: once this
      // turn has asked for a handoff, nothing more from it is relayed or
      // written. `handoff_requested` itself still passes (the flag is set after
      // this check) — the control plane reads it to decide where the next hop
      // goes. `prompt_done` is unaffected: it is emitted by server.ts once this
      // consumer returns, not through this loop, so the chain still gets its
      // signal to dispatch.
      //
      // Not a fix for the wasted tokens: the box keeps running until its turn
      // ends on its own. Stopping the brain itself is the follow-up.
      //
      // ⚠️ CONTENT only. The first version of this cut dropped EVERYTHING and
      // took the abandoned turn's `agent_end` with it, leaving the frontend one
      // `agent_start` it never saw closed — the answer arrived and the "still
      // working" spinner stayed on it forever. The turn-lifecycle events are the
      // client's state machine, not output: they have to stay balanced whether
      // or not anybody is listening to what the agent says.
      if (handoffRequested) {
        const evtRec = evt as Record<string, unknown>;
        const pairKey = () => toolCallKey(evtRec, String(evtRec.toolName ?? ""));
        if (HANDOFF_MUTED_EVENT_TYPES.has(eventType)) {
          if (eventType === "tool_execution_start" || eventType === "tool_start") {
            mutedToolCalls.add(pairKey());
          }
          continue;
        }
        if (HANDOFF_PAIRED_CLOSERS.has(eventType) && mutedToolCalls.has(pairKey())) {
          continue;
        }
      }
      if (eventType === "handoff_requested") handoffRequested = true;
      if (eventType === "agent_switch") {
        // A logical channel/task stream continues on an independent executor.
        // Its final result must never fall back to the previous agent's progress.
        handoffRequested = false;
        assistantContent = currentMsgText = resultText = taskReportText = "";
        assistantItems.begin();
        pendingKnowledgeSources = null;
      }

      // A ConversationClient observes output already rendered by the owning
      // runtime. Re-registering its sources would append them a second time
      // when scheduled tasks consume the forwarded message_end.
      if (eventType === "knowledge_sources" && !client.conversationEvents) {
        pendingKnowledgeSources = (evt as Record<string, unknown>).sources;
      }

      // Log lifecycle events
      if (
        eventType === "agent_start" || eventType === "agent_end" ||
        eventType === "message_end" || eventType === "message_start" ||
        eventType.includes("error")
      ) {
        console.log(`[sse-consumer] ${userId}: ${eventType}`, JSON.stringify(event).slice(0, 300));
      }

      // Internal child-result prompts continue the same request. They are not
      // user steers, do not reset citation state, and must never become bubbles.
      if (evt.internalMessage === true && (evt.message as { role?: string } | undefined)?.role === "user") continue;

      let dbMessageId: string | undefined;
      if (eventType === "turn_start" || (eventType === "message_start" &&
          (evt.message as { role?: string } | undefined)?.role === "assistant")) assistantItems.begin();
      if (eventType === "message_update") {
        const update = evt.assistantMessageEvent as Record<string, unknown> | undefined;
        if (update) {
          const output = assistantItems.update(update);
          if (output) {
            evt.nativeItems = true;
            if ((evt.awaitingBackgroundJobs === true || evt.awaitingSubagents === true)) output.item.phase = "commentary";
            emitItem(output.item, Boolean(output.completed), undefined, output.delta);
          }
        }
      }

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
        // A new attempt sequence starts here, so nothing from a previous turn may
        // ride its switch notice. ONE consume run carries several turns (a steer
        // reuses it — see the deferral note below), and attemptLlmCalls used to be
        // cleared only on model_route_success: a turn whose final attempt FAILED
        // left its envelope behind, already persisted on that turn's error row,
        // and the next steered turn's rollback drained it into that turn's
        // discarded_llm_calls — persisted twice, attributed to the wrong turn.
        attemptLlmCalls = [];
        // Defer only when there is something to roll back TO. Since every prompt runs
        // through the routing entry, a turn with one candidate emits these events too —
        // and deferring there buys nothing (a rollback is only ever emitted before a
        // switch) while costing message ORDER: the turn's assistant replies all land at
        // the commit point, so a conversation the user steered several times reloads as
        // every question followed by every answer, instead of the alternation they saw.
        const candidateCount = Number((evt as { candidateCount?: unknown }).candidateCount ?? 0);
        isRoutingTurn = candidateCount > 1;
        routingCommitted = false;
        discardRoutedAttempt();
      }

      if (eventType === "model_route_switch") {
        const metadata = modelRouteSwitchMetadata(evt, redactionConfig);
        if (metadata) {
          latestModelRouteSwitch = metadata;
          // The failed attempt's model calls ride on the notice row: their rows
          // were (or will be) discarded, but the time they took is part of the
          // prompt's timeline and the survivor's since_prev_ms spans it.
          const discarded = [...(takeDiscardedLlmCalls() ?? []), ...((evt.discardedLlmCalls as LlmCallEnvelope[] | undefined) ?? [])];
          if (discarded.length > 0) {
            metadata.discarded_llm_calls = discarded.map((call) =>
              redactLlmCallEnvelope(call, (text) => redactText(text, redactionConfig))
            );
          }
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
        // The winning attempt's calls are persisted on their own rows.
        attemptLlmCalls = [];
      }

      // ── Model route: exhausted commits the final attempt's output + error;
      //    rollback discards a failed live primary before the next candidate. ──
      if (eventType === "model_route_exhausted") {
        routingCommitted = true;
        // Terminal: the final attempt's calls ride the error row this commits, so
        // they must not also be left for a later turn's notice to pick up. NOT in
        // discardRoutedAttempt — a rollback's calls are exactly what the following
        // switch notice is supposed to carry.
        attemptLlmCalls = [];
        await flushOps(pendingAssistantOps);
        await flushOps(pendingErrorOps);
      }
      if (eventType === "model_route_rollback") {
        discardRoutedAttempt();
        routingCommitted = false;
      }

      // ── DB persistence: tool_execution_end ──────────
      if (eventType === "tool_execution_end" || eventType === "tool_end") {
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

        const outcome = toolResultOutcome(toolResult?.details, evt.isError);

        const pendingCall = shiftPending(pendingToolCalls, toolCallKey(evt, toolName));
        const eventToolset = typeof evt.toolset === "string" && evt.toolset.length > 0
          ? evt.toolset
          : undefined;
        const toolset = pendingCall?.toolset ?? eventToolset;
        if (toolset) evt.toolset = toolset;
        // Both ends on ONE clock — the agentbox's when the runtime stamped both,
        // which is also the llm_call envelope's clock so tool bars and call bars
        // line up in the parallel view.
        const durationMs = pendingCall
          ? toolDurationMs(pendingCall, eventClock(evt, "endedAt"))
          : undefined;
        if (durationMs != null) {
          (evt as Record<string, unknown>).durationMs = durationMs;
        }
        const toolInput = pendingCall?.input || "";
        const existingMessageId = pendingCall?.messageId;
        const detailsMeta = persistableToolDetails(toolResult?.details, value => redactText(value, redactionConfig));
        // Forward the same bounded, redacted preview to the UI. A downgrade is
        // visible during this turn and cannot fall back to unredacted JSON text.
        if (toolResult?.details?.skillPreview && detailsMeta?.skillPreview) {
          toolResult.details.skillPreview = detailsMeta.skillPreview;
          if ((detailsMeta.skillPreview as { status?: string }).status === "omitted") {
            toolResult.content = [{ type: "text", text: "Skill preview omitted from history: size or redaction limit." }];
          }
        }
        // Re-stamp the round markers — persistableToolDetails only looks at
        // the tool *result*, and updateMessage REPLACES metadata wholesale.
        const roundMeta = pendingCall?.roundMeta ?? timeline.toolMetadata(evt);
        const merged: Record<string, unknown> = { ...(detailsMeta ?? {}), ...roundMeta };
        // started_at survives onto the final row (it did not before: updateMessage
        // replaces metadata) so the parallel view can place the bar without a join.
        if (pendingCall) merged.started_at = new Date(pendingCall.startMs).toISOString();
        const metadata: Record<string, unknown> | null = Object.keys(merged).length > 0 ? merged : null;
        const metadataWithRoute = attachModelRouteMetadata(metadata, currentModelRouteMetadata);
        const delegationId = typeof metadata?.delegation_id === "string" ? metadata.delegation_id : null;

        if (persist) {
          const payload = {
            sessionId,
            content: redactText((detailsMeta?.skillPreview as { status?: string } | undefined)?.status === "omitted" ? "Skill preview omitted from history: size or redaction limit." : text, redactionConfig),
            toolName,
            toolset: toolset ?? null,
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
      }

      // ── DB persistence: message_update (accumulate assistant text) ──
      if (eventType === "message_update") {
        const ame = evt.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (ame?.type === "text_delta" && ame.delta) {
          assistantContent += ame.delta;
          currentMsgText += ame.delta;
        }
      }

      // ── message_start: reset per-message accumulator ──
      if (eventType === "message_start") {
        currentMsgText = "";
        const message = evt.message as Record<string, unknown> | undefined;
        if (message?.role === "user") {
          // A new user input means the PREVIOUS turn is over and nothing inside
          // it recovered — commit its error before this turn's events arrive, so
          // it lands above the question that follows it rather than being
          // cleared by that question's answer.
          //
          // This echo is the boundary rather than pi's `turn_end`, which fires
          // once per LLM round-trip: a turn that calls tools emits several, and
          // flushing on those would defeat the in-turn suppression entirely.
          await flushTerminalError();
          // Retire the previous turn's source union so stale references never
          // leak onto an answer to the new user input.
          pendingKnowledgeSources = null;
        }
        if (message?.role === "user" && onUserMessageStarted) {
          // The echoed text, so the caller can check the echo against the row it expects —
          // the box wraps what it was given, so this is a guard, never an identity.
          const echoed = Array.isArray(message.content)
            ? (message.content as Array<{ type?: string; text?: string }>)
                .filter((part) => part?.type === "text" && typeof part.text === "string")
                .map((part) => part.text as string).join("")
            : "";
          // Never let bookkeeping break the stream the user is watching.
          try {
            await onUserMessageStarted(echoed);
          } catch (err) {
            console.warn(`[sse-consumer] ${userId}: failed to mark user message as started:`, err);
          }
        }
      }

      // ── tool_execution_start: capture input + start time ──
      if (eventType === "tool_execution_start" || eventType === "tool_start") {
        // First tool execution commits the routed turn (fallback is now blocked):
        // flush any assistant text deferred before this point so the tool row
        // lands after it in the transcript.
        if (isRoutingTurn && !routingCommitted) await commitRoutedTurn();
        const stampedStart = eventClock(evt, "startedAt");
        const localStartMs = Date.now();
        // started_at reports the agentbox stamp when there is one — that is the
        // clock the parallel view places bars on — and the local clock only as a
        // last resort. The DURATION never mixes the two; see toolDurationMs.
        const nowAtStart = stampedStart ?? localStartMs;
        const startToolName = (evt.toolName as string) || (evt.name as string) || "tool";
        const args = evt.args as Record<string, unknown> | undefined;
        const rawToolInput = args ? JSON.stringify(args) : "";
        // Which model call issued this tool: the latest round. Captured at start
        // so the end handler re-stamps the same markers after a rollback rewinds
        // the round counter.
        const roundMeta = timeline.toolMetadata(evt);
        const pendingCall: PendingToolCall = {
          toolName: startToolName,
          ...(typeof evt.toolset === "string" && evt.toolset.length > 0 ? { toolset: evt.toolset } : {}),
          input: rawToolInput,
          startedAt: stampedStart,
          localStartMs,
          startMs: nowAtStart,
          roundMeta,
        };
        pushPending(pendingToolCalls, toolCallKey(evt, startToolName), pendingCall);
        lastToolName = startToolName;
        if (roundMeta.llm_round !== undefined) {
          (evt as Record<string, unknown>).llmRound = roundMeta.llm_round;
        }

        if (persist) {
          const startMetadata: Record<string, unknown> = {
            status: "running",
            started_at: new Date(nowAtStart).toISOString(),
            ...roundMeta,
          };
          const startMetadataWithRoute = attachModelRouteMetadata(startMetadata, currentModelRouteMetadata);
          dbMessageId = await appendRow({
            sessionId,
            role: "tool",
            content: "",
            toolName: startToolName,
            toolset: pendingCall.toolset ?? null,
            toolInput: rawToolInput ? redactText(rawToolInput, redactionConfig) : null,
            outcome: null,
            durationMs: null,
            metadata: startMetadataWithRoute,
          });
          pendingCall.messageId = dbMessageId;
          await incrementMessageCount(sessionId);
        }
      }

      // Pi repeats the completed assistant on turn_end, after message_end and
      // tool results. Only use turn_end as a fallback when this step had no
      // message_end. Content equality cannot distinguish legitimate repeated answers.
      if (eventType === "turn_start") assistantEndedInStep = false;
      const duplicateTurnEnd = eventType === "turn_end" && assistantEndedInStep;
      if (eventType === "message_end" && (evt.message as any)?.role === "assistant") assistantEndedInStep = true;
      if (eventType === "turn_end") assistantEndedInStep = false;

      // ── message_end / turn_end: persist assistant message + extract result ──
      if (eventType === "message_end" || (eventType === "turn_end" && !duplicateTurnEnd)) {
        const message = evt.message as Record<string, unknown> | undefined;
        if (message?.role === "assistant") {
          // ── LLM-call envelope: the timing source of truth ──
          // Stamped by LlmCallRecorder at the streamFn boundary. message_end and
          // turn_end arrive as separately parsed JSON values, so the shared
          // timeline deduplicates by envelope values rather than object identity.
          // Aux (compaction) calls ride the next agent call's `aux_calls`.
          const rawEnvelope = llmCallFromMessage(message);
          const envelope = timeline.take(message);
          if (envelope) {
            if (isRoutingTurn && !routingCommitted) attemptLlmCalls.push(envelope);
            // Surface on the live event so the frontend renders badges immediately.
            (evt as Record<string, unknown>).llmCall = envelope;
          }

          // Capture model-level errors (e.g. API 404, rate-limit) and surface
          // them upstream as a single stream_error event so the proxy/frontend
          // can render an inline error bubble instead of silently stopping.
          // ONE bubble per run — pi-agent retries internally — and it is the LAST
          // error, not the first: see pendingStreamError.
          if (message.stopReason === "error" && message.errorMessage) {
            errorMessage = String(message.errorMessage);
            // Last one wins — see pendingStreamError. Flushed at the end of the
            // run, or dropped if a later attempt succeeds.
            pendingStreamError = errorMessage;
            // Persist the error as its own DB row so it survives a page refresh
            // or session re-open. The live frontend error bubble is client-only
            // (role="error", no DB row) and is dropped once history reloads from
            // the DB — without this row a failed turn reloads as just the user
            // message. The motivating case is model-routing exhausting during
            // setup: it emits a synthetic error message_end with EMPTY content,
            // so the assistantContent persist path below skips it entirely and
            // nothing about the failure reaches the database. One row per consume
            // run, carrying the LAST error — the reload must not disagree with
            // the bubble the operator was just looking at.
            // pi-agent emits the same failed assistant message through both
            // message_end and turn_end. The timeline consumes its envelope on
            // the first event; replacing the buffered write on the duplicate
            // would therefore throw away the terminal call's llm_call.
            if (persist && (!rawEnvelope || envelope)) {
              const errorContent = redactText(errorMessage, redactionConfig);
              // Failed calls remain timing facts even though their user-facing
              // error is revocable. If a retry recovers they become empty call
              // rows; if the turn fails, the final call rides the error row.
              if (envelope) pendingFailedLlmCalls.push(envelope);
              const persistError = async () => {
                const failedCalls = pendingFailedLlmCalls;
                pendingFailedLlmCalls = [];
                const errorEnvelope = envelope;
                await persistCallOnlyRows(errorEnvelope ? failedCalls.slice(0, -1) : failedCalls);
                await appendRow({
                  sessionId,
                  role: "assistant",
                  content: errorContent,
                  metadata: {
                    kind: "error_response",
                    error_code: ErrorCodes.MODEL_ERROR,
                    retriable: true,
                    ...(errorEnvelope
                      ? { llm_call: redactLlmCallEnvelope(errorEnvelope, (text) => redactText(text, redactionConfig)) }
                      : {}),
                  },
                });
                await incrementMessageCount(sessionId);
              };
              // Buffered for every turn, not just routed ones: an internal retry
              // can still turn this failure into a success, and a row written on
              // sight would leave a stale error above the answer on reload. The
              // routing commit/rollback paths already clear this list, and so
              // does a successful assistant message below.
              pendingErrorOps.length = 0;
              pendingErrorOps.push(persistError);
            }
          } else if (pendingStreamError && messageProducedOutput(message)) {
            // A later attempt produced a real assistant turn: the earlier failure
            // was transient and must leave no visible error bubble or error row, and
            // nothing in the returned summary that a notification could quote.
            //
            // "Real" means it actually carried output. A non-error stopReason is
            // NOT enough: pi surfaces an empty 200 as stopReason "stop" with zero
            // content blocks (the case its own retry loop exists for), and an
            // aborted turn as "aborted". Clearing on those would erase the
            // provider's verdict and report the turn as a success — which
            // delegation and cron both read as ok, with empty text.
            pendingStreamError = null;
            pendingErrorOps.length = 0;
            errorMessage = "";
            await commitRecoveredLlmCalls();
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
          let rowCitations: KnowledgeSourceCitation[] = [];
          let citationContentIndex: number | undefined;
          const textBlocks = assistantTextBlocks(message);
          const answerBlock = [...textBlocks].reverse().find(block => block.phase !== "commentary" && block.text.trim());
          const isProgress = message.stopReason === "toolUse" || evt.awaitingBackgroundJobs === true || evt.awaitingSubagents === true;
          if (pendingKnowledgeSources && message.stopReason !== "error" && !isProgress &&
              (answerBlock || textBlocks.length === 0)) {
            const base = answerBlock?.text || extracted || currentMsgText || assistantContent;
            if (base.trim()) {
              rowCitations = normalizeKnowledgeSourceCitations(pendingKnowledgeSources);
              if (rowCitations.length > 0) {
                const cited = appendKnowledgeSourceCitations(base, rowCitations);
                citationContentIndex = answerBlock?.index ?? 0;
                if (Array.isArray(message.content) && answerBlock) {
                  message.content = message.content.map((part, index) =>
                    index === answerBlock.index ? { ...part, text: cited } : part);
                } else message.content = cited;
                extracted = assistantTextBlocks(message).map(block => block.text).join("");
              }
            }
          }
          // Some providers only deliver text on message_end. Persist the complete
          // message rather than relying on earlier deltas being present.
          assistantContent = extracted || assistantContent;
          const completedItems = assistantItems.complete(message);
          if ((evt.awaitingBackgroundJobs === true || evt.awaitingSubagents === true)) {
            for (const item of completedItems) item.phase = "commentary";
          }
          evt.nativeItems = true;
          const answerItems = completedItems.filter(item => item.phase !== "commentary");
          if (answerItems.length) resultText = answerItems.map(item => item.text).join("\n\n");

          // phase 不是 timing:它区分「工具间的旁白」和「最终答复」,前端据此分组。
          const phase = (evt.awaitingBackgroundJobs === true || evt.awaitingSubagents === true) || message.stopReason === "toolUse" ||
            (completedItems.length > 0 && completedItems.every(item => item.phase === "commentary")) ? "commentary" : "final_answer";
          (evt as Record<string, unknown>).phase = phase;
          // Provider phase is item-level. Unknown is not a guessed final answer.
          for (const item of completedItems) emitItem(item, true, undefined, undefined,
            currentModelRouteMetadata ? { modelRoute: currentModelRouteMetadata } : {});
          if (currentModelRouteMetadata) {
            (evt as Record<string, unknown>).modelRoute = currentModelRouteMetadata;
          }

          // ── 落库:按 assistant item 分行,这一轮调用的账挂在第一行 ──
          // 上游按「一次模型调用一行 + 一条 thinking 行」落库,本分支按「一个
          // assistant item 一行」落库 —— 同一批文本的两种切法。合并规则:行按 item
          // 切,envelope / model_route 只挂第一行(一轮调用只结算一次账),
          // 没产出任何文本的纯工具轮仍然留一条空行来承载 envelope。
          const rowEnvelope = isModelCallRowEnvelope(envelope, message.stopReason)
            ? redactLlmCallEnvelope(envelope, (text) => redactText(text, redactionConfig))
            : undefined;
          const itemRows = completedItems
            .map((item) => ({ item, cleaned: stripEmptyResponseMarkers(item.text) }))
            .filter((row) => row.cleaned.length > 0);
          if (persist && (itemRows.length > 0 || rowEnvelope)) {
            const thinkingRow = rowEnvelope
              ? buildThinkingRow(message, rowEnvelope, (text) => redactText(text, redactionConfig))
              : null;
            const headMetadata: Record<string, unknown> = {
              ...(rowEnvelope ? { llm_call: rowEnvelope } : {}),
              ...(!rowEnvelope && envelope && envelope.round > 0 ? { llm_round: envelope.round } : {}),
              ...(currentModelRouteMetadata ? { model_route: currentModelRouteMetadata } : {}),
            };
            const citationMetadata = rowCitations.length > 0
              ? { knowledge_citations: knowledgeCitationsMetadata(rowCitations) } : {};
            const rows: { content: string; item?: AssistantItem; metadata: Record<string, unknown> }[] =
              itemRows.length > 0
                ? itemRows.map(({ item, cleaned }, index) => ({
                    content: redactText(cleaned, redactionConfig),
                    item,
                    metadata: {
                      ...(index === 0 ? headMetadata : {}),
                      ...(item.contentIndex === citationContentIndex ? citationMetadata : {}),
                      phase: item.phase ?? phase,
                      assistant_item: { ...item, text: undefined, status: "completed" },
                    } as Record<string, unknown>,
                  }))
                : [{ content: "", metadata: { ...headMetadata, phase } }];
            const persistAssistant = async () => {
              // Thinking first: it happened before the answer, and seq order is
              // the timeline. Bounded and redacted by buildThinkingRow.
              if (rowEnvelope && thinkingRow) {
                try {
                  const thinkingRowId = await appendRow({ sessionId, role: "assistant", ...thinkingRow });
                  rowEnvelope.thinking_row_id = thinkingRowId;
                  await incrementMessageCount(sessionId);
                } catch (err) {
                  console.warn(`[sse-consumer] thinking row persistence failed for ${sessionId}:`, err);
                }
              }
              for (const row of rows) {
                // Fold in the context-usage snapshot if agent_end already arrived
                // (the routed/default order — agent_end precedes this commit). The
                // closure reads capturedContextUsage at RUN time, not definition time.
                const rowMetadata = capturedContextUsage
                  ? { ...row.metadata, context_usage: capturedContextUsage }
                  : row.metadata;
                const id = await appendRow({
                  sessionId,
                  role: "assistant",
                  content: row.content,
                  metadata: rowMetadata,
                });
                // Remember the turn's latest assistant row so a later agent_end (the
                // immediate/non-routed order) can patch the snapshot onto its metadata.
                lastAssistantDbMessageId = id;
                lastAssistantContent = row.content;
                lastAssistantMetadata = rowMetadata;
                // Carry the row id out on the relayed message_end so a consumer can
                // match its live bubble to the persisted row by identity.
                dbMessageId = id;
                if (row.item) emitItem(row.item, true, id);
                await incrementMessageCount(sessionId);
              }
            };
            // On a routed turn the primary streams live before we know it won;
            // defer the durable write to the commit point so a failed primary's
            // reply isn't left in the DB after a fallback takes over.
            if (isRoutingTurn && !routingCommitted) pendingAssistantOps.push(persistAssistant);
            else await persistAssistant();
          }
          assistantContent = "";
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
  } catch (err) {
    // Cancellation must wake a pending network read as well as the event loop.
    // Preserve the normal Stop finalization below when the transport rejects it.
    if (!signal?.aborted) throw err;
  } finally {
    await flushTerminalError();
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
          ...pendingCall.roundMeta,
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
            toolset: pendingCall.toolset ?? null,
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
      for (const item of assistantItems.snapshot()) {
        const text = stripEmptyResponseMarkers(item.text);
        if (!text.trim()) continue;
        try {
          await appendRow({ sessionId, role: "assistant", content: redactText(text, redactionConfig),
            metadata: { incomplete: true, llm_round: timeline.nextRound(),
              ...(item.phase ? { phase: item.phase } : {}),
              assistant_item: { ...item, text: undefined, status: "interrupted" } } });
          await incrementMessageCount(sessionId);
        } catch (err) {
          console.warn(`[sse-consumer] ${userId}: failed to persist partial assistant item on abort:`, err);
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
