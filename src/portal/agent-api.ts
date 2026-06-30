/**
 * Agent CRUD API for the Portal.
 *
 * All agents are globally visible (no org_id filtering).
 * Auth required for every route.
 */

import crypto from "node:crypto";
import { getDb } from "../gateway/db.js";
import { insertIgnorePrefix, isUniqueViolation } from "../gateway/dialect-helpers.js";
import {
  sendJson,
  parseBody,
  parseQuery,
  requireAuth,
  type RestRouter,
} from "../gateway/rest-router.js";
import { requireAdmin } from "./auth.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";
import { encodeModelRoutingForDb } from "./model-routing-config.js";
import { encodeToolCapabilitiesForDb } from "../core/tool-capabilities.js";
import { normalizeIdleTimeoutSec } from "../core/config.js";
import { safeParseJson } from "../gateway/dialect-helpers.js";

/**
 * Decode an `agents` row's JSON-in-TEXT columns so the REST response carries
 * real objects/arrays, not raw JSON strings. These columns (`model_routing`,
 * `tool_capabilities`) are stored as TEXT-of-JSON (no JSON column type); a raw
 * `SELECT *` returns the undecoded string, which every Web client then has to
 * remember to JSON.parse — a forgotten parse silently mis-renders (see the
 * tool_capabilities echo bug). Decoding here is the single boundary that keeps
 * the wire honest. `safeParseJson` tolerates null / TEXT-string / pre-parsed
 * object, so this is safe across MySQL + SQLite and non-breaking for the
 * already-tolerant frontend coercers.
 */
function decodeAgentRow<T extends Record<string, unknown>>(row: T): T {
  if (!row) return row;
  return {
    ...row,
    model_routing: safeParseJson(row.model_routing, null),
    tool_capabilities: safeParseJson(row.tool_capabilities, null),
  };
}


