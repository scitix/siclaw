/**
 * PiAgentBrain — BrainSession implementation wrapping pi-coding-agent's AgentSession.
 *
 * Thin delegation layer. Exposes the underlying `session` for pi-agent-specific
 * hacks (streamFn, dequeue, agent internals) that live in agent-factory.ts.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  BrainSession,
  BrainModelInfo,
  BrainModelParams,
  BrainToolDefinition,
  BrainContextUsage,
  BrainSessionStats,
  BrainProviderResponse,
  BrainContextPreflightResult,
  PromptMedia,
  PromptRequirements,
} from "../brain-session.js";
import { estimateMessagesTokens } from "../compaction.js";
import type { LlmCallRecorder } from "../llm-call-recorder.js";
import { rememberPromptFiles } from "../openai-file-payload.js";

/** Valid pi thinking levels; guards reasoningEffort coming off the wire. */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

/**
 * Read `maxTokensField` off pi's compat union.
 *
 * The key exists only on the chat-completions variant — the responses and
 * anthropic wire shapes have no equivalent — so this is a genuine narrowing,
 * not a cast to dodge the type checker.
 */
function readMaxTokensField(compat: unknown): string | undefined {
  if (!compat || typeof compat !== "object" || !("maxTokensField" in compat)) return undefined;
  const value = (compat as { maxTokensField?: unknown }).maxTokensField;
  return typeof value === "string" ? value : undefined;
}

/**
 * Same narrowing for a boolean compat key. Undefined when absent — and that is
 * load-bearing rather than incidental: absent means "pi's own default", so
 * mapping it to `false` here would make an unset key compare unequal to a model
 * explicitly set to false and force a pointless rebind on every turn.
 */
