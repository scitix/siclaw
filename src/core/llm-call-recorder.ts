/**
 * LLM call recorder — measures every provider request at the `streamFn`
 * boundary and stamps the result onto the assistant message as `llmCall`.
 *
 * This is the single source of truth for model-side timing. The gateway
 * (`src/gateway/sse-consumer.ts`) reads `message.llmCall` off `message_end`
 * and persists a redacted copy as `chat_messages.metadata.llm_call`; a reader
 * decodes the linear timeline from those rows. Nothing downstream infers
 * timing from event arrival any more.
 *
 * Why here and not in the SSE consumer: only the streamFn boundary sees the
 * request leaving, the HTTP headers arriving (pi-ai pushes `start` after
 * `withResponse()` resolves), the exact thinking/text/tool-call block edges,
 * and the provider's own `usage`. Everything is on ONE clock — this process.
 *
 * Pure module: no I/O, no pi imports at runtime, vitest-friendly. Wiring
 * lives in agent-factory.ts (wrap) and agentbox http-server.ts (prompt/attempt
 * boundaries).
 *
 * Contract for consumers: the envelope's shape is documented on
 * LlmCallEnvelope below, field by field. Nothing outside this module infers
 * timing — a reader that wants a different number derives it from these.
 */

import { createHash, randomUUID } from "node:crypto";

import {
  MAX_CORRELATION_ID_LENGTH,
  resolveUsageStatus,
  validateUsageConsistency,
  type LlmCallMeasurement,
  type LlmRequestSnapshot,
  type UsageField,
  type UsageSource,
} from "../shared/llm-call-record.js";
import { instrumentFetchForUsage, type RawUsageObservation } from "./raw-usage-observer.js";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * How long a measurement waits for the raw-usage branch before giving up.
 *
 * The branch reads a teed copy of a body the SDK has already consumed, so it is
 * normally microseconds behind. The cap exists so a stuck read degrades to
 * `unknown` instead of leaking a pending timer per call.
 */
const OBSERVATION_GRACE_MS = 250;

/** Budget-only estimate; a real tokenizer is not worth the dependency here. */
const APPROX_BYTES_PER_TOKEN = 4;

/** Ceiling on how long teardown waits for outstanding measurements. */
const MEASUREMENT_SETTLE_MS = 1_000;

/**
 * Fingerprint the request as the model will see it.
 *
 * `history_prefix_sha256` covers every message EXCEPT the newest one, which is
 * what separates "history merely grew" (prefix stable, cache still usable) from
 * "history was rewritten or pruned" (prefix changed, cache prefix dead) — the
 * distinction the whole cache investigation turns on.
 *
 * `prompt_cache_key` and the retention shape are left null here: both are set
 * inside the SDK's request builder, below this boundary. A later step can lift
 * them off the outgoing request body.
 */
function snapshotRequest(context: any): LlmRequestSnapshot {
  const messages: unknown[] = Array.isArray(context?.messages) ? context.messages : [];
  const prefix = messages.slice(0, Math.max(0, messages.length - 1));
  const systemPrompt = typeof context?.systemPrompt === "string" ? context.systemPrompt : "";
  let toolsText = "[]";
  let prefixText = "[]";
  try { toolsText = JSON.stringify(context?.tools ?? []); } catch { toolsText = "[unserialisable]"; }
  try { prefixText = JSON.stringify(prefix); } catch { prefixText = "[unserialisable]"; }
  return {
    // prompt_cache_key / cache_retention_sent are deliberately ABSENT here:
    // this function has not inspected any request. The fetch observation fills
    // them in, and only then does a null mean "was not sent".
    model_settings: {},
    system_sha256: sha256(systemPrompt),
    tools_sha256: sha256(toolsText),
    history_prefix_sha256: sha256(prefixText),
    history_message_count: messages.length,
  };
}

export const LLM_CALL_ENVELOPE_VERSION = 1 as const;

export type LlmCallKind = "agent" | "aux";

export interface LlmCallBlock {
  type: "thinking" | "text" | "tool_call";
  start_at: string;
  end_at: string;
  /** Characters produced by the block (thinking/text). */
  chars?: number;
  /** Tool call id / name (tool_call blocks). */
  id?: string;
  name?: string;
}

export interface LlmCallUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
  total?: number;
}

