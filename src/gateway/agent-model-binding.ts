/**
 * Resolve an agent's bound model provider + entry into a full modelConfig
 * payload that AgentBox's /api/prompt accepts.
 *
 * Runtime no longer accesses the database directly — resolution goes
 * through Portal's adapter API.
 */

import type { RuntimeConfig } from "./config.js";

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
  config: RuntimeConfig,
): Promise<ResolvedModelBinding | null> {
  const resp = await fetch(`${config.serverUrl}/api/internal/siclaw/agent/${agentId}/model-binding`, {
    headers: { "X-Auth-Token": config.portalSecret },
  });
  if (!resp.ok) {
    console.error(`[agent-model-binding] Adapter returned ${resp.status}`);
    return null;
  }
  const data = await resp.json() as { binding: ResolvedModelBinding | null };
  return data.binding;
}