export function registerAgentRoutes(
  router: RestRouter,
  jwtSecret: string,
  connectionMap: RuntimeConnectionMap,
): void {
  // GET /api/v1/agents — list (paginated, search)
  router.get("/api/v1/agents", async (req, res) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const query = parseQuery(req.url ?? "");
    const page = Math.max(1, parseInt(query.page ?? "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size ?? "20", 10)));
    const search = query.search ?? "";
    const offset = (page - 1) * pageSize;

    const db = getDb();

    let whereClause = "";
    const params: unknown[] = [];

    if (search) {
      whereClause = "WHERE a.name LIKE ? OR a.description LIKE ?";
      params.push(`%${search}%`, `%${search}%`);
    }

    const countSql = `SELECT COUNT(*) AS total FROM agents a ${whereClause}`;
    const [countRows] = await db.query(countSql, params) as any;
    const total: number = Number(countRows[0].total);

    const listParams = [...params, pageSize, offset];
    const listSql = `SELECT a.id, a.name, a.description, a.status, a.model_provider, a.model_id, a.model_routing,
        a.is_production, a.idle_timeout_sec, a.icon, a.color, a.created_by, a.created_at, a.updated_at,
        (SELECT COUNT(*) FROM agent_skills ask WHERE ask.agent_id = a.id) AS skills_count,
        (SELECT COUNT(*) FROM agent_mcp_servers ams WHERE ams.agent_id = a.id) AS mcp_count,
        (SELECT COUNT(*) FROM agent_clusters ac WHERE ac.agent_id = a.id) AS clusters_count,
        (SELECT COUNT(*) FROM agent_hosts ah WHERE ah.agent_id = a.id) AS hosts_count,
        (SELECT COUNT(*) FROM agent_tasks at2 WHERE at2.agent_id = a.id) AS tasks_count,
        (SELECT COUNT(*) FROM agent_tasks at3 WHERE at3.agent_id = a.id AND at3.status = 'active') AS tasks_active_count,
        (SELECT COUNT(*) FROM agent_channel_auth ach WHERE ach.agent_id = a.id) AS channels_count,
        (SELECT COUNT(*) FROM agent_knowledge_repos akr WHERE akr.agent_id = a.id) AS knowledge_count
      FROM agents a ${whereClause}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?`;

    const [listRows] = await db.query(listSql, listParams) as any;
    sendJson(res, 200, { data: listRows, total, page, page_size: pageSize });
  });

  // POST /api/v1/agents — create (admin only)
  router.post("/api/v1/agents", async (req, res) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const body = await parseBody<Record<string, unknown>>(req);
    if (!body.name) { sendJson(res, 400, { error: "name is required" }); return; }

    const id = crypto.randomUUID();
    const db = getDb();
    let modelRouting: string | null | undefined;
    let toolCapabilities: string | null | undefined;
    try {
      modelRouting = encodeModelRoutingForDb(body.model_routing);
      toolCapabilities = encodeToolCapabilitiesForDb(body.tool_capabilities);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }

    await db.query(
      `INSERT INTO agents (id, name, description, status, model_provider, model_id, model_routing, tool_capabilities, system_prompt, is_production, idle_timeout_sec, icon, color, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.name,
        body.description ?? null,
        body.status ?? "active",
        body.model_provider ?? null,
        body.model_id ?? null,
        modelRouting ?? null,
        toolCapabilities ?? null,
        body.system_prompt ?? null,
        body.is_production ?? 1,
        normalizeIdleTimeoutSec(body.idle_timeout_sec),
        body.icon ?? null,
        body.color ?? null,
        auth.userId,
      ],
    );

    // Auto-bind builtin skills to new agent
    try {
      const [builtinSkills] = await db.query(
        "SELECT id FROM skills WHERE is_builtin = 1 AND status = 'installed' AND org_id = ?",
        [auth.orgId],
      ) as any;
      for (const skill of builtinSkills) {
        await db.query(
          `${insertIgnorePrefix(db)} INTO agent_skills (agent_id, skill_id) VALUES (?, ?)`,
          [id, skill.id],
        );
      }
    } catch (err) {
      console.warn("[agent-api] Failed to auto-bind builtin skills:", err);
      // Non-fatal — agent is still created successfully
    }

    const [rows] = await db.query("SELECT * FROM agents WHERE id = ?", [id]) as any;
    sendJson(res, 201, decodeAgentRow(rows[0]));
  });

  // GET /api/v1/agents/:id — get by id
  router.get("/api/v1/agents/:id", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    const [rows] = await db.query("SELECT * FROM agents WHERE id = ?", [params.id]) as any;

    if (rows.length === 0) {
      sendJson(res, 404, { error: "Agent not found" });
      return;
    }

    sendJson(res, 200, decodeAgentRow(rows[0]));
  });

  // PUT /api/v1/agents/:id — update (admin only)
  router.put("/api/v1/agents/:id", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    // Capture the current idle window before the update — needed to detect the
    // resident(0) → finite transition, which (unlike every other transition)
    // does NOT self-heal: a resident pod never self-destructs, so it never
    // cold-spawns to pick up the new SICLAW_AGENTBOX_IDLE_TIMEOUT. We terminate
    // the running box below to force that cold spawn.
    let oldIdleTimeoutSec: number | null = null;
    let newIdleTimeoutSec: number | null = null;
    if ("idle_timeout_sec" in body) {
      const [cur] = await db.query(
        "SELECT idle_timeout_sec FROM agents WHERE id = ?",
        [params.id],
      ) as any;
      // Coerce to a number: the column is INT (drivers return a number), but a
      // stringified "0" would silently dodge the `=== 0` resident check below.
      // Keep null as null so a missing row can't read as 0 (Number(null) === 0).
      const raw = cur[0]?.idle_timeout_sec;
      oldIdleTimeoutSec = raw == null ? null : Number(raw);
      // Normalize once here and reuse for both the SET clause and the
      // resident→finite terminate decision below.
      newIdleTimeoutSec = normalizeIdleTimeoutSec(body.idle_timeout_sec);
    }

    // Build dynamic SET clause
    const fields = [
      "name", "description", "status", "model_provider",
      "model_id", "system_prompt", "is_production", "idle_timeout_sec", "icon", "color",
    ];
    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const field of fields) {
      if (field in body) {
        setClauses.push(`${field} = ?`);
        // newIdleTimeoutSec is non-null here: field === "idle_timeout_sec" implies
        // "idle_timeout_sec" in body, which is exactly when it was computed above.
        values.push(field === "idle_timeout_sec" ? newIdleTimeoutSec! : body[field]);
      }
    }
    if ("model_routing" in body) {
      try {
        const modelRouting = encodeModelRoutingForDb(body.model_routing);
        if (modelRouting !== undefined) {
          setClauses.push("model_routing = ?");
          values.push(modelRouting);
        }
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }

    let toolCapabilitiesChanged = false;
    if ("tool_capabilities" in body) {
      try {
        const toolCapabilities = encodeToolCapabilitiesForDb(body.tool_capabilities);
        if (toolCapabilities !== undefined) {
          setClauses.push("tool_capabilities = ?");
          values.push(toolCapabilities);
          toolCapabilitiesChanged = true;
        }
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }

    if (setClauses.length === 0) {
      sendJson(res, 400, { error: "No fields to update" });
      return;
    }

    setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(params.id);

    const sql = `UPDATE agents SET ${setClauses.join(", ")} WHERE id = ?`;
    await db.query(sql, values);

    const [rows] = await db.query("SELECT * FROM agents WHERE id = ?", [params.id]) as any;
    if (rows.length === 0) {
      sendJson(res, 404, { error: "Agent not found" });
      return;
    }

    sendJson(res, 200, decodeAgentRow(rows[0]));

    // is_production change affects skills bundle (prod=approved only, dev=all)
    // and also the visible cluster/host set — credential-list filters out
    // cross-env bindings, so the AgentBox must drop its cached list.
    if ("is_production" in body) {
      connectionMap.notify(params.id, "agent.reload", { resources: ["skills", "cluster", "host"] });
    }

    // tool_capabilities change → push a tools reload so the active AgentBox
    // re-fetches its whitelist and invalidates live sessions (mid-turn-safe).
    if (toolCapabilitiesChanged) {
      connectionMap.notify(params.id, "agent.reload", { agentId: params.id, resources: ["tools"] });
    }

    // Idle window changed from resident (0) → finite: the running box is
    // resident and will never self-destruct, so it would never cold-spawn to
    // pick up the new window — the change would silently never take effect.
    // Terminate the running box so the next message cold-spawns with the new
    // SICLAW_AGENTBOX_IDLE_TIMEOUT. Other transitions (finite→finite, →0) need
    // no action: the box self-destructs on its current window and the next
    // spawn reads the new value, so we don't disrupt a live box for them.
    if ("idle_timeout_sec" in body && oldIdleTimeoutSec === 0 && (newIdleTimeoutSec ?? 0) > 0) {
      connectionMap.notify(params.id, "agent.terminate", { agentId: params.id });
    }
  });

  // DELETE /api/v1/agents/:id (admin only)
  router.delete("/api/v1/agents/:id", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();

    // Check existence first
    const [existing] = await db.query("SELECT id FROM agents WHERE id = ?", [params.id]) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Agent not found" });
      return;
    }

    // Terminate any running AgentBox pods bound to this agent before DB delete
    // so they don't become orphans. Log and proceed on failure — the DB delete
    // is the user's explicit intent; orphan pods can be cleaned up via kubectl.
    const termResult = await connectionMap.sendCommand(
      params.id,
      "agent.terminate",
      { agentId: params.id },
    );
    if (!termResult.ok) {
      console.warn(`[agent-api] delete ${params.id}: runtime terminate failed: ${termResult.error}`);
    }

    await db.query("DELETE FROM agents WHERE id = ?", [params.id]);
    sendJson(res, 200, { deleted: true, terminate: termResult });
  });

  // PUT /api/v1/agents/:id/resources — bind resources (admin only)
  router.put("/api/v1/agents/:id/resources", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const body = await parseBody<{
      cluster_ids?: string[];
      host_ids?: string[];
      skill_ids?: string[];
      mcp_server_ids?: string[];
      channel_ids?: string[];
      knowledge_repo_ids?: string[];
    }>(req);

    const db = getDb();
    const agentId = params.id;

    // Verify agent exists
    const [agentRows] = await db.query("SELECT id FROM agents WHERE id = ?", [agentId]) as any;
    if (agentRows.length === 0) {
      sendJson(res, 404, { error: "Agent not found" });
      return;
    }

    // Replace junction rows in a transaction
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      if (body.cluster_ids !== undefined) {
        await conn.query("DELETE FROM agent_clusters WHERE agent_id = ?", [agentId]);
        for (const cid of body.cluster_ids) {
          await conn.query("INSERT INTO agent_clusters (agent_id, cluster_id) VALUES (?, ?)", [agentId, cid]);
        }
      }
      if (body.host_ids !== undefined) {
        await conn.query("DELETE FROM agent_hosts WHERE agent_id = ?", [agentId]);
        for (const hid of body.host_ids) {
          await conn.query("INSERT INTO agent_hosts (agent_id, host_id) VALUES (?, ?)", [agentId, hid]);
        }
      }
      if (body.skill_ids !== undefined) {
        await conn.query("DELETE FROM agent_skills WHERE agent_id = ?", [agentId]);
        for (const sid of body.skill_ids) {
          await conn.query("INSERT INTO agent_skills (agent_id, skill_id) VALUES (?, ?)", [agentId, sid]);
        }
      }
      if (body.mcp_server_ids !== undefined) {
        await conn.query("DELETE FROM agent_mcp_servers WHERE agent_id = ?", [agentId]);
        for (const mid of body.mcp_server_ids) {
          await conn.query("INSERT INTO agent_mcp_servers (agent_id, mcp_server_id) VALUES (?, ?)", [agentId, mid]);
        }
      }
      if (body.channel_ids !== undefined) {
        await conn.query("DELETE FROM agent_channel_auth WHERE agent_id = ?", [agentId]);
        for (const cid of body.channel_ids) {
          await conn.query("INSERT INTO agent_channel_auth (agent_id, channel_id) VALUES (?, ?)", [agentId, cid]);
        }
      }
      if (body.knowledge_repo_ids !== undefined) {
        await conn.query("DELETE FROM agent_knowledge_repos WHERE agent_id = ?", [agentId]);
        for (const kid of body.knowledge_repo_ids) {
          await conn.query("INSERT INTO agent_knowledge_repos (agent_id, repo_id) VALUES (?, ?)", [agentId, kid]);
        }
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    sendJson(res, 200, { ok: true });

    // Notify running AgentBox to reload (fire-and-forget)
    connectionMap.notify(params.id, "agent.reload", { agentId: params.id });
  });

  // GET /api/v1/agents/:id/resources — get bindings
  router.get("/api/v1/agents/:id/resources", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    const agentId = params.id;

    const [[clusters], [hosts], [skills], [mcpServers], [channels], [knowledgeRepos]] = await Promise.all([
      db.query(
        `SELECT c.id, c.name, c.api_server FROM agent_clusters ac
         JOIN clusters c ON ac.cluster_id = c.id WHERE ac.agent_id = ?`,
        [agentId],
      ),
      db.query(
        `SELECT h.id, h.name, h.ip, h.port FROM agent_hosts ah
         JOIN hosts h ON ah.host_id = h.id WHERE ah.agent_id = ?`,
        [agentId],
      ),
      db.query(
        `SELECT s.id, s.name, s.description FROM agent_skills ask
         JOIN skills s ON ask.skill_id = s.id WHERE ask.agent_id = ?`,
        [agentId],
      ),
      db.query(
        `SELECT m.id, m.name, m.transport FROM agent_mcp_servers ams
         JOIN mcp_servers m ON ams.mcp_server_id = m.id WHERE ams.agent_id = ?`,
        [agentId],
      ),
      db.query(
        `SELECT ch.id, ch.name, ch.type FROM agent_channel_auth ach
         JOIN channels ch ON ach.channel_id = ch.id WHERE ach.agent_id = ?`,
        [agentId],
      ),
      db.query(
        `SELECT kr.id, kr.name, kr.description FROM agent_knowledge_repos akr
         JOIN knowledge_repos kr ON akr.repo_id = kr.id WHERE akr.agent_id = ?`,
        [agentId],
      ),
    ]) as any;

    sendJson(res, 200, {
      clusters,
      hosts,
      skills,
      mcp_servers: mcpServers,
      channels,
      knowledge_repos: knowledgeRepos,
    });
  });

  // POST /api/v1/agents/:id/fork — fork agent + resource bindings (admin only)
  router.post("/api/v1/agents/:id/fork", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();
    const sourceId = params.id;

    const [sourceRows] = await db.query("SELECT * FROM agents WHERE id = ?", [sourceId]) as any;
    if (sourceRows.length === 0) {
      sendJson(res, 404, { error: "Agent not found" });
      return;
    }
    const source = sourceRows[0];

    const newId = crypto.randomUUID();
    // Hash the source name + a random salt so the suffix is stable-looking but collision-free
    const salt = crypto.randomBytes(8).toString("hex");
    const suffix = crypto.createHash("sha256").update(source.name + salt).digest("hex").slice(0, 6);
    const newName = `${source.name}-${suffix}`;

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `INSERT INTO agents (id, name, description, status, model_provider, model_id, model_routing, system_prompt, is_production, icon, color, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId,
          newName,
          source.description,
          source.status,
          source.model_provider,
          source.model_id,
          source.model_routing,
          source.system_prompt,
          source.is_production,
          source.icon,
          source.color,
          auth.userId,
        ],
      );

      // Copy skill bindings
      const [skillRows] = await conn.query(
        "SELECT skill_id FROM agent_skills WHERE agent_id = ?",
        [sourceId],
      ) as any;
      for (const row of skillRows) {
        await conn.query(
          `${insertIgnorePrefix(db)} INTO agent_skills (agent_id, skill_id) VALUES (?, ?)`,
          [newId, row.skill_id],
        );
      }

      // Copy MCP server bindings
      const [mcpRows] = await conn.query(
        "SELECT mcp_server_id FROM agent_mcp_servers WHERE agent_id = ?",
        [sourceId],
      ) as any;
      for (const row of mcpRows) {
        await conn.query(
          "INSERT INTO agent_mcp_servers (agent_id, mcp_server_id) VALUES (?, ?)",
          [newId, row.mcp_server_id],
        );
      }

      // Copy cluster bindings
      const [clusterRows] = await conn.query(
        "SELECT cluster_id FROM agent_clusters WHERE agent_id = ?",
        [sourceId],
      ) as any;
      for (const row of clusterRows) {
        await conn.query(
          "INSERT INTO agent_clusters (agent_id, cluster_id) VALUES (?, ?)",
          [newId, row.cluster_id],
        );
      }

      // Copy host bindings
      const [hostRows] = await conn.query(
        "SELECT host_id FROM agent_hosts WHERE agent_id = ?",
        [sourceId],
      ) as any;
      for (const row of hostRows) {
        await conn.query(
          "INSERT INTO agent_hosts (agent_id, host_id) VALUES (?, ?)",
          [newId, row.host_id],
        );
      }

      // Copy knowledge repo bindings
      const [knowledgeRows] = await conn.query(
        "SELECT repo_id FROM agent_knowledge_repos WHERE agent_id = ?",
        [sourceId],
      ) as any;
      for (const row of knowledgeRows) {
        await conn.query(
          "INSERT INTO agent_knowledge_repos (agent_id, repo_id) VALUES (?, ?)",
          [newId, row.repo_id],
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      if (isUniqueViolation(err)) {
        sendJson(res, 409, { error: `Agent name "${newName}" is already taken. Please try again — a new suffix will be generated.` });
        return;
      }
      throw err;
    } finally {
      conn.release();
    }

    const [newRows] = await db.query("SELECT * FROM agents WHERE id = ?", [newId]) as any;
    sendJson(res, 201, decodeAgentRow(newRows[0]));
  });

  // ================================================================
  // API Keys (Portal-owned)
  // ================================================================

  // List API keys. Admins see every key for the agent; a regular user sees only
  // the keys they created (so each user manages their own without seeing others').
  router.get("/api/v1/siclaw/agents/:id/api-keys", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    const ownerOnly = auth.role !== "admin";
    const [rows] = await db.query(
      `SELECT id, agent_id, name, key_plain, key_prefix, last_used_at, expires_at, created_by, created_at
       FROM agent_api_keys WHERE agent_id = ?${ownerOnly ? " AND created_by = ?" : ""}
       ORDER BY created_at DESC, id DESC`,
      ownerOnly ? [params.id, auth.userId] : [params.id],
    ) as any;
    sendJson(res, 200, { data: rows });
  });

  // Create API key. Any authenticated user may create a key for themselves
  // (stamped created_by = caller); admins included. Ownership is what scopes
  // list/delete below.
  router.post("/api/v1/siclaw/agents/:id/api-keys", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<Record<string, unknown>>(req);
    const id = crypto.randomUUID();
    const rawKey = crypto.randomBytes(32).toString("hex");
    const plaintext = `sk-${rawKey}`;
    const keyPrefix = plaintext.slice(0, 7);
    const keyHash = crypto.createHash("sha256").update(plaintext).digest("hex");

    const db = getDb();
    await db.query(
      `INSERT INTO agent_api_keys (id, agent_id, name, key_hash, key_plain, key_prefix, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, params.id, body.name || "API Key", keyHash, plaintext, keyPrefix, body.expires_at || null, auth.userId],
    );

    const [rows] = await db.query(
      "SELECT id, agent_id, name, key_prefix, expires_at, created_by, created_at FROM agent_api_keys WHERE id = ?",
      [id],
    ) as any;
    sendJson(res, 201, { ...rows[0], key: plaintext });
  });

  // Delete API key. Admins may delete any key for the agent; a regular user may
  // delete only keys they created.
  router.delete("/api/v1/siclaw/agents/:id/api-keys/:kid", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    const [existing] = await db.query(
      "SELECT id, created_by FROM agent_api_keys WHERE id = ? AND agent_id = ?",
      [params.kid, params.id],
    ) as any;
    if (existing.length === 0) { sendJson(res, 404, { error: "API key not found" }); return; }
    if (auth.role !== "admin" && existing[0].created_by !== auth.userId) {
      sendJson(res, 403, { error: "You can only delete your own API keys" });
      return;
    }

    await db.query("DELETE FROM api_key_service_accounts WHERE api_key_id = ?", [params.kid]);
    await db.query("DELETE FROM agent_api_keys WHERE id = ?", [params.kid]);
    sendJson(res, 200, { ok: true });
  });
}
