import { getDb } from "../gateway/db.js";
import { identifier, record } from "../script-sandbox/validation.js";

type Handler = (params: any, connectionId: string) => Promise<any>;

/** Standalone Portal has no resource RBAC: restrict this feature to administrators. */
export function sandboxResolveHandler(handlers: Map<string, Handler>): Handler {
  return async (params, connectionId) => {
    if (!record(params) || Object.keys(params).some(k => !["agent_id", "session_id", "source", "name"].includes(k)) ||
      !identifier(params.agent_id) || !identifier(params.session_id) || typeof params.source !== "string" || typeof params.name !== "string" || !["", "cluster", "host", "mcp"].includes(String(params.source)) ||
      (params.source !== "" && !identifier(params.name))) throw new Error("Sandbox authorization denied");
    const db = getDb();
    const [rows] = await db.query(
      `SELECT s.user_id FROM chat_sessions s
       JOIN siclaw_users u ON u.id = s.user_id
       JOIN agents a ON a.id = s.agent_id
       WHERE s.id = ? AND s.agent_id = ? AND s.deleted_at IS NULL
         AND s.origin = 'web' AND s.parent_session_id IS NULL
         AND a.status = 'active' AND u.role = 'admin'`, [params.session_id, params.agent_id],
    ) as any;
    if (!rows?.[0]?.user_id) throw new Error("Sandbox requires an administrator-owned web session");
    const user_id = rows[0].user_id;
    if (params.source === "") return { user_id };
    if (params.source === "mcp") {
      const [servers] = await db.query(
        `SELECT m.id FROM mcp_servers m JOIN agent_mcp_servers b ON b.mcp_server_id = m.id
         WHERE b.agent_id = ? AND m.name = ? AND m.enabled = 1`, [params.agent_id, params.name],
      ) as any;
      if (servers.length !== 1) throw new Error("MCP binding required");
      const value = await handlers.get("config.getMcpServers")!({ ids: [servers[0].id] }, connectionId);
      return { user_id, mcp: value.mcpServers[params.name as string] };
    }
    const value = await handlers.get("credential.get")!({ source: params.source, source_id: params.name, agentId: params.agent_id }, connectionId);
    return { user_id, credential: value.credential };
  };
}
