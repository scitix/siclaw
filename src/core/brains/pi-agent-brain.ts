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
  BrainContextUsage,
  BrainSessionStats,
  BrainProviderResponse,
} from "../brain-session.js";

export class PiAgentBrain implements BrainSession {
  readonly brainType = "pi-agent" as const;

  /** Extra listeners for retry events not emitted by pi-agent itself.
   *  Merged with pi-agent's own subscribers in subscribe(). */
  private extraListeners = new Set<(event: any) => void>();

  /** Set during prompt(); abort() resolves this to cancel backoff sleep. */
  private abortRetry: (() => void) | null = null;

  constructor(readonly session: AgentSession) {}

  private static readonly MAX_EMPTY_RETRIES = 2;
  private static readonly RETRY_DELAY_MS = 2000;

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

  async prompt(text: string): Promise<void> {
    let lastAssistantHadContent = false;
    let lastAssistantMessage: any = null;

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
    });

    try {
      await this.session.prompt(text);

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
          await this.session.prompt(text);
        } finally {
          this.emit({
            type: "auto_retry_end",
            attempt: retries,
            success: lastAssistantHadContent,
            finalError: lastAssistantHadContent ? undefined : "Model returned empty response",
          });
        }
      }

      if (!lastAssistantHadContent) {
        const msg = lastAssistantMessage;
        console.error(
          `[pi-agent-brain] Empty response persisted after ${PiAgentBrain.MAX_EMPTY_RETRIES} retries, ` +
          `stopReason=${msg?.stopReason ?? "unknown"}, ` +
          `model=${msg?.model ?? "unknown"}, ` +
          `usage=${JSON.stringify(msg?.usage ?? {})}`,
        );
      }
    } finally {
      unsub();
    }
  }

  async abort(): Promise<void> {
    this.abortRetry?.();
    return this.session.abort();
  }

  subscribe(listener: (event: any) => void): () => void {
    // Subscribe to both pi-agent events AND our own retry events
    this.extraListeners.add(listener);
    const unsubSession = this.session.subscribe(listener);
    return () => {
      this.extraListeners.delete(listener);
      unsubSession();
    };
  }

  reload(): Promise<void> {
    return this.session.reload();
  }

  steer(text: string): Promise<void> {
    return this.session.steer(text);
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
    };
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
    };
  }

  registerProvider(name: string, config: Record<string, unknown>): void {
    this.session.modelRegistry.registerProvider(name, config as any);
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
