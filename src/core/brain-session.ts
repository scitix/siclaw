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

export interface BrainModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
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

export interface BrainSession {
  readonly brainType: BrainType;

  /** Send a prompt to the agent. Resolves when the agent finishes responding. */
  prompt(text: string): Promise<void>;

  /** Abort the current agent run. */
  abort(): Promise<void>;

  /** Subscribe to agent events. Returns an unsubscribe function. */
  subscribe(listener: (event: any) => void): () => void;

  /** Reload resources (skills, system prompt). */
  reload(): Promise<void>;

  /** Interrupt mid-run and inject a user message. */
  steer(text: string): Promise<void>;

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

  /** Register a provider dynamically (from gateway DB config). */
  registerProvider?(name: string, config: Record<string, unknown>): void;
}
