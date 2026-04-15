/**
 * Metrics REST endpoints (admin-only).
 *
 * GET /api/v1/metrics/live?userId=                — realtime snapshot (from MetricsAggregator)
 * GET /api/v1/metrics/summary?period=&userId=     — aggregated stats (proxied to Portal adapter)
 * GET /api/v1/metrics/audit?...                   — tool call audit log (proxied to Portal adapter)
 * GET /api/v1/metrics/audit/:id                   — audit entry detail (proxied to Portal adapter)
 *
 * Runtime no longer accesses the database directly. Summary and audit
 * endpoints are proxied through Portal's adapter API.
 */

import type { RestRouter } from "./rest-router.js";
import type { RuntimeConfig } from "./config.js";
import type { MetricsAggregator } from "./metrics-aggregator.js";
import { sendJson, parseQuery, requireAdmin } from "./rest-router.js";

export function registerMetricsRoutes(
  router: RestRouter,
  config: RuntimeConfig,
  aggregator: MetricsAggregator,
): void {

  // ── GET /api/v1/metrics/live ─────────────────────────────
  router.get("/api/v1/siclaw/metrics/live", async (req, res) => {
    const auth = requireAdmin(req, config.jwtSecret);
    if (!auth) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    const query = parseQuery(req.url ?? "");
    const userId = query.userId || undefined;

    sendJson(res, 200, {
      snapshot: aggregator.snapshot(),
      topTools: aggregator.topTools(10, userId),
      topSkills: aggregator.topSkills(10, userId),
    });
  });

  // ── GET /api/v1/metrics/summary ──────────────────────────
  router.get("/api/v1/siclaw/metrics/summary", async (req, res) => {
    const auth = requireAdmin(req, config.jwtSecret);
    if (!auth) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    try {
      const qIdx = (req.url ?? "").indexOf("?");
      const qs = qIdx >= 0 ? (req.url ?? "").slice(qIdx) : "";
      const resp = await fetch(`${config.serverUrl}/api/internal/siclaw/metrics/summary${qs}`, {
        headers: { "X-Auth-Token": config.portalSecret },
      });
      const data = await resp.json();
      sendJson(res, resp.status, data);
    } catch (err) {
      console.error("[metrics-api] summary proxy error:", err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });

  // ── GET /api/v1/metrics/audit ────────────────────────────
  router.get("/api/v1/siclaw/metrics/audit", async (req, res) => {
    const auth = requireAdmin(req, config.jwtSecret);
    if (!auth) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    try {
      const qIdx = (req.url ?? "").indexOf("?");
      const qs = qIdx >= 0 ? (req.url ?? "").slice(qIdx) : "";
      const resp = await fetch(`${config.serverUrl}/api/internal/siclaw/metrics/audit${qs}`, {
        headers: { "X-Auth-Token": config.portalSecret },
      });
      const data = await resp.json();
      sendJson(res, resp.status, data);
    } catch (err) {
      console.error("[metrics-api] audit proxy error:", err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });

  // ── GET /api/v1/metrics/audit/:id ────────────────────────
  router.get("/api/v1/siclaw/metrics/audit/:id", async (req, res, params) => {
    const auth = requireAdmin(req, config.jwtSecret);
    if (!auth) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    try {
      const resp = await fetch(`${config.serverUrl}/api/internal/siclaw/metrics/audit/${params.id}`, {
        headers: { "X-Auth-Token": config.portalSecret },
      });
      const data = await resp.json();
      sendJson(res, resp.status, data);
    } catch (err) {
      console.error("[metrics-api] audit detail proxy error:", err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });
}
