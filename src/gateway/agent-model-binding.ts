/**
 * Resolve an agent's bound model provider + entry into a full modelConfig
 * payload that AgentBox's /api/prompt accepts.
 *
 * Resolution goes through FrontendWsClient RPC.
 */

import type { FrontendWsClient } from "./frontend-ws-client.js";
import type { ModelRoutePolicy } from "../core/model-routing.js";
import { normalizeProviderApi } from "../core/model-compat.js";

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
      /** Per-model protocol override; absent = inherit the provider's `api`. */
      api?: string;
      reasoning: boolean;
      input: string[];
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow: number;
      maxTokens: number;
      compat?: Record<string, unknown>;
    }>;
  };
  modelRouting?: ModelRoutePolicy;
  /** Agent-owned identity/behaviour prompt (agents.system_prompt). */
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
    if (!data.binding) return null;
    const binding = data.binding;
    return {
      ...binding,
      modelConfig: {
        ...binding.modelConfig,
        api: normalizeProviderApi(binding.modelConfig.api),
        models: binding.modelConfig.models.map((model) => ({
          ...model,
          ...(model.api ? { api: normalizeProviderApi(model.api) } : {}),
        })),
      },
    };
  } catch (err) {
    console.error(`[agent-model-binding] RPC error:`, err);
    return null;
  }
}

/**
 * Resolve an agent's persisted identity/behaviour prompt via Portal RPC.
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
