/**
 * BrainSession — unified interface for the AI agent backend.
 *
 * Consumers (http-server, session.ts, cli-main) program against this interface.
 * Implementation: PiAgentBrain (pi-coding-agent).
 *
 * Event protocol follows the pi-agent format (frontend already adapted):
 * - agent_start/end, turn_start/end, message_start/end
 * - message_update → { assistantMessageEvent: { type: "text_delta", delta } }
 * - tool_execution_start → { toolName, args }
 * - tool_execution_end → { toolName, result, isError }
 * - auto_compaction_start/end, auto_retry_start/end
 */

import type { LlmCallPromptBoundary } from "./llm-call-recorder.js";

export type BrainType = "pi-agent";

/**
 * An image attachment to send alongside a prompt. `data` is raw base64 (no
 * `data:` URL prefix); the provider layer builds the data URL. Only carried
 * through to vision-capable models.
 */
export interface PromptImage {
  mimeType: string;
  data: string;
}

export interface PromptFile {
  mimeType: string;
  filename: string;
  data: string;
}

export interface PromptMedia {
  images?: PromptImage[];
  files?: PromptFile[];
}

/** Runtime-only completion requirements supplied by a trusted control plane. */
export interface PromptRequirements {
  /**
   * Exact MCP result tool that must succeed before this prompt may finish.
   * The normal agent run remains unrestricted. If it omits the result, the
   * runtime performs one bounded, tool-forced repair pass.
   */
  requiredResultToolName?: string;
}

export interface BrainModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /**
   * Wire protocol the model speaks ("openai-completions", "anthropic-messages",
   * …). Carried so callers can tell that a re-bind is needed when ONLY the
   * protocol changed — a per-model `api_type` override toggled in Portal leaves
   * id, provider and every size field untouched, and without this the session
   * silently keeps talking the old protocol.
   */
  api?: string;
  /**
   * Which request field carries the output-token cap (`compat.maxTokensField`).
   *
   * The same failure as `api`, one layer down: correcting only this leaves
   * id/provider/size fields identical, so a rebind check that omits it skips
   * `setModel` and the session keeps issuing turns on the field it was bound
   * with. Read off pi's compat union via `readMaxTokensField` — the key exists
   * only on the chat-completions variant.
   */
  maxTokensField?: string;
  /**
   * `compat.forceAdaptiveThinking` — the Anthropic thinking request shape.
   *
   * The same failure as `api` and `maxTokensField`, and the sharpest of the
   * three: correcting a model from the legacy `thinking:{type:"enabled"}` to
   * `{type:"adaptive"}` changes nothing about its id, provider or sizes, so a
   * rebind check omitting it keeps issuing the shape Claude 4.6+ and the 5
   * family reject with a 400.
   */
  forceAdaptiveThinking?: boolean;
}

/**
 * Whether a session bound to `current` has to be re-bound to `next`.
 *
 * Compares every field that changes how a turn is ISSUED. `api` and
 * `maxTokensField` matter as much as the rest: either one can change alone
 * while id, provider and all size fields stay identical, and omitting it here
 * leaves the session talking the old protocol — or naming the old max-tokens
 * field — even after the registry has been re-registered. Both are rejected
 * outright by the provider ("unsupported_protocol" / "please use
 * MaxCompletionTokens"), not silently.
 *
 * Single definition on purpose: this rule previously existed twice (the model
 * routing runner and the agentbox prompt path) and both copies were missing the
 * same field. Anything added to `BrainModelInfo` that affects request shape
 * must be propagated in BOTH `getModel()` and `findModel()` (they narrow pi's
 * Model and silently drop what they don't list) and compared here.
 */
export function modelNeedsRebind(
  current: BrainModelInfo | undefined,
  next: BrainModelInfo,
): boolean {
  return !current
    || current.id !== next.id
    || current.provider !== next.provider
    || current.api !== next.api
    || current.reasoning !== next.reasoning
    || current.contextWindow !== next.contextWindow
    || current.maxTokens !== next.maxTokens
    || current.maxTokensField !== next.maxTokensField
    || current.forceAdaptiveThinking !== next.forceAdaptiveThinking;
}

/**
 * A model-visible tool, in a provider-neutral shape. `parameters` is the tool's
 * JSON-schema-ish parameter definition (pi's TypeBox TSchema serialises to one).
 * Consumed by the trace recorder to emit Langfuse tool-definition data — see
 * docs/design/2026-07-08-langfuse-tool-instrumentation.md "Data-source contract".
 */
export interface BrainToolDefinition {
  name: string;
  description?: string;
  parameters?: unknown;
}

/** Per-model runtime tunables forwarded from the control plane's modelConfig.params. */
export interface BrainModelParams {
  /** Reasoning effort: off|minimal|low|medium|high|xhigh. */
  reasoningEffort?: string;
}

