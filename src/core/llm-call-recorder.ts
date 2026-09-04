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
}

/**
 * Handle exposed on the brain so the agentbox can mark prompt / attempt
 * boundaries without reaching into the recorder's internals.
 */
export interface LlmCallPromptBoundary {
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

  private promptOpen = false;
  private promptExplicit = false;
  private promptReceivedAt?: number;
  private round = 0;
  private attempt = 1;
  private attemptStartRound = 0;
  private prevResponseEndAt?: number;
  private pendingAux: LlmCallEnvelope[] = [];
  private pendingFailedAgentCalls: LlmCallEnvelope[] = [];

  constructor(options: LlmCallRecorderOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  // ── Prompt / attempt boundaries ────────────────────────────────────────

  beginPrompt(receivedAt?: number, opts?: { explicit?: boolean }): void {
    // An explicit open (HTTP receipt) wins over the brain's implicit one, which
    // fires later from inside the routing runner and must not reset the rounds.
    if (this.promptOpen && this.promptExplicit && !opts?.explicit) return;
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
        maybeStream = baseFn(model, context, options);
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
      blocks: [],
      openBlocks: new Map(),
      toolCallIds: [],
      modelProvider: typeof model?.provider === "string" ? model.provider : undefined,
      modelId: typeof model?.id === "string" ? model.id : undefined,
    };
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
          return: async (value?: unknown) =>
            iterator.return?.(value) ?? { done: true as const, value: undefined },
          throw: async (error?: unknown) =>
            iterator.throw?.(error) ?? { done: true as const, value: undefined },
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

    if (call.kind === "aux") {
      this.pendingAux.push(envelope);
    } else {
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
