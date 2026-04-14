/**
 * DAO for cluster access scoped by agent binding (agent_clusters).
 *
 * The gateway CredentialService uses this layer as the authoritative source
 * when EXTERNAL_CREDENTIAL_URL is not configured. An agent can only see and
 * acquire clusters that are explicitly bound via the agent_clusters junction
 * table (UI: Portal > Agent detail page).
 */

import { getDb } from "./db.js";

export interface ClusterRow {
  id: string;
  name: string;
  description: string | null;
  api_server: string | null;
  is_production: number;
  debug_image: string | null;
}

export interface ClusterRowWithKubeconfig extends ClusterRow {
  kubeconfig: string | null;
}

const META_COLUMNS = "c.id, c.name, c.description, c.api_server, c.is_production, c.debug_image";
const FULL_COLUMNS = `${META_COLUMNS}, c.kubeconfig`;

/**
 * List clusters bound to the given agent. Returns kubeconfig in the same row
 * so callers can parse contexts without an extra round-trip. `kubeconfig` is
 * still sensitive — callers that only need metadata should strip it before
 * handing rows to untrusted layers.
 */
export async function listClustersForAgent(agentId: string): Promise<ClusterRowWithKubeconfig[]> {
  const db = getDb();
  const [rows] = await db.query(
    `SELECT ${FULL_COLUMNS}
     FROM agent_clusters ac
     JOIN clusters c ON ac.cluster_id = c.id
     WHERE ac.agent_id = ?
     ORDER BY c.name`,
    [agentId],
  ) as [ClusterRowWithKubeconfig[], unknown];
  return rows;
}

/**
 * Fetch a single cluster by name, but only if the given agent is bound to it.
 * Returns null when the cluster doesn't exist or the agent isn't bound.
 * The binding check is enforced via INNER JOIN on agent_clusters — no separate
 * permission query needed.
 */
export async function getClusterByNameForAgent(
  agentId: string,
  clusterName: string,
): Promise<ClusterRowWithKubeconfig | null> {
  const db = getDb();
  const [rows] = await db.query(
    `SELECT ${FULL_COLUMNS}
     FROM agent_clusters ac
     JOIN clusters c ON ac.cluster_id = c.id
     WHERE ac.agent_id = ? AND c.name = ?
     LIMIT 1`,
    [agentId, clusterName],
  ) as [ClusterRowWithKubeconfig[], unknown];
  return rows[0] ?? null;
}