export interface LlmCallEnvelope {
  v: typeof LLM_CALL_ENVELOPE_VERSION;
  /** 1-based index of this model call within the prompt. Only `agent` calls consume rounds. */
  round: number;
  /** Model-routing attempt number the call belongs to (1 when routing never switched). */
  attempt: number;
  /** `agent` = agent-loop turn (context carried tools); `aux` = compaction / summarisation. */
  kind: LlmCallKind;
  model: {
    provider?: string;
    id?: string;
    response_model?: string;
    response_id?: string;
  };
  /** Only on round 1: when the box accepted the prompt (same clock). */
  prompt_received_at?: string;
  request_at: string;
  /** HTTP response headers arrived (`start` event). */
  headers_at?: string;
  /** First content-bearing stream event (thinking / text / tool call). */
  first_token_at?: string;
  response_end_at: string;
  /**
   * round 1: request_at − prompt_received_at (setup).
   * round>1: request_at − previous agent call's response_end_at (= previous tool group span).
   */
  since_prev_ms?: number;
  ms: {
    net_ttft: number;
    thinking: number;
    output: number;
    total: number;
  };
  /** Non-overlapping block edges in emission order. */
  blocks: LlmCallBlock[];
  usage?: LlmCallUsage;
  stop_reason?: string;
  error_message?: string;
  /** false when the provider reports reasoning tokens but streams no thinking text. */
  thinking_visible: boolean;
  tool_call_ids: string[];
  /** Auxiliary calls (compaction) that ran between the previous agent call and this one. */
  aux_calls?: LlmCallEnvelope[];
  /** Set by the gateway: id of the persisted `kind: "thinking"` row for this call. */
  thinking_row_id?: string;
}

/** Envelope fields captured while the stream is in flight, before the result is known. */
interface InFlightCall {
  kind: LlmCallKind;
  requestAt: number;
  /** Identifies this call for its whole lifecycle; transport retries reuse it. */
  callId: string;
  /**
   * The prompt this call belongs to, captured at open time.
   *
   * Must NOT be read from the recorder when the measurement finally settles: a
   * call that waits out its observation grace period can outlive its prompt, and
   * reading the live value then files it under whatever prompt started next.
   */
  promptId: string;
  /** Snapshotted with the call, for the same reason `promptId` is. */
  rootRequestId: string | null;
  /** Likewise: a sub-agent's spawning call, fixed for this recorder's lifetime. */
  parentCallId: string | null;
  /**
   * Per-attempt observations, keyed by attempt number.
   *
   * Keyed rather than collapsed to "the best so far" because the LAST attempt is
   * the outcome, whatever it says: a final attempt whose body failed to parse
   * must report `failed`, not inherit an earlier attempt's success.
   */
  attemptObservations: Map<number, RawUsageObservation>;
  /** Resolves per attempt once its observation has settled. */
  attemptWaits: Map<number, Promise<void>>;
  /** Transport-level retries observed for this one call. */
  networkAttempts: number;
  /** Request shape as sent — the evidence cache and pruning checks read. */
  requestSnapshot: LlmRequestSnapshot;
  /** True once this call's options were instrumented (distinguishes "no fetch" from "not wired"). */
  instrumented?: boolean;
  /** Releases this call from `activeCalls`; cleared once used. */
  settleActive?: () => void;
  /**
   * Wire protocol, snapshotted at open time.
   *
   * An abandoned stream has no final message to read `api` from, so a call that
   * ended early recorded `api_type: ""` — which resolves to `unknown` and
   * discards a perfectly good usage report that had already arrived.
   */
  apiType?: string;
  headersAt?: number;
  firstTokenAt?: number;
  blocks: LlmCallBlock[];
  openBlocks: Map<number, { type: LlmCallBlock["type"]; startAt: number; chars: number; id?: string; name?: string }>;
  toolCallIds: string[];
  modelProvider?: string;
  modelId?: string;
  sealedEnvelope?: LlmCallEnvelope;
}

export interface LlmCallRecorderOptions {
  now?: () => number;
  /** Diagnostic sink; defaults to console.warn. */
  warn?: (message: string) => void;
  /**
   * Per-call metering sink. When absent the recorder behaves exactly as before —
   * no fetch is instrumented and no measurement is produced — so this stays an
   * additive capability rather than a change to the existing envelope contract.
   */
  onMeasurement?: (measurement: LlmCallMeasurement) => void;
  /** Stable id generator; injectable so tests can pin call_ids. */
  newCallId?: () => string;
}

/**
 * Handle exposed on the brain so the agentbox can mark prompt / attempt
 * boundaries without reaching into the recorder's internals.
 */
export interface LlmCallPromptBoundary {
  /**
   * Bind subsequent calls to a user request. Optional: a caller that never sets
   * it yields a null correlation, which is honest — the alternative, deriving
   * one at the receiver from session lineage, collapsed every request in a
   * conversation into a single id.
   */
  setRootRequestId(id: string | null | undefined): void;
  /** The bound request, so a spawn can snapshot it while the parent turn is live. */
  getRootRequestId(): string | null;
  /** The call whose tools are running — a spawn records it as its children's parent. */
  getToolDispatchCallId(): string | null;
  /** Bind this recorder's calls to the call that spawned this sub-agent. */
  setParentCallId(id: string | null | undefined): void;
  /** A new prompt was accepted at `receivedAt` (ms epoch). Resets rounds. */
  beginPrompt(receivedAt?: number, opts?: { explicit?: boolean }): void;
  /** The prompt finished (every terminal path). */
  endPrompt(opts?: { explicit?: boolean }): void;
  /** A model-routing attempt is starting: remember where its rounds begin. */
  beginAttempt(attempt?: number): void;
  /** The attempt failed / was rolled back: rewind its rounds. Idempotent. */
  rollbackAttempt(): void;
}

