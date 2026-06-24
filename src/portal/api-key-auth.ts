import crypto from "node:crypto";
import type http from "node:http";
import { getDb } from "../gateway/db.js";

export interface ApiKeyAuthResult {
  agentId: string;
  keyId: string;
  keyName: string;
  createdBy: string;
}

export async function authenticateApiKey(req: http.IncomingMessage): Promise<ApiKeyAuthResult | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer sk-")) return null;

  const plaintext = auth.slice(7);
  const keyHash = crypto.createHash("sha256").update(plaintext).digest("hex");

  const db = getDb();
  const [rows] = await db.query(
    `SELECT id, agent_id, name, expires_at, created_by
     FROM agent_api_keys WHERE key_hash = ? LIMIT 1`,
    [keyHash],
  ) as any;

  if (rows.length === 0) return null;
  const key = rows[0];

  if (key.expires_at && new Date(key.expires_at) < new Date()) return null;

  db.query("UPDATE agent_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?", [key.id]).catch(() => {});

  return { agentId: key.agent_id, keyId: key.id, keyName: key.name, createdBy: key.created_by };
}
