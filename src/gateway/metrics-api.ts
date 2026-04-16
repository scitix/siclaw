/**
 * Metrics REST endpoints (admin-only).
 *
 * GET /api/v1/metrics/live?userId=                — realtime snapshot (from MetricsAggregator)
 * GET /api/v1/metrics/summary?period=&userId=     — aggregated stats (via FrontendWsClient RPC)
 * GET /api/v1/metrics/audit?...                   — tool call audit log (via FrontendWsClient RPC)
 * GET /api/v1/metrics/audit/:id                   — audit entry detail (via FrontendWsClient RPC)
 */

import type { RestRouter } from "./rest-router.js";
import type { RuntimeConfig } from "./config.js";
import type { MetricsAggregator } from "./metrics-aggregator.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import { sendJson, parseQuery, requireAdmin } from "./rest-router.js";

export function registerMetricsRoutes(
  router: RestRouter,
  config: RuntimeConfig,
  aggregator: MetricsAggregator,
  frontendClient: FrontendWsClient,
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
      const query = parseQuery(req.url ?? "");
      const data = await frontendClient.request("metrics.summary", query);
      sendJson(res, 200, data);
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
      const query = parseQuery(req.url ?? "");
      const data = await frontendClient.request("metrics.audit", query);
      sendJson(res, 200, data);
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
      const data = await frontendClient.request("metrics.auditDetail", { id: params.id });
      sendJson(res, 200, data);
    } catch (err) {
      console.error("[metrics-api] audit detail proxy error:", err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });
}