export class LlmCallRecorder implements LlmCallPromptBoundary {
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly onMeasurement?: (measurement: LlmCallMeasurement) => void;
  private readonly newCallId: () => string;
  /** Measurement tasks not yet handed to the sink; awaited by `settleMeasurements`. */
  private readonly pendingMeasurements = new Set<Promise<void>>();
  /** Calls that have opened but not yet sealed — they have no measurement YET. */
  private readonly activeCalls = new Set<Promise<void>>();

  private promptOpen = false;
  private promptExplicit = false;
  private promptReceivedAt?: number;
  /** One accepted prompt execution — spans its rounds, aux calls and route retries. */
  private promptId = "";
  /** The user request these prompts serve; a sub-agent inherits its parent's. */
  private rootRequestId: string | null = null;
  private warnedOversizedRootRequestId = false;
  /**
   * The agent call that most recently finished — i.e. the one whose tool calls
   * are executing right now. A spawn snapshots it as its children's parent.
   */
  private lastAgentCallId: string | null = null;
  /** Set on a sub-agent's recorder: the call that spawned it. Never derived. */
  private parentCallId: string | null = null;
  private round = 0;
  private attempt = 1;
  private attemptStartRound = 0;
  private prevResponseEndAt?: number;
  private pendingAux: LlmCallEnvelope[] = [];
  private pendingFailedAgentCalls: LlmCallEnvelope[] = [];

  constructor(options: LlmCallRecorderOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.onMeasurement = options.onMeasurement;
    this.newCallId = options.newCallId ?? (() => randomUUID());
  }

  // ── Prompt / attempt boundaries ────────────────────────────────────────

  /**
   * Bind this recorder's calls to a user request.
   *
   * Optional by design: an older caller that never sets it produces records with
   * a null correlation, which is honest. Inventing one at the receiver from
   * session lineage was the previous attempt, and it collapsed every request in
   * a long conversation into a single id.
   */
  setRootRequestId(id: string | null | undefined): void {
    if (!id) {
      this.rootRequestId = null;
      return;
    }
    if (id.length > MAX_CORRELATION_ID_LENGTH) {
      // Storing a prefix would correlate calls from different requests. Drop the
      // correlation, keep the measurements, and say so once — silence here would
      // look identical to a box that never supported the field.
      if (!this.warnedOversizedRootRequestId) {
        this.warnedOversizedRootRequestId = true;
        console.warn(
          `[llm-call-recorder] root request id longer than ${MAX_CORRELATION_ID_LENGTH} characters; ` +
          "recording these calls without a request correlation",
        );
      }
      this.rootRequestId = null;
      return;
    }
    this.rootRequestId = id;
  }

  getRootRequestId(): string | null {
    return this.rootRequestId;
  }

  /**
   * The call whose tools are executing — what a spawn records as its children's
   * parent, read synchronously at dispatch.
   *
   * Not substitutable by a tool-call id (that names the tool invocation, not the
   * LLM call that produced it) nor by session lineage (which cannot say WHICH of
   * a turn's calls did the spawning). Null before the first round seals.
   */
  getToolDispatchCallId(): string | null {
    return this.lastAgentCallId;
  }

  /** Bind this recorder's calls to the call that spawned this sub-agent. */
  setParentCallId(id: string | null | undefined): void {
    this.parentCallId = id && id.length <= MAX_CORRELATION_ID_LENGTH ? id : null;
  }

  beginPrompt(receivedAt?: number, opts?: { explicit?: boolean }): void {
    // An explicit open (HTTP receipt) wins over the brain's implicit one, which
    // fires later from inside the routing runner and must not reset the rounds.
    if (this.promptOpen && this.promptExplicit && !opts?.explicit) return;
    // A route retry stays inside the same prompt execution, so the id is minted
    // here and not per attempt.
    if (!this.promptOpen) this.promptId = this.newCallId();
    this.promptOpen = true;
    this.promptExplicit = opts?.explicit === true;
    this.promptReceivedAt = receivedAt ?? this.now();
    this.round = 0;
    this.attempt = 1;
    this.attemptStartRound = 0;
    this.attemptStarted = false;
    this.prevResponseEndAt = undefined;
    if (this.pendingAux.length > 0) {
      this.warn(`[llm-call-recorder] dropping ${this.pendingAux.length} aux call(s) left over from the previous prompt`);
      this.pendingAux = [];
    }
    if (this.pendingFailedAgentCalls.length > 0) {
      this.warn(`[llm-call-recorder] dropping ${this.pendingFailedAgentCalls.length} unmatched failed call(s) left over from the previous prompt`);
      this.pendingFailedAgentCalls = [];
    }
  }

  endPrompt(opts?: { explicit?: boolean }): void {
    // The brain's implicit end (each brain.prompt() return) must not close a
    // prompt the HTTP layer opened explicitly — routing calls brain.prompt()
    // once per attempt inside one HTTP prompt.
    if (this.promptExplicit && !opts?.explicit) return;
    this.promptOpen = false;
    this.promptExplicit = false;
    if (this.pendingAux.length > 0) {
      // Compaction can finish after the final agent call while the HTTP layer is
      // deliberately keeping the prompt open. The current cross-service
      // contract has no following call on which to carry these aux_calls, so
      // their span remains visible as the prompt's residual rather than being
      // mislabelled as another round or another prompt's setup.
      this.warn(
        `[llm-call-recorder] ${this.pendingAux.length} trailing aux call(s) had no following agent call ` +
          `to ride; their span stays in the prompt tail (residual)`,
      );
      this.pendingAux = [];
    }
  }