export interface BrainContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export interface BrainSessionStats {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

export interface BrainProviderResponse {
  provider?: string;
  modelId?: string;
  status: number;
  headers: Record<string, string>;
}

export interface BrainContextPreflightResult {
  ok: boolean;
  compacted: boolean;
  tokens?: number;
  contextWindow?: number;
  errorMessage?: string;
}

export interface BrainSession {
  readonly brainType: BrainType;

  /**
   * Optional: prompt / routing-attempt boundaries for the LLM call recorder
   * (`src/core/llm-call-recorder.ts`). The agentbox HTTP layer marks receipt and
   * completion so round 1's `since_prev_ms` covers setup; the routing runner's
   * attempt events rewind rounds on rollback.
   */
  readonly llmCalls?: LlmCallPromptBoundary;

  /** Send a prompt to the agent. Resolves when the agent finishes responding. */
  prompt(text: string, media?: PromptMedia, requirements?: PromptRequirements): Promise<void>;

  /** Abort the current agent run. */
  abort(): Promise<void>;

  /** Subscribe to agent events. Returns an unsubscribe function. */
  subscribe(listener: (event: any) => void): () => void;

  /** Reload resources (skills, system prompt). */
  reload(): Promise<void>;

  /** Interrupt mid-run and inject a user message. */
  steer(text: string, media?: PromptMedia): Promise<void>;

  /**
   * Queue a message delivered only after the agent finishes its current run (no
   * pending tool calls or steering). Used to inject a background-job completion
   * notification into an in-flight parent turn without interrupting it.
   */
  followUp(text: string): Promise<void>;

  /** Clear queued steer/followUp messages. */
  clearQueue(): { steering: string[]; followUp: string[] };

  /** Get current context window usage. */
  getContextUsage(): BrainContextUsage | undefined;

  /** Get cumulative session statistics. */
  getSessionStats(): BrainSessionStats;

  /** Get the currently active model. */
  getModel(): BrainModelInfo | undefined;

  /**
   * Optional: the model-visible tool set. Pulled live by the trace recorder (same
   * event-time pull pattern as getModel/getSessionStats) to emit tool definitions
   * on the llm.call generation. Absent → no tool definitions are recorded.
   */
  getTools?(): BrainToolDefinition[];

  /** Switch to a different model. */
  setModel(model: BrainModelInfo): Promise<void>;

  /** Find a model by provider + id. Returns undefined if not found. */
  findModel(provider: string, modelId: string): BrainModelInfo | undefined;

  /**
   * Optional preflight before prompting on the current model. Implementations
   * can compact when a fallback candidate has a smaller context window than the
   * active session history.
   */
  ensureContextForModelPrompt?(model: BrainModelInfo, text: string): Promise<BrainContextPreflightResult>;

  /**
   * PURE context-fit check: does this prompt fit that model's window as things
   * stand? Estimate only — no compaction, no model call, no session mutation.
   *
   * Distinct from {@link ensureContextForModelPrompt}, whose name is accurate:
   * that one COMPACTS when over budget, which rewrites history and spends a model
   * round-trip to produce the summary. Running it against a freshly created
   * sub-agent would compact the one thing that child's context consists of — its
   * task briefing — and would spend a model call to decide whether to spend a
   * model call.
   *
   * Used when switching a child onto a tier model whose window may be smaller
   * than the parent's: a miss falls back to the parent rather than attempting the
   * prompt and failing mid-stream.
   */
  checkContextFitForModelPrompt?(model: BrainModelInfo, text: string): BrainContextPreflightResult;

  /**
   * Read the runtime tunables currently in effect, so a caller can restore them.
   *
   * Needed because `applyModelParams` is a SETTER with no reset — an absent
   * `reasoningEffort` is a no-op, not a clear — and `setModel` does not restore a
   * default either: pi carries the current thinking level across a model switch
   * whenever the new model supports thinking, and only falls back to the default
   * when it does not. So a rejected sub-agent tier that raised the level leaves it
   * raised on the model it fell back to, silently changing that model's cost and
   * latency. Capture before, restore after.
   */
  captureModelParams?(): BrainModelParams | undefined;

  /** Register a provider dynamically (from gateway DB config). */
  registerProvider?(name: string, config: Record<string, unknown>): void;

  /**
   * Apply per-model runtime tunables delivered on the modelConfig (control plane
   * → modelConfig.params). Called per-prompt after setModel. Brains map what they
   * can and ignore the rest:
   *   - reasoningEffort → the session thinking level (any reasoning model)
   */
  applyModelParams?(params: BrainModelParams): void;

  /**
   * Optional provider-response tap. pi-agent exposes HTTP status/headers through
   * its onResponse hook; model routing uses this as a best-effort signal and
   * still falls back to final assistant errorMessage classification when absent.
   */
  captureProviderResponse?(listener: (response: BrainProviderResponse) => void): () => void;

  /**
   * Optional append-only conversation checkpoint used by model routing.
   * Implementations that support branching can restore this before replaying
   * the same user prompt on a fallback model, so failed attempts do not become
   * part of the active LLM context.
   */
  createPromptCheckpoint?(): unknown;
  restorePromptCheckpoint?(checkpoint: unknown): Promise<void> | void;
}
