/**
 * PiAgentBrain — BrainSession implementation wrapping pi-coding-agent's AgentSession.
 *
 * Thin delegation layer. Exposes the underlying `session` for pi-agent-specific
 * hacks (streamFn, dequeue, agent internals) that live in agent-factory.ts.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type {
  BrainSession,
  BrainModelInfo,
  BrainContextUsage,
  BrainSessionStats,
} from "../brain-session.js";

export class PiAgentBrain implements BrainSession {
  readonly brainType = "pi-agent" as const;

  constructor(readonly session: AgentSession) {}

  prompt(text: string): Promise<void> {
    return this.session.prompt(text);
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  subscribe(listener: (event: any) => void): () => void {
    return this.session.subscribe(listener);
  }

  reload(): Promise<void> {
    return this.session.reload();
  }

  steer(text: string): Promise<void> {
    return this.session.steer(text);
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
}