function readCompatBoolean(compat: unknown, key: string): boolean | undefined {
  if (!compat || typeof compat !== "object" || !(key in compat)) return undefined;
  const value = (compat as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Provider-neutral "call this tool" choice. OpenAI chat-completions providers
 * can name the exact function; providers without a named-tool form still get a
 * deterministic choice because the repair exposes exactly one tool.
 */
export function requiredToolChoice(
  api: unknown,
  toolName: string,
): "any" | "required" | { type: "function"; function: { name: string } } {
  if (api === "openai-completions") {
    return { type: "function", function: { name: toolName } };
  }
  return api === "anthropic-messages" || api === "bedrock-converse-stream" ||
    api === "google-generative-ai" || api === "google-vertex"
    ? "any"
    : "required";
}

function requiredResultRepairOptions(
  model: unknown,
  options: Record<string, any> | undefined,
  requiredToolName: string,
): Record<string, any> {
  return {
    ...options,
    toolChoice: requiredToolChoice(
      model && typeof model === "object" ? (model as { api?: unknown }).api : undefined,
      requiredToolName,
    ),
  };
}

function contextHasTool(context: unknown, toolName: string): boolean {
  if (!context || typeof context !== "object") return false;
  const tools = (context as { tools?: unknown }).tools;
  return Array.isArray(tools) && tools.some((tool) =>
    tool != null && typeof tool === "object" && (tool as { name?: unknown }).name === toolName
  );
}

export class PiAgentBrain implements BrainSession {
  readonly brainType = "pi-agent" as const;

  /** Extra listeners for retry events not emitted by pi-agent itself.
   *  Merged with pi-agent's own subscribers in subscribe(). */
  private extraListeners = new Set<(event: any) => void>();

  /** Set during prompt(); abort() resolves this to cancel backoff sleep. */
  private abortRetry: (() => void) | null = null;

  /** True from abort() until the next prompt() starts. Stops the empty-response retry loop from
   *  firing a fresh (un-aborted) re-prompt when Stop lands during the backoff sleep. */
  private aborted = false;

  /** A strict repair owns the session loop; steers must become separate turns. */
  private requiredResultRepairActive = false;

  constructor(
    readonly session: AgentSession,
    private readonly toolsetsByName: ReadonlyMap<string, string> = new Map(),
    readonly llmCalls?: LlmCallRecorder,
  ) {}

  /**
   * Tool events are the only timeline points not produced at the streamFn
   * boundary, so they are stamped HERE — the single funnel every subscriber
   * goes through — on the same process clock as `llmCall`. Memoised per event
   * object: several subscribers must see one timestamp, not one each.
   */
  private static readonly toolEventStamps = new WeakMap<object, number>();

  private enrichToolEvent(event: any): any {
    if (!event || typeof event !== "object") return event;
    const isStart = event.type === "tool_execution_start" || event.type === "tool_start";
    const isEnd = event.type === "tool_execution_end" || event.type === "tool_end";
    if (!isStart && !isEnd) return event;
    let stamp = PiAgentBrain.toolEventStamps.get(event);
    if (stamp === undefined) {
      stamp = Date.now();
      PiAgentBrain.toolEventStamps.set(event, stamp);
    }
    const stamped = isStart
      ? (event.startedAt === undefined ? { ...event, startedAt: stamp } : event)
      : (event.endedAt === undefined ? { ...event, endedAt: stamp } : event);
    if (stamped.toolset != null) return stamped;
    const toolName = typeof stamped.toolName === "string"
      ? stamped.toolName
      : typeof stamped.name === "string" ? stamped.name : undefined;
    if (!toolName) return stamped;
    const toolset = this.toolsetsByName.get(toolName);
    return toolset ? { ...stamped, toolset } : stamped;
  }

  private static readonly MAX_EMPTY_RETRIES = 2;

  private promptOptionsForMedia(media?: PromptMedia): any | undefined {
    const content: Array<Record<string, string>> = [];
    if (media?.images && media.images.length > 0) {
      content.push(...media.images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType })));
    }
    if (media?.files && media.files.length > 0) {
      rememberPromptFiles(media.files);
      content.push(...media.files.map((file) => ({
        type: "file",
        data: file.data,
        mimeType: file.mimeType,
        filename: file.filename,
      })));
    }
    return content.length > 0 ? { images: content } : undefined;
  }
  private static readonly RETRY_DELAY_MS = 2000;
  private static readonly PROMPT_PREFLIGHT_SAFETY_TOKENS = 2048;
  private static readonly REQUIRED_RESULT_REPAIR_PROMPT =
    "[System: required-result repair]\n" +
    "The preceding attempt did not submit the required structured turn result. " +
    "Call the only available result-submission tool exactly once now, using the conversation and any preceding draft to fill its schema. " +
    "If validation rejects the call, correct it. After one successful call, give the user the final answer without mentioning this repair, tools, or schemas.";

  private emit(event: any): void {
    for (const listener of this.extraListeners) {
      try { listener(event); } catch { /* best-effort */ }
    }
  }

  /** Sleep that resolves early when abort() is called. */
  private abortableSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.abortRetry = null; resolve(); }, ms);
      this.abortRetry = () => { clearTimeout(timer); this.abortRetry = null; resolve(); };
    });
  }

  async prompt(text: string, media?: PromptMedia, requirements?: PromptRequirements): Promise<void> {
    this.aborted = false;
    // Implicit prompt boundary for callers that bypass the agentbox HTTP layer
    // (child sub-agents, synthetic notifies). A no-op when the HTTP layer already
    // opened the prompt explicitly — routing calls prompt() once per attempt.
    this.llmCalls?.beginPrompt(Date.now());
    let lastAssistantHadContent = false;
    let lastAssistantMessage: any = null;
    const successfulTools = new Set<string>();

    const promptOptions = this.promptOptionsForMedia(media);

    const unsub = this.session.subscribe((event: any) => {
      if (event.type === "message_start" && event.message?.role === "assistant") {
        lastAssistantHadContent = false;
        lastAssistantMessage = null;
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        lastAssistantMessage = event.message;
        const content: any[] = Array.isArray(event.message.content) ? event.message.content : [];
        const hasText = content.some((c: any) => c.type === "text" && c.text?.trim());
        const hasToolCalls = content.some((c: any) => c.type === "toolCall");
        if (hasText || hasToolCalls) lastAssistantHadContent = true;
      }
      if (
        event.type === "tool_execution_end" &&
        typeof event.toolName === "string" &&
        event.isError !== true &&
        event.result?.details?.error === undefined &&
        event.result?.details?.structuredContent !== null &&
        typeof event.result?.details?.structuredContent === "object" &&
        !Array.isArray(event.result?.details?.structuredContent)
      ) {
        successfulTools.add(event.toolName);
      }
    });

    try {
      await this.session.prompt(text, promptOptions);

      // Empty response guard: some models (e.g. Kimi-K2.5) occasionally return
      // a completely empty response (0 content blocks) on the final turn after
      // tool results. Retry up to MAX_EMPTY_RETRIES times with backoff.
      //
      // Skip retry when stopReason === "aborted": the empty turn was produced
      // by an intentional abort (user Stop, or an extension force-aborting a
      // turn). Re-prompting the original text in that case re-runs input
      // handlers and can corrupt extension state.
      //
      // Skip retry when stopReason === "error": pi-agent-core has already
      // exhausted its transport-level retries by the time it surfaces a
      // failed turn this way (auth/billing/network give-up). Re-prompting just
      // hammers the same failure, while each retry emits agent_start /
      // agent_end pairs that flicker the frontend Thinking indicator on/off
      // even though stream_error has already shown the user the error bubble.
      let retries = 0;
      while (
        !lastAssistantHadContent &&
        !this.aborted &&
        lastAssistantMessage?.stopReason !== "aborted" &&
        lastAssistantMessage?.stopReason !== "error" &&
        retries < PiAgentBrain.MAX_EMPTY_RETRIES
      ) {
        retries++;
        const msg = lastAssistantMessage;
        const delayMs = PiAgentBrain.RETRY_DELAY_MS * retries;
        console.warn(
          `[pi-agent-brain] Empty response detected (attempt ${retries}/${PiAgentBrain.MAX_EMPTY_RETRIES}), ` +
          `retrying in ${delayMs}ms, ` +
          `stopReason=${msg?.stopReason ?? "unknown"}, ` +
          `model=${msg?.model ?? "unknown"}, ` +
          `usage=${JSON.stringify(msg?.usage ?? {})}, ` +
          `content=${JSON.stringify(msg?.content ?? [])}`,
        );
        this.emit({
          type: "auto_retry_start",
          attempt: retries,
          maxAttempts: PiAgentBrain.MAX_EMPTY_RETRIES,
          delayMs,
          errorMessage: "Model returned empty response",
        });
        try {
          await this.abortableSleep(delayMs);
          // Stop landed during the backoff: do NOT fire a fresh, un-aborted re-prompt.
          if (this.aborted) break;
          await this.session.prompt(text, promptOptions);
        } finally {
          // A user Stop landing in the backoff is not an empty-response failure — don't label it
          // one (telemetry/alerting could otherwise count Stops as model defects).
          this.emit({
            type: "auto_retry_end",
            attempt: retries,
            success: lastAssistantHadContent,
            finalError: lastAssistantHadContent || this.aborted ? undefined : "Model returned empty response",
          });
        }
      }

      if (!lastAssistantHadContent && !this.aborted) {
        const msg = lastAssistantMessage;
        console.error(
          `[pi-agent-brain] Empty response persisted after ${PiAgentBrain.MAX_EMPTY_RETRIES} retries, ` +
          `stopReason=${msg?.stopReason ?? "unknown"}, ` +
          `model=${msg?.model ?? "unknown"}, ` +
          `usage=${JSON.stringify(msg?.usage ?? {})}`,
        );
      }

      const requiredResultToolName = requirements?.requiredResultToolName?.trim();
      if (
        requiredResultToolName &&
        !this.aborted &&
        lastAssistantMessage?.stopReason !== "aborted" &&
        lastAssistantMessage?.stopReason !== "error" &&
        !successfulTools.has(requiredResultToolName)
      ) {
        await this.repairMissingRequiredResult(requiredResultToolName, successfulTools);
      }
    } finally {
      unsub();
      this.llmCalls?.endPrompt();
    }
  }

  /**
   * Perform one bounded repair after the normal agent run omitted its required
   * result. The repair sees the full session context, but only the contracted
   * tool is exposed and the first provider request is forced to use a tool.
   * This turns a prompt convention into a runtime guarantee without forcing
   * the result tool before the agent has finished knowledge/tool gathering.
   */
  private async repairMissingRequiredResult(
    requiredToolName: string,
    successfulTools: ReadonlySet<string>,
  ): Promise<void> {
    const session = this.session as AgentSession & {
      getActiveToolNames?: () => string[];
      setActiveToolsByName?: (names: string[]) => void;
      agent: AgentSession["agent"] & { streamFn: (...args: any[]) => any };
    };
    const activeToolNames = session.getActiveToolNames?.() ?? [];
    if (!activeToolNames.includes(requiredToolName) || !session.setActiveToolsByName) {
      console.error(`[pi-agent-brain] Required result tool is not active: ${requiredToolName}`);
      this.emit({ type: "required_result_repair_start", toolName: requiredToolName });
      this.emit({
        type: "required_result_repair_end",
        toolName: requiredToolName,
        success: false,
        reason: "required_tool_inactive",
      });
      return;
    }

    const originalStreamFn = session.agent.streamFn;
    let forceNextProviderRequest = true;
    session.agent.streamFn = ((model: any, context: any, options?: Record<string, unknown>) => {
      // AgentSession can auto-compact before starting the repair turn. Compaction
      // uses the same streamFn but carries no result tool; do not spend the
      // one-shot force on that unrelated provider request.
      const forceThisRequest = forceNextProviderRequest && contextHasTool(context, requiredToolName);
      if (forceThisRequest) forceNextProviderRequest = false;
      return originalStreamFn(model, context, forceThisRequest
        ? requiredResultRepairOptions(model, options, requiredToolName)
        : options);
    }) as typeof session.agent.streamFn;

    this.emit({ type: "required_result_repair_start", toolName: requiredToolName });
    this.requiredResultRepairActive = true;
    session.setActiveToolsByName([requiredToolName]);
    try {
      await session.prompt(PiAgentBrain.REQUIRED_RESULT_REPAIR_PROMPT);
    } finally {
      session.agent.streamFn = originalStreamFn;
      session.setActiveToolsByName(activeToolNames);
      this.requiredResultRepairActive = false;
      this.emit({
        type: "required_result_repair_end",
        toolName: requiredToolName,
        success: successfulTools.has(requiredToolName),
      });
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.abortRetry?.();
    // session.abort() (agent.abort + waitForIdle) aborts the RUN's controller — but auto-compaction
    // and routing-preflight compaction use SEPARATE controllers it does not touch. Abort those too,
    // so a Stop during compaction cancels the compaction LLM call AND lets waitForIdle() resolve
    // promptly instead of blocking until compaction finishes. Defensive optional — older cores or
    // a non-pi brain may not expose it.
    try { (this.session as { abortCompaction?: () => void }).abortCompaction?.(); }
    catch { /* best-effort */ }
    return this.session.abort();
  }

  subscribe(listener: (event: any) => void): () => void {
    // Subscribe to both pi-agent events AND our own retry events
    this.extraListeners.add(listener);
    const unsubSession = this.session.subscribe((event: any) => listener(this.enrichToolEvent(event)));
    return () => {
      this.extraListeners.delete(listener);
      unsubSession();
    };
  }

  reload(): Promise<void> {
    return this.session.reload();
  }

  steer(text: string, media?: PromptMedia): Promise<void> {
    if (this.requiredResultRepairActive) {
      const err = new Error("A required-result repair is in progress; submit this input as a new turn");
      err.name = "RequiredResultRepairInProgress";
      return Promise.reject(err);
    }
    const promptOptions = this.promptOptionsForMedia(media);
    if (!promptOptions) {
      return this.session.steer(text);
    }
    return this.session.prompt(text, { ...promptOptions, streamingBehavior: "steer" });
  }

  followUp(text: string): Promise<void> {
    return this.session.followUp(text);
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    return this.session.clearQueue();
  }

  getContextUsage(): BrainContextUsage | undefined {
    const usage = this.session.getContextUsage();
    if (!usage || usage.tokens == null) return undefined;
    return {
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: usage.percent ?? 0,
    };
  }

  getSessionStats(): BrainSessionStats {
    const stats = this.session.getSessionStats();
    return {
      tokens: stats.tokens,
      cost: stats.cost,
    };
  }

  getModel(): BrainModelInfo | undefined {
    const model = this.session.model;
    if (!model) return undefined;
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      api: model.api,
      maxTokensField: readMaxTokensField(model.compat),
      forceAdaptiveThinking: readCompatBoolean(model.compat, "forceAdaptiveThinking"),
    };
  }

  /**
   * The model-visible tool set. The session is built with noTools:"builtin", so
   * getAllTools() is exactly the model-visible set (allowedTools-filtered custom
   * tools + MCP + restricted file tools + extension tools). `parameters` is a
   * TypeBox TSchema, which serialises to a JSON schema.
   */
  getTools(): BrainToolDefinition[] {
    return this.session.getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  async setModel(info: BrainModelInfo): Promise<void> {
    const model = this.session.modelRegistry.find(info.provider, info.id);
    if (model) {
      await this.session.setModel(model);
    }
  }

  findModel(provider: string, modelId: string): BrainModelInfo | undefined {
    const model = this.session.modelRegistry.find(provider, modelId);
    if (!model) return undefined;
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      api: model.api,
      maxTokensField: readMaxTokensField(model.compat),
      forceAdaptiveThinking: readCompatBoolean(model.compat, "forceAdaptiveThinking"),
    };
  }

  registerProvider(name: string, config: Record<string, unknown>): void {
    this.session.modelRegistry.registerProvider(name, config as any);
  }

  /**
   * Snapshot the tunables in effect, for restoring after a failed tier attempt.
   *
   * See `BrainSession.captureModelParams`: pi's `setModel` carries the current
   * thinking level across a switch when the target supports thinking
   * (`_getThinkingLevelForModelSwitch` returns `this.thinkingLevel`), so nothing
   * in the ordinary set/switch path puts a raised level back down.
   */
  captureModelParams(): BrainModelParams | undefined {
    try {
      const level = this.session.thinkingLevel;
      return typeof level === "string" ? { reasoningEffort: level } : undefined;
    } catch {
      return undefined;
    }
  }

  applyModelParams(params: BrainModelParams): void {
    // reasoningEffort → session thinking level. pi maps this to the provider's
    // reasoning_effort / reasoning:{effort} per the provider's thinkingLevelMap.
    const effort = params.reasoningEffort?.trim();
    if (effort && THINKING_LEVELS.has(effort)) {
      this.session.setThinkingLevel(effort as any);
    }
  }

  /**
   * Pure fit check — see `BrainSession.checkContextFitForModelPrompt`.
   *
   * Shares the estimation with `ensureContextForModelPrompt` but stops at the
   * verdict: it never calls `session.compact()`, so it neither rewrites history
   * nor issues a model request. `compacted` is therefore always false.
   *
   * Note it deliberately does NOT consult `compaction.enabled`: this answers
   * "does it fit", and whether compaction *could* rescue an over-budget prompt is
   * the caller's decision, not part of the measurement.
   */
  checkContextFitForModelPrompt(
    model: BrainModelInfo,
    text: string,
  ): BrainContextPreflightResult {
    const settings = this.session.settingsManager.getCompactionSettings();
    const contextWindow = Math.max(0, Math.floor(model.contextWindow || 0));
    const reserveTokens = Math.max(0, Math.floor(settings.reserveTokens || 0));
    const promptTokens = estimatePromptTokens(text) + Math.min(
      PiAgentBrain.PROMPT_PREFLIGHT_SAFETY_TOKENS,
      Math.max(0, Math.floor(contextWindow * 0.02)),
    );
    const budget = contextWindow - reserveTokens;

    if (contextWindow <= 0) {
      return {
        ok: false,
        compacted: false,
        contextWindow,
        errorMessage: `Context fit check failed for ${model.provider}/${model.id}: context window must be greater than 0 tokens (received ${contextWindow}).`,
      };
    }
    if (budget <= 0) {
      return {
        ok: false,
        compacted: false,
        contextWindow,
        errorMessage: `Context fit check failed for ${model.provider}/${model.id}: context window ${contextWindow} tokens must exceed compaction reserve ${reserveTokens} tokens.`,
      };
    }

    // A REQUEST is not just the conversation. On a freshly created sub-agent the
    // message history is nearly empty while the system prompt, the skill/knowledge
    // preamble folded into it, and the tool schemas are the bulk of what gets sent
    // — so counting messages alone would pass a tier whose window the real request
    // then overflows, and by then the prompt has started and cannot be taken back.
    const tokens =
      estimateCurrentContextTokens(this.session)
      + estimateRequestOverheadTokens(this.session)
      + promptTokens;
    if (tokens > budget) {
      return {
        ok: false,
        compacted: false,
        tokens,
        contextWindow,
        errorMessage: `Context fit check failed: estimated ${tokens} tokens exceeds ${model.provider}/${model.id} budget ${budget}.`,
      };
    }
    return { ok: true, compacted: false, tokens, contextWindow };
  }

  async ensureContextForModelPrompt(
    model: BrainModelInfo,
    text: string,
  ): Promise<BrainContextPreflightResult> {
    const settings = this.session.settingsManager.getCompactionSettings();
    const contextWindow = Math.max(0, Math.floor(model.contextWindow || 0));
    const reserveTokens = Math.max(0, Math.floor(settings.reserveTokens || 0));
    const promptTokens = estimatePromptTokens(text) + Math.min(
      PiAgentBrain.PROMPT_PREFLIGHT_SAFETY_TOKENS,
      Math.max(0, Math.floor(contextWindow * 0.02)),
    );
    const budget = contextWindow - reserveTokens;
    if (contextWindow <= 0) {
      return {
        ok: false,
        compacted: false,
        contextWindow,
        errorMessage: `Context preflight failed for ${model.provider}/${model.id}: context window must be greater than 0 tokens (received ${contextWindow}). Configure a positive context window for this model.`,
      };
    }
    if (budget <= 0) {
      return {
        ok: false,
        compacted: false,
        contextWindow,
        errorMessage: `Context preflight failed for ${model.provider}/${model.id}: context window ${contextWindow} tokens must exceed compaction reserve ${reserveTokens} tokens. Increase the model context window or lower compaction.reserveTokens.`,
      };
    }

    const beforeTokens = estimateCurrentContextTokens(this.session) + promptTokens;
    if (beforeTokens <= budget) {
      return { ok: true, compacted: false, tokens: beforeTokens, contextWindow };
    }
    if (!settings.enabled) {
      return {
        ok: false,
        compacted: false,
        tokens: beforeTokens,
        contextWindow,
        errorMessage: `Context preflight failed: estimated ${beforeTokens} tokens exceeds ${model.provider}/${model.id} window ${contextWindow} and compaction is disabled.`,
      };
    }

    try {
      await this.session.compact(
        `Prepare this session to continue on ${model.provider}/${model.id} with a ${contextWindow} token context window. Preserve the user's latest request, current task state, decisions, constraints, tool findings, and exact identifiers needed to continue.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        compacted: false,
        tokens: beforeTokens,
        contextWindow,
        errorMessage: `Context preflight compaction failed before using ${model.provider}/${model.id}: ${message}`,
      };
    }

    const afterTokens = estimateCurrentContextTokens(this.session) + promptTokens;
    if (afterTokens > budget) {
      return {
        ok: false,
        compacted: true,
        tokens: afterTokens,
        contextWindow,
        errorMessage: `Context preflight failed after compaction: estimated ${afterTokens} tokens still exceeds ${model.provider}/${model.id} budget ${budget}.`,
      };
    }
    return { ok: true, compacted: true, tokens: afterTokens, contextWindow };
  }

  captureProviderResponse(listener: (response: BrainProviderResponse) => void): () => void {
    const agent = (this.session as unknown as { agent?: { onResponse?: unknown } }).agent;
    if (!agent || typeof agent !== "object") return () => {};

    const previous = typeof agent.onResponse === "function" ? agent.onResponse : undefined;
    const wrapped = async (response: unknown, model: unknown) => {
      try {
        const status = isRecord(response) && typeof response.status === "number" ? response.status : undefined;
        if (status !== undefined) {
          listener({
            status,
            headers: normalizeHeaders(isRecord(response) ? response.headers : undefined),
            provider: isRecord(model) && typeof model.provider === "string" ? model.provider : undefined,
            modelId: isRecord(model) && typeof model.id === "string" ? model.id : undefined,
          });
        }
      } catch {
        // Best-effort telemetry; never let routing observation break provider streaming.
      }
      if (previous) {
        return previous.call(agent, response, model);
      }
    };

    agent.onResponse = wrapped;
    return () => {
      if (agent.onResponse === wrapped) agent.onResponse = previous;
    };
  }

  createPromptCheckpoint(): unknown {
    return this.session.sessionManager.getLeafId();
  }

  restorePromptCheckpoint(checkpoint: unknown): void {
    const sessionManager = this.session.sessionManager;
    if (typeof checkpoint === "string") {
      if (!sessionManager.getEntry(checkpoint)) {
        throw new Error(`Prompt checkpoint entry not found: ${checkpoint}`);
      }
      sessionManager.branch(checkpoint);
    } else {
      sessionManager.resetLeaf();
    }
    this.session.agent.state.messages = sessionManager.buildSessionContext().messages;
  }
}

function estimatePromptTokens(text: string): number {
  return estimateMessagesTokens([
    {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    } as any,
  ]);
}

/**
 * Tokens a request carries beyond the conversation: the system prompt and every
 * active tool's schema.
 *
 * `estimateCurrentContextTokens` prefers pi's own `getContextUsage()`, which
 * reports what the LAST request actually consumed. A session that has never
 * prompted has no such reading and falls back to counting messages — and a
 * just-created sub-agent's messages are nearly empty while its system prompt and
 * tool schemas are most of the payload. Without this, a fit check against a
 * smaller tier window passes on a child that cannot possibly fit.
 *
 * Deliberately an over-estimate rather than an under-estimate: being wrong high
 * costs a needless fallback to the parent model, being wrong low costs a
 * mid-stream failure that nothing can recover from.
 *
 * Defensive throughout — this runs on a hot-ish path against an SDK surface we do
 * not own, and a fit check that throws would be worse than one that guesses.
 */
function estimateRequestOverheadTokens(session: AgentSession): number {
  let text = "";
  try {
    const systemPrompt = session.systemPrompt;
    if (typeof systemPrompt === "string") text += systemPrompt;
  } catch { /* not exposed on this build — fall through to tools */ }

  try {
    const tools = session.getAllTools?.();
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        // name + description + parameter schema, which is what a provider is sent.
        text += JSON.stringify(tool ?? "");
      }
    }
  } catch { /* ignore — the system prompt alone is still better than nothing */ }

  return estimatePromptTokens(text);
}

function estimateCurrentContextTokens(session: AgentSession): number {
  const usage = session.getContextUsage();
  if (usage && typeof usage.tokens === "number" && Number.isFinite(usage.tokens)) {
    return Math.max(0, Math.ceil(usage.tokens));
  }
  const messages = Array.isArray(session.agent.state.messages) ? session.agent.state.messages : [];
  return estimateMessagesTokens(messages as any[]);
}

function normalizeHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  const setHeader = (key: unknown, headerValue: unknown): void => {
    if (typeof key !== "string" || key.trim() === "") return;
    if (typeof headerValue === "string" || typeof headerValue === "number" || typeof headerValue === "boolean") {
      headers[key.toLowerCase()] = String(headerValue);
    }
  };

  if (!value) return headers;

  const maybeForEach = (value as { forEach?: unknown }).forEach;
  if (typeof maybeForEach === "function") {
    maybeForEach.call(value, (headerValue: unknown, key: unknown) => setHeader(key, headerValue));
    return headers;
  }

  const maybeEntries = (value as { entries?: unknown }).entries;
  if (typeof maybeEntries === "function") {
    for (const entry of maybeEntries.call(value) as Iterable<unknown>) {
      if (Array.isArray(entry) && entry.length >= 2) setHeader(entry[0], entry[1]);
    }
    return headers;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (Array.isArray(entry) && entry.length >= 2) setHeader(entry[0], entry[1]);
    }
    return headers;
  }

  if (!isRecord(value)) return headers;
  for (const [key, headerValue] of Object.entries(value)) {
    setHeader(key, headerValue);
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
