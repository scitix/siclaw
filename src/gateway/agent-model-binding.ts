/**
 * Resolve an agent's bound model provider + entry into a full modelConfig
 * payload that AgentBox's /api/prompt accepts.
 *
 * Used by any caller initiating a prompt on an agent's behalf (web chat
 * proxy, cron coordinator, future external API trigger). Centralises the
 * three-table join so the fallback-to-env bug that fires when modelConfig
 * is omitted cannot re-emerge per caller.
 */

import { getDb } from "./db.js";

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

export async function resolveAgentModelBinding(agentId: string): Promise<ResolvedModelBinding | null> {
  const db = getDb();
  const [agentRows] = (await db.query(
    "SELECT model_provider, model_id FROM agents WHERE id = ?",
    [agentId],
  )) as any;
  const agent = agentRows[0] as { model_provider?: string; model_id?: string } | undefined;
  if (!agent?.model_provider || !agent?.model_id) return null;

  const [providerRows] = (await db.query(
    "SELECT id, name, base_url, api_key, api_type FROM model_providers WHERE name = ? LIMIT 1",
    [agent.model_provider],
  )) as any;
  const provider = providerRows[0] as
    | { id: string; name: string; base_url: string; api_key: string | null; api_type: string }
    | undefined;
  if (!provider) return null;

  const [entryRows] = (await db.query(
    "SELECT model_id, name, reasoning, context_window, max_tokens FROM model_entries WHERE provider_id = ?",
    [provider.id],
  )) as any;
  const models = (entryRows as Array<{
    model_id: string;
    name: string | null;
    reasoning: number;
    context_window: number;
    max_tokens: number;
  }>).map((m) => ({
    id: m.model_id,
    name: m.name ?? m.model_id,
    reasoning: !!m.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.context_window,
    maxTokens: m.max_tokens,
  }));

  return {
    modelProvider: provider.name,
    modelId: agent.model_id,
    modelConfig: {
      name: provider.name,
      baseUrl: provider.base_url,
      apiKey: provider.api_key ?? "",
      api: provider.api_type,
      authHeader: true,
      models,
    },
  };
}
