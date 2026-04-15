/**
 * System configuration REST endpoints (admin-only).
 *
 * GET  /api/v1/system/config       — return all whitelisted config entries
 * PUT  /api/v1/system/config       — upsert entries (body: { values: Record<string,string> })
 */

import type { RestRouter } from "./rest-router.js";
import type { RuntimeConfig } from "./config.js";
import { sendJson, parseBody, requireAdmin } from "./rest-router.js";
import { SystemConfigRepo, ALLOWED_CONFIG_KEYS } from "./system-config-repo.js";

/** Reject dangerous URL schemes (javascript:, data:, etc). Only http/https allowed. */
function validateHttpUrl(value: string): { ok: true } | { ok: false; error: string } {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: `Invalid URL scheme: ${url.protocol} (only http/https allowed)` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
}

export function registerSystemRoutes(router: RestRouter, config: RuntimeConfig): void {
  const repo = new SystemConfigRepo();

  router.get("/api/v1/system/config", async (req, res) => {
    const auth = requireAdmin(req, config.jwtSecret);
    if (!auth) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    const all = await repo.getAll();
    sendJson(res, 200, { config: all });
  });

  router.put("/api/v1/system/config", async (req, res) => {
    const auth = requireAdmin(req, config.jwtSecret);
    if (!auth) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    const body = await parseBody<{ values?: Record<string, string> }>(req);
    const values = body?.values ?? {};

    const rejected: string[] = [];
    for (const key of Object.keys(values)) {
      if (!ALLOWED_CONFIG_KEYS.has(key)) {
        rejected.push(key);
      }
    }
    if (rejected.length > 0) {
      sendJson(res, 400, { error: `Unknown config keys: ${rejected.join(", ")}` });
      return;
    }

    // Schema-validate URL-typed keys
    for (const [key, value] of Object.entries(values)) {
      if (key === "system.grafanaUrl") {
        const check = validateHttpUrl(String(value));
        if (!check.ok) {
          sendJson(res, 400, { error: `${key}: ${check.error}` });
          return;
        }
      }
    }

    for (const [key, value] of Object.entries(values)) {
      await repo.set(key, String(value), auth.userId);
    }
    sendJson(res, 200, { ok: true });
  });
}