  beginAttempt(attempt?: number): void {
    this.attemptStartRound = this.round;
    if (typeof attempt === "number" && attempt >= 1) this.attempt = attempt;
    else this.attempt += this.attemptStarted ? 1 : 0;
    this.attemptStarted = true;
  }

  rollbackAttempt(): void {
    // Fires for `model_route_attempt{failed}` AND `model_route_rollback` (the
    // live-output case emits both) — hence idempotent: rewinding twice is a no-op.
    this.round = this.attemptStartRound;
    // prevResponseEndAt is deliberately NOT rewound: the discarded attempt's
    // time is real, and the survivor's since_prev_ms must span it so the
    // prompt timeline stays a partition.
  }

  private attemptStarted = false;

  /** Test / diagnostics visibility. */
  snapshot(): { promptOpen: boolean; round: number; attempt: number; pendingAux: number } {
    return { promptOpen: this.promptOpen, round: this.round, attempt: this.attempt, pendingAux: this.pendingAux.length };
  }

  // ── streamFn wrapper ───────────────────────────────────────────────────

  wrapStreamFn<T extends (...args: any[]) => any>(baseFn: T): T {
    const recorder = this;
    const wrapped = (model: any, context: any, options: any) => {
      const call = recorder.openCall(model, context);
      let maybeStream: any;
      try {
        maybeStream = baseFn(model, context, recorder.instrumentOptions(options, call));
      } catch (error) {
        recorder.sealFailedCall(call, error);
        throw error;
      }
      if (maybeStream && typeof maybeStream === "object" && typeof (maybeStream as Promise<unknown>).then === "function") {
        return (maybeStream as Promise<any>).then(
          (stream) => recorder.wrapStream(stream, call),
          (error) => {
            recorder.sealFailedCall(call, error);
            throw error;
          },
        );
      }
      return recorder.wrapStream(maybeStream, call);
    };
    return wrapped as unknown as T;
  }

  /**
   * pi-agent synthesizes a fresh assistant error message when streamFn throws,
   * so the envelope cannot be stamped directly onto the message at the provider
   * boundary. Pair that message with the failed call before subscribers see it.
   */
  attachPendingFailure(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const target = message as Record<string, unknown>;
    if (target.role !== "assistant" || (target.stopReason !== "error" && target.stopReason !== "aborted")) return;
    if (llmCallFromMessage(target)) return;
    const envelope = this.pendingFailedAgentCalls.shift();
    if (!envelope) return;
    envelope.stop_reason = target.stopReason;
    if (typeof target.errorMessage === "string") envelope.error_message = target.errorMessage.slice(0, 500);
    target.llmCall = envelope;
  }

  private openCall(model: any, context: any): InFlightCall {
    if (!this.promptOpen) {
      // Late/implicit open — a prompt path that never went through the HTTP
      // layer (child sub-agent, synthetic notify). Rounds still start at 1.
      this.beginPrompt(this.now());
    }
    return {
      kind: Array.isArray(context?.tools) ? "agent" : "aux",
      requestAt: this.now(),
      callId: this.newCallId(),
      promptId: this.promptId,
      rootRequestId: this.rootRequestId,
      parentCallId: this.parentCallId,
      networkAttempts: 0,
      apiType: typeof model?.api === "string" ? model.api : undefined,
      ...this.trackActiveCall(),
      attemptObservations: new Map(),
      attemptWaits: new Map(),
      requestSnapshot: snapshotRequest(context),
      blocks: [],
      openBlocks: new Map(),
      toolCallIds: [],
      modelProvider: typeof model?.provider === "string" ? model.provider : undefined,
      modelId: typeof model?.id === "string" ? model.id : undefined,
    };
  }

  /**
   * Turn one sealed call into a metering measurement.
   *
   * The usage numbers come from the RAW observation, not from pi's normalised
   * object: a field the provider never sent is left `null` here, where the
   * normalised object would have shown a zero indistinguishable from a real one.
   * With no observation at all (uninstrumented transport) the source is
   * `unknown` and every figure is null — deliberately not zero.
   */
  private emitMeasurement(call: InFlightCall, envelope: LlmCallEnvelope, message: any): void {
    const sink = this.onMeasurement;
    if (!sink) return;
    // Wait for the observation branch, but never hold the turn hostage to it:
    // a stalled read yields `unknown`, which is honest, rather than blocking.
    const task = (async () => {
      // Wait for EVERY attempt that was started, not merely the first to answer.
      // By seal time the SDK has stopped retrying, so the set is complete.
      const waits = [...call.attemptWaits.values()];
      if (waits.length > 0) {
        await Promise.race([
          Promise.all(waits),
          new Promise<void>((resolve) => setTimeout(resolve, OBSERVATION_GRACE_MS).unref?.()),
        ]);
      }
      this.finishMeasurement(sink, call, envelope, message);
    })();
    // Tracked so teardown can wait for it. A turn's last calls settle AFTER the
    // stream ends, so a release that only drains the dispatcher's queue flushes
    // an empty queue and loses exactly the measurements describing how the turn
    // finished.
    this.pendingMeasurements.add(task);
    void task.finally(() => { this.pendingMeasurements.delete(task); });
  }

