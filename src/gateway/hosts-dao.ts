/**
 * DAO for host access scoped by agent binding (agent_hosts).
 *
 * Mirrors clusters-dao.ts structurally, but separates list/get into two SQL
 * paths so that listHostsForAgent never pulls password/private_key into the
 * V8 heap. Only getHostByNameForAgent — which exists specifically to issue a
 * credential payload — selects the secret columns.
 *
 * An agent can only see / acquire hosts explicitly bound via the agent_hosts
 * junction table (UI: Portal > Agent detail page).
 */

import { getDb } from "./db.js";

export interface HostMetaRow {
  id: string;
  name: string;
  description: string | null;
  ip: string;
  port: number;
  username: string;
  auth_type: "password" | "key";
  is_production: number;
}

export interface HostRow extends HostMetaRow {
  password: string | null;
  private_key: string | null;
}

const META_COLUMNS = "h.id, h.name, h.description, h.ip, h.port, h.username, h.auth_type, h.is_production";
const FULL_COLUMNS = `${META_COLUMNS}, h.password, h.private_key`;

/**
 * List hosts bound to the given agent — metadata only, no secrets. Callers
 * that need to issue a credential must follow up with getHostByNameForAgent.
 */
export async function listHostsForAgent(agentId: string): Promise<HostMetaRow[]> {
  const db = getDb();
  const [rows] = await db.query(
    `SELECT ${META_COLUMNS}
     FROM agent_hosts ah
     JOIN hosts h ON ah.host_id = h.id
     WHERE ah.agent_id = ?
     ORDER BY h.name`,
    [agentId],
  ) as [HostMetaRow[], unknown];
  return rows;
}

/**
 * Fetch a single host by name (with secrets), only if the agent is bound.
 * INNER JOIN on agent_hosts enforces the binding — no separate permission
 * query needed. Returns null when the host doesn't exist or the agent isn't
 * bound.
 */
export async function getHostByNameForAgent(
  agentId: string,
  hostName: string,
): Promise<HostRow | null> {
  const db = getDb();
  const [rows] = await db.query(
    `SELECT ${FULL_COLUMNS}
     FROM agent_hosts ah
     JOIN hosts h ON ah.host_id = h.id
     WHERE ah.agent_id = ? AND h.name = ?
     LIMIT 1`,
    [agentId, hostName],
  ) as [HostRow[], unknown];
  return rows[0] ?? null;
}
