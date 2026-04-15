/**
 * Agent reload notifications — fire-and-forget with in-memory retry.
 *
 * After Portal saves agent config or resource bindings, it notifies
 * the Runtime to reload the active AgentBox. Retries are in-memory
 * only — if Portal restarts, pending retries are lost (acceptable
 * because AgentBox restart will pick up the latest config anyway).
 */

import { runtimeRpc } from "./chat-gateway.js";
import type { GatewaySyncType } from "../shared/gateway-sync.js";

const RETRY_DELAYS = [5_000, 15_000, 30_000]; // 3 retries: 5s, 15s, 30s

/**
 * Notify an agent's running AgentBox to reload specified resources.
 * Fire-and-forget: returns immediately, retries happen in background.
 */
export function notifyAgentReload(
  runtimeWsUrl: string,
  runtimeSecret: string,
  agentId: string,
  resources?: GatewaySyncType[],
): void {
  const params: Record<string, unknown> = { agentId };
  if (resources) params.resources = resources;

  attempt(runtimeWsUrl, runtimeSecret, agentId, params, 0);
}

function attempt(
  wsUrl: string,
  secret: string,
  agentId: string,
  params: Record<string, unknown>,
  retryIndex: number,
): void {
  runtimeRpc(wsUrl, secret, agentId, "agent.reload", params)
    .then((result) => {
      if (result.ok) {
        console.log(`[notify] agent.reload ok for agent=${agentId}`);
      } else {
        throw new Error(result.error || "RPC failed");
      }
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (retryIndex < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[retryIndex];
        console.warn(`[notify] agent.reload failed for agent=${agentId}: ${msg}, retrying in ${delay / 1000}s`);
        setTimeout(() => attempt(wsUrl, secret, agentId, params, retryIndex + 1), delay);
      } else {
        console.warn(`[notify] agent.reload failed for agent=${agentId} after ${RETRY_DELAYS.length} retries: ${msg}`);
      }
    });
}

/**
 * Notify multiple agents to reload.
 */
export function notifyAgentsReload(
  runtimeWsUrl: string,
  runtimeSecret: string,
  agentIds: string[],
  resources?: GatewaySyncType[],
): void {
  for (const agentId of agentIds) {
    notifyAgentReload(runtimeWsUrl, runtimeSecret, agentId, resources);
  }
}

/**
 * Query bound agents from DB and notify each to reload.
 * Used after cluster/host/mcp config changes.
 *
 * @param table    Junction table name (agent_clusters, agent_hosts, agent_mcp_servers)
 * @param column   Foreign key column (cluster_id, host_id, mcp_server_id)
 * @param resourceId  The changed resource's ID
 */
export function notifyBoundAgents(
  runtimeWsUrl: string,
  runtimeSecret: string,
  table: string,
  column: string,
  resourceId: string,
  resources: GatewaySyncType[],
): void {
  import("../gateway/db.js").then(({ getDb }) => {
    const db = getDb();
    db.query(`SELECT agent_id FROM ${table} WHERE ${column} = ?`, [resourceId])
      .then(([rows]: any) => {
        const agentIds = (rows as { agent_id: string }[]).map((r) => r.agent_id);
        if (agentIds.length === 0) return;
        console.log(`[notify] ${table}.${column}=${resourceId} → reloading ${agentIds.length} agent(s)`);
        notifyAgentsReload(runtimeWsUrl, runtimeSecret, agentIds, resources);
      })
      .catch((err: unknown) => {
        console.warn(`[notify] Failed to query bound agents from ${table}: ${err instanceof Error ? err.message : err}`);
      });
  });
}
