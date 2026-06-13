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

export type BrainType = "pi-agent";

/**
 * An image attachment to send alongside a prompt. `data` is raw base64 (no
 * `data:` URL prefix); the provider layer builds the data URL. Only carried
 * through to vision-capable models — pi-ai downgrades images to a text
 * placeholder when the model's `input` does not include "image".
 */
export interface PromptImage {
  mimeType: string;
  data: string;
}

export interface BrainModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

/** Per-model runtime tunables forwarded from the control plane's modelConfig.params. */
export interface BrainModelParams {
  /** Reasoning effort: off|minimal|low|medium|high|xhigh. */
  reasoningEffort?: string;
  /** Provider service tier, e.g. "fast" (ChatGPT subscription). */
  serviceTier?: string;
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

  /** Send a prompt to the agent. Resolves when the agent finishes responding.
   *  `images` are passed to the model as vision input (vision-capable models only). */
  prompt(text: string, images?: PromptImage[]): Promise<void>;

  /** Abort the current agent run. */
  abort(): Promise<void>;

  /** Subscribe to agent events. Returns an unsubscribe function. */
  subscribe(listener: (event: any) => void): () => void;

  /** Reload resources (skills, system prompt). */
  reload(): Promise<void>;

  /** Interrupt mid-run and inject a user message. */
  steer(text: string): Promise<void>;

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

  /** Register a provider dynamically (from gateway DB config). */
  registerProvider?(name: string, config: Record<string, unknown>): void;

  /**
   * Apply per-model runtime tunables delivered on the modelConfig (control plane
   * → modelConfig.params). Called per-prompt after setModel. Brains map what they
   * can and ignore the rest:
   *   - reasoningEffort → the session thinking level (any reasoning model)
   *   - serviceTier     → a per-call provider option, e.g. "fast" (OpenAI family)
   * Absent fields reset to the brain's default so values never leak across turns.
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
