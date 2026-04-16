/**
 * Resolve an agent's bound model provider + entry into a full modelConfig
 * payload that AgentBox's /api/prompt accepts.
 *
 * Resolution goes through FrontendWsClient RPC.
 */

import type { FrontendWsClient } from "./frontend-ws-client.js";

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