  /**
   * Wait for in-flight measurements to be handed to the sink.
   *
   * Bounded: teardown must not hang on a stuck observation. What does not
   * settle in time is simply not reported, which is the honest outcome.
   */
  async settleMeasurements(timeoutMs = MEASUREMENT_SETTLE_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    // Calls still in flight come FIRST: a measurement only enters
    // `pendingMeasurements` once its call has sealed, so waiting on that set
    // alone returns instantly while a request is mid-flight — and the records it
    // is about to produce then arrive after the dispatcher has already closed.
    if (this.activeCalls.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.activeCalls]),
        new Promise<void>((resolve) => { setTimeout(resolve, remaining()).unref?.(); }),
      ]);
    }
    if (this.pendingMeasurements.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.pendingMeasurements]),
      new Promise<void>((resolve) => { setTimeout(resolve, remaining()).unref?.(); }),
    ]);
  }

  /**
   * The observation that describes this call's outcome: the HIGHEST-numbered
   * attempt that reported back.
   *
   * Not "the best" — a final attempt that failed to parse is the truth about the
   * call, and letting an earlier success stand in its place would report numbers
   * from a response the SDK discarded.
   */
  /**
   * Register a call as active and hand back the fields that track it.
   *
   * Resolved by `markCallSettled` on every exit path — success, failure, abort —
   * so teardown can wait for a request that is still in flight instead of
   * concluding there is nothing to wait for.
   */
  private trackActiveCall(): { settleActive: () => void } {
    let settleActive = (): void => {};
    const gate = new Promise<void>((resolve) => { settleActive = resolve; });
    this.activeCalls.add(gate);
    const done = (): void => { this.activeCalls.delete(gate); settleActive(); };
    return { settleActive: done };
  }

  /**
   * Mark a call no longer in flight. Idempotent.
   *
   * Must be reached on EVERY exit — sealed, failed, or abandoned. A call that is
   * never sealed (an aborted stream) would otherwise sit in `activeCalls`
   * forever, and every later teardown would burn its full settle budget waiting
   * on a call that is never coming back.
   */
  /**
   * Seal a call whose stream was abandoned before settling.
   *
   * The call really happened — the request went out, and its usage may already
   * have been observed — so it earns a record like any other, marked `aborted`.
   * Releasing `activeCalls` without sealing (as an earlier fix did) stops
   * teardown from hanging but discards the call entirely.
   *
   * Idempotent: a stream that already sealed normally is left alone.
   */
  private sealAbandonedCall(call: InFlightCall): void {
    if (call.sealedEnvelope) { this.markCallSettled(call); return; }
    this.sealCall(call, { stopReason: "aborted" });
  }

  private markCallSettled(call: InFlightCall): void {
    call.settleActive?.();
    call.settleActive = undefined;
  }

  private finalObservation(call: InFlightCall): RawUsageObservation | undefined {
    // Only the LAST attempt that was STARTED describes this call. Falling back
    // to the highest attempt that happened to report would, when the final
    // attempt's observation times out, quote an earlier response the SDK had
    // already discarded — and do it while looking confident.
    if (call.networkAttempts === 0) return undefined;
    return call.attemptObservations.get(call.networkAttempts);
  }

  private finishMeasurement(
    sink: (measurement: LlmCallMeasurement) => void,
    call: InFlightCall,
    envelope: LlmCallEnvelope,
    message: any,
  ): void {
    // Prefer the final message, fall back to the protocol captured at open time:
    // an abandoned call has no message but its protocol was never in doubt.
    const apiType = (typeof message?.api === "string" && message.api) || call.apiType || "";
    const observation = this.finalObservation(call);
    const reported: UsageField[] = observation?.outcome === "reported" ? [...observation.reported_fields] : [];
    // Three distinct situations, three distinct verdicts. Collapsing the first
    // two into `sdk_default` would assert "the provider reported nothing" on the
    // strength of our own failure to read.
    const source: UsageSource =
      // Not wired, or wired but the attempt never reported back — either way we
      // did not observe it, so claiming provider silence is unfounded.
      observation === undefined ? "unknown"
      : observation.outcome === "failed" ? "unknown" // we could not read it
      : observation.outcome === "no_usage" ? "sdk_default" // read it; genuinely none
      : "provider";
    const value = (field: UsageField): number | null => {
      const v = observation?.values[field];
      return typeof v === "number" ? v : null;
    };

    const usage = {
      input_tokens_total: value("input"),
      output_tokens_total: value("output"),
      reasoning_tokens: value("reasoning"),
      cache_read_tokens: value("cache_read"),
      cache_write_tokens: value("cache_write"),
    };

    const measurement: LlmCallMeasurement = {
      call_id: call.callId,
      prompt_id: call.promptId,
      root_request_id: call.rootRequestId,
      parent_call_id: call.parentCallId,
      // This recorder sits in the agent loop, so every call it measures is
      // conversational by construction. A non-conversational producer (a
      // compile box, say) builds its measurements elsewhere and names its own
      // workload — which is exactly why the field is not derived downstream.
      workload: "conversation",
      kind: call.kind,
      round: envelope.round,
      attempt: envelope.attempt,
      network_attempts: call.networkAttempts,
      provider: envelope.model.provider ?? "",
      model_id: envelope.model.id ?? "",
      api_type: apiType,
      usage_status: resolveUsageStatus(apiType, reported, source),
      usage_source: source,
      reported_fields: reported,
      ...usage,
      // Measured at the fetch boundary, which sits AFTER the SDK built the
      // request — so these are the bytes and cache fields actually sent.
      payload_bytes: observation?.request_bytes ?? null,
      payload_tokens_estimated: observation?.request_bytes === undefined
        ? null
        : Math.ceil(observation.request_bytes / APPROX_BYTES_PER_TOKEN),
      request_snapshot: {
        ...call.requestSnapshot,
        // Fingerprints of the request AS SENT override the context-derived ones:
        // onPayload can rewrite the final instructions, so a context hash reads
        // "unchanged" across exactly the change that would break the cache.
        ...(observation?.request_fingerprint ?? {}),
        // `cache_retention_sent: null` means "neither field was sent". It must
        // only be claimed once a request was actually inspected; an unobserved
        // call leaves the whole `request_cache` absent instead.
        ...(observation?.request_cache ?? {}),
      },
      request_at: envelope.request_at,
      response_end_at: envelope.response_end_at,
      since_prev_ms: envelope.since_prev_ms ?? null,
      cost_micros: null,
      inconsistencies: validateUsageConsistency({ api_type: apiType, ...usage }),
    };
    try { sink(measurement); } catch (error) {
      this.warn(`[llm-call-recorder] measurement sink failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Compose a per-call `options.fetch` that observes the provider's raw usage.
   *
   * Composed, not replaced: a caller that already supplied a fetch keeps it.
   * Only the LAST observation is kept — a transport retry within one call
   * reports on its own response, and the surviving attempt is the truth.
   */
  private instrumentOptions(options: any, call: InFlightCall): any {
    if (!this.onMeasurement) return options;
    call.instrumented = true;
    const settle = new Map<number, () => void>();
    const fetchImpl = instrumentFetchForUsage(
      options?.fetch,
      (observation, attempt) => {
        call.attemptObservations.set(attempt, observation);
        settle.get(attempt)?.();
      },
      (attempt) => {
        // Registered when the attempt STARTS, so sealing waits for an attempt
        // whose observation has not come back yet instead of concluding early.
        call.networkAttempts = Math.max(call.networkAttempts, attempt);
        call.attemptWaits.set(attempt, new Promise<void>((resolve) => settle.set(attempt, resolve)));
      },
    );
    return { ...(options ?? {}), fetch: fetchImpl };
  }

  private wrapStream(stream: any, call: InFlightCall): any {
    if (!stream || typeof stream !== "object") return stream;

    if (typeof stream[Symbol.asyncIterator] === "function") {
      const originalIterator = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = () => {
        const iterator = originalIterator();
        return {
          next: async () => {
            try {
              const result = await iterator.next();
              if (!result.done && result.value) this.observeEvent(call, result.value);
              return result;
            } catch (error) {
              this.sealFailedCall(call, error);
              throw error;
            }
          },
          // An abandoned stream (abort, break out of the loop) never seals, so
          // release the call here too — otherwise it sits in `activeCalls` for
          // the life of the recorder and makes every later teardown wait out its
          // full settle budget for a call that will never arrive.
          // An abandoned stream must be SEALED, not merely released. Clearing
          // `activeCalls` alone stops teardown from hanging but throws the call
          // away: a request that went out and whose usage we already observed
          // would be recorded nowhere at all.
          return: async (value?: unknown) => {
            this.sealAbandonedCall(call);
            return iterator.return?.(value) ?? { done: true as const, value: undefined };
          },
          throw: async (error?: unknown) => {
            this.sealAbandonedCall(call);
            return iterator.throw?.(error) ?? { done: true as const, value: undefined };
          },
        };
      };
    }

    if (typeof stream.result === "function") {
      const originalResult = stream.result.bind(stream);
      let sealed: Promise<any> | undefined;
      stream.result = () => {
        // result() may be awaited more than once (pi-agent awaits it on `done`
        // and again after the loop); the envelope must be built exactly once.
        if (!sealed) {
          sealed = Promise.resolve().then(originalResult).then(
            (message: any) => {
              this.sealCall(call, message);
              return message;
            },
            (error: unknown) => {
              this.sealFailedCall(call, error);
              throw error;
            },
          );
        }
        return sealed;
      };
    }
    return stream;
  }

  private observeEvent(call: InFlightCall, event: any): void {
    const type = event?.type;
    if (typeof type !== "string") return;
    const at = this.now();
    switch (type) {
      case "start":
        call.headersAt ??= at;
        return;
      case "thinking_start":
        call.firstTokenAt ??= at;
        this.openBlock(call, event, "thinking", at);
        return;
      case "text_start":
        call.firstTokenAt ??= at;
        this.openBlock(call, event, "text", at);
        return;
      case "toolcall_start":
        call.firstTokenAt ??= at;
        this.openBlock(call, event, "tool_call", at);
        return;
      case "thinking_delta":
      case "text_delta": {
        call.firstTokenAt ??= at;
        const block = this.ensureBlock(call, event, type === "thinking_delta" ? "thinking" : "text", at);
        if (typeof event.delta === "string") block.chars += event.delta.length;
        return;
      }
      case "toolcall_delta":
        call.firstTokenAt ??= at;
        this.ensureBlock(call, event, "tool_call", at);
        return;
      case "thinking_end":
      case "text_end": {
        const block = this.ensureBlock(call, event, type === "thinking_end" ? "thinking" : "text", at);
        if (typeof event.content === "string") block.chars = Math.max(block.chars, event.content.length);
        this.closeBlock(call, event, at);
        return;
      }
      case "toolcall_end": {
        const block = this.ensureBlock(call, event, "tool_call", at);
        const toolCall = event.toolCall;
        if (toolCall && typeof toolCall === "object") {
          if (typeof toolCall.id === "string") block.id = toolCall.id;
          if (typeof toolCall.name === "string") block.name = toolCall.name;
        }
        this.closeBlock(call, event, at);
        return;
      }
      default:
        return;
    }
  }

  private blockKey(event: any): number {
    return typeof event?.contentIndex === "number" ? event.contentIndex : -1;
  }

  private openBlock(call: InFlightCall, event: any, type: LlmCallBlock["type"], at: number): void {
    const key = this.blockKey(event);
    if (call.openBlocks.has(key)) return;
    call.openBlocks.set(key, { type, startAt: at, chars: 0 });
  }

  private ensureBlock(call: InFlightCall, event: any, type: LlmCallBlock["type"], at: number) {
    const key = this.blockKey(event);
    let block = call.openBlocks.get(key);
    if (!block) {
      block = { type, startAt: at, chars: 0 };
      call.openBlocks.set(key, block);
    }
    return block;
  }

  private closeBlock(call: InFlightCall, event: any, at: number): void {
    const key = this.blockKey(event);
    const block = call.openBlocks.get(key);
    if (!block) return;
    call.openBlocks.delete(key);
    this.pushBlock(call, block, at);
  }

  private pushBlock(
    call: InFlightCall,
    block: { type: LlmCallBlock["type"]; startAt: number; chars: number; id?: string; name?: string },
    endAt: number,
  ): void {
    const out: LlmCallBlock = {
      type: block.type,
      start_at: iso(block.startAt),
      end_at: iso(Math.max(block.startAt, endAt)),
    };
    if (block.type !== "tool_call") out.chars = block.chars;
    if (block.id) {
      out.id = block.id;
      call.toolCallIds.push(block.id);
    }
    if (block.name) out.name = block.name;
    call.blocks.push(out);
  }

  private sealFailedCall(call: InFlightCall, error: unknown): void {
    if (call.sealedEnvelope) return;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const envelope = this.sealCall(call, { stopReason: "error", errorMessage });
    if (call.kind === "agent") this.pendingFailedAgentCalls.push(envelope);
  }

  private sealCall(call: InFlightCall, message: any): LlmCallEnvelope {
    if (call.sealedEnvelope) {
      if (message && typeof message === "object") {
        (message as Record<string, unknown>).llmCall = call.sealedEnvelope;
      }
      return call.sealedEnvelope;
    }
    const responseEndAt = this.now();
    // Blocks still open when the stream ended (provider never sent *_end).
    for (const [key, block] of [...call.openBlocks.entries()]) {
      call.openBlocks.delete(key);
      this.pushBlock(call, block, responseEndAt);
    }
    // Tool-call ids the block stream missed (e.g. result() consumed without iteration).
    if (message && Array.isArray(message.content)) {
      for (const c of message.content) {
        if (c && typeof c === "object" && c.type === "toolCall" && typeof c.id === "string" && !call.toolCallIds.includes(c.id)) {
          call.toolCallIds.push(c.id);
        }
      }
    }

    const totalMs = Math.max(0, responseEndAt - call.requestAt);
    const firstTokenAt = call.firstTokenAt;
    const netTtftMs = firstTokenAt === undefined ? totalMs : Math.max(0, firstTokenAt - call.requestAt);
    let thinkingMs = 0;
    for (const b of call.blocks) {
      if (b.type === "thinking") thinkingMs += Math.max(0, Date.parse(b.end_at) - Date.parse(b.start_at));
    }
    const streamingMs = firstTokenAt === undefined ? 0 : Math.max(0, responseEndAt - firstTokenAt);
    thinkingMs = Math.min(thinkingMs, streamingMs);
    const outputMs = Math.max(0, streamingMs - thinkingMs);

    const usage = usageFromMessage(message?.usage);
    const thinkingChars = call.blocks.reduce((acc, b) => acc + (b.type === "thinking" ? (b.chars ?? 0) : 0), 0);
    const thinkingVisible = thinkingChars > 0 || messageHasThinkingText(message);

    const envelope: LlmCallEnvelope = {
      v: LLM_CALL_ENVELOPE_VERSION,
      round: 0,
      attempt: this.attempt,
      kind: call.kind,
      model: {
        provider: call.modelProvider ?? (typeof message?.provider === "string" ? message.provider : undefined),
        id: call.modelId ?? (typeof message?.model === "string" ? message.model : undefined),
        response_model: typeof message?.responseModel === "string" ? message.responseModel : undefined,
        response_id: typeof message?.responseId === "string" ? message.responseId : undefined,
      },
      request_at: iso(call.requestAt),
      headers_at: call.headersAt === undefined ? undefined : iso(call.headersAt),
      first_token_at: firstTokenAt === undefined ? undefined : iso(firstTokenAt),
      response_end_at: iso(responseEndAt),
      ms: { net_ttft: netTtftMs, thinking: thinkingMs, output: outputMs, total: totalMs },
      blocks: call.blocks,
      usage,
      stop_reason: typeof message?.stopReason === "string" ? message.stopReason : undefined,
      error_message: typeof message?.errorMessage === "string" ? message.errorMessage.slice(0, 500) : undefined,
      thinking_visible: thinkingVisible,
      tool_call_ids: call.toolCallIds,
    };
    call.sealedEnvelope = envelope;
    this.markCallSettled(call);
    this.emitMeasurement(call, envelope, message);

    if (call.kind === "aux") {
      this.pendingAux.push(envelope);
    } else {
      // The tools of this round are about to run, and this is the call that
      // asked for them. Recorded on SEAL rather than on open: the next round's
      // call must not already have overwritten it while a tool is dispatching.
      // Aux calls are skipped because they issue no tools — letting a
      // summarisation slip in here would name the wrong dispatcher.
      this.lastAgentCallId = call.callId;
      this.round += 1;
      envelope.round = this.round;
      if (this.round === 1 && this.promptReceivedAt !== undefined) {
        envelope.prompt_received_at = iso(this.promptReceivedAt);
      }
      // After a routing rollback round 1 recurs with a real predecessor (the
      // discarded attempt); only the very first call measures from receipt.
      const anchor = this.prevResponseEndAt ?? (this.round === 1 ? this.promptReceivedAt : undefined);
      if (anchor !== undefined) {
        envelope.since_prev_ms = Math.max(0, call.requestAt - anchor);
      }
      if (this.pendingAux.length > 0) {
        envelope.aux_calls = this.pendingAux;
        this.pendingAux = [];
      }
      this.prevResponseEndAt = responseEndAt;
    }

    if (message && typeof message === "object") {
      (message as Record<string, unknown>).llmCall = envelope;
    }
    return envelope;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function usageFromMessage(raw: unknown): LlmCallUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const usage: LlmCallUsage = {};
  const input = num(u.input);
  const output = num(u.output);
  const reasoning = num(u.reasoning);
  const cacheRead = num(u.cacheRead);
  const cacheWrite = num(u.cacheWrite);
  const total = num(u.totalTokens);
  if (input !== undefined) usage.input = input;
  if (output !== undefined) usage.output = output;
  if (reasoning !== undefined) usage.reasoning = reasoning;
  if (cacheRead !== undefined) usage.cache_read = cacheRead;
  if (cacheWrite !== undefined) usage.cache_write = cacheWrite;
  if (total !== undefined) usage.total = total;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function messageHasThinkingText(message: any): boolean {
  if (!message || !Array.isArray(message.content)) return false;
  return message.content.some(
    (c: any) => c && typeof c === "object" && c.type === "thinking" && typeof c.thinking === "string" && c.thinking.length > 0,
  );
}

/** Read the envelope back off a message (gateway side). */
export function llmCallFromMessage(message: unknown): LlmCallEnvelope | undefined {
  if (!message || typeof message !== "object") return undefined;
  const raw = (message as Record<string, unknown>).llmCall;
  if (!raw || typeof raw !== "object") return undefined;
  const env = raw as LlmCallEnvelope;
  return env.v === LLM_CALL_ENVELOPE_VERSION ? env : undefined;
}

/**
 * Extract thinking blocks from an assistant message: full text plus redaction /
 * signature flags. Empty when the provider streamed none.
 */
export function thinkingBlocksFromMessage(message: unknown): Array<{ text: string; redacted: boolean; signature_present: boolean }> {
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ text: string; redacted: boolean; signature_present: boolean }> = [];
  for (const c of content) {
    if (!c || typeof c !== "object" || (c as { type?: unknown }).type !== "thinking") continue;
    const block = c as { thinking?: unknown; redacted?: unknown; thinkingSignature?: unknown };
    out.push({
      text: typeof block.thinking === "string" ? block.thinking : "",
      redacted: block.redacted === true,
      signature_present: typeof block.thinkingSignature === "string" && block.thinkingSignature.length > 0,
    });
  }
  return out;
}
