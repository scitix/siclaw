/**
 * Resolve an agent's bound model provider + entry into a full modelConfig
 * payload that AgentBox's /api/prompt accepts.
 *
 * Resolution goes through FrontendWsClient RPC.
 */

import type { FrontendWsClient } from "./frontend-ws-client.js";
import type { ModelRoutePolicy } from "../core/model-routing.js";

export interface ResolvedModelBinding {
  modelProvider: string;
  modelId: string;
  modelConfig: {
    name: string;
    baseUrl: string;
    apiKey: string;
    api: string;
    authHeader: boolean;
    models: Array<{
      id: string;
      name: string;
      reasoning: boolean;
      input: string[];
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow: number;
      maxTokens: number;
      compat?: Record<string, unknown>;
    }>;
  };
  modelRouting?: ModelRoutePolicy;
  /** Agent's custom system prompt template (agents.system_prompt). Null/absent = built-in default. */
  systemPrompt?: string | null;
  /**
   * Per-agent session/memory persistence toggle. siclaw core leaves this
   * undefined (no native per-agent store); a product portal that wants per-agent
   * persistence resolves it from its own data and carries it over chat.send.
   */
  persistence?: boolean;
}

export async function resolveAgentModelBinding(
  agentId: string,
  frontendClient: FrontendWsClient,
): Promise<ResolvedModelBinding | null> {
  try {
    const data = await frontendClient.request("config.getModelBinding", { agentId }) as { binding: ResolvedModelBinding | null };
    return data.binding;
  } catch (err) {
    console.error(`[agent-model-binding] RPC error:`, err);
    return null;
  }
}

/**
 * Resolve an agent's custom system prompt via Portal RPC (config.getAgent).
 *
 * Best-effort: callers (channel handlers) must never fail a user message just
 * because the prompt lookup failed — on any error this returns undefined and
 * the AgentBox session falls back to the built-in default template.
 */
export async function resolveAgentSystemPrompt(
  agentId: string,
  frontendClient?: FrontendWsClient,
): Promise<string | undefined> {
  if (typeof frontendClient?.request !== "function") return undefined;
  try {
    const agent = await frontendClient.request("config.getAgent", { agentId }) as { system_prompt?: string | null } | undefined;
    const prompt = agent?.system_prompt?.trim();
    return prompt || undefined;
  } catch (err) {
    console.error(`[agent-model-binding] config.getAgent RPC error:`, err);
    return undefined;
  }
}
