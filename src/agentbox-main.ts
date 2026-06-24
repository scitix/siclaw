/**
 * AgentBox Worker entry point
 *
 * A standalone Agent service exposed via HTTP API.
 * Reuses createSiclawSession() core logic, with the interaction layer changed from terminal to HTTP.
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { createHttpServer } from "./agentbox/http-server.js";
import { AgentBoxSessionManager } from "./agentbox/session.js";
import { loadConfig, reloadConfig, getConfigPath } from "./core/config.js";
import { GatewayClient } from "./agentbox/gateway-client.js";
import { syncAllResources, syncResource } from "./agentbox/resource-sync.js";
import { createToolsHandler } from "./agentbox/sync-handlers.js";
import { debugPodCache } from "./tools/infra/debug-pod.js";

// Side-effect: register metrics subscriber. Also imported in http-server.ts,
// but ESM guarantees single module evaluation — the subscriber registers only once.
import "./shared/metrics.js";
import { getMetricsAsJSON, processIncarnation } from "./shared/metrics.js";

const config = loadConfig();
const PORT = config.server.port;

async function main() {
  // If gatewayUrl is configured, fetch the latest settings.json from Gateway (with mTLS)
  if (config.server.gatewayUrl) {
    const gatewayClient = new GatewayClient({
      gatewayUrl: config.server.gatewayUrl,
    });

    // Step 1: Fetch and persist settings.json
    try {
      const remoteConfig = await gatewayClient.fetchSettings();
      const configPath = getConfigPath();
      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(remoteConfig, null, 2) + "\n");
      reloadConfig();
      console.log(`[agentbox] Fetched settings from Gateway via mTLS: ${config.server.gatewayUrl}`);
    } catch (err) {
      console.warn(`[agentbox] Failed to fetch settings from Gateway, using local config:`, err);
    }

    // Step 2: Sync resources (MCP, skills) — independent of settings fetch
    try {
      const { failed } = await syncAllResources(gatewayClient.toClientLike());
      if (failed.length > 0) {
        console.error(`[agentbox] Resource sync partial failure: [${failed.join(", ")}]`);
      }
    } catch (err) {
      console.error(`[agentbox] Resource sync failed:`, err);
    }
  }

  // Orphaned debug pods self-clean via their Job's ttlSecondsAfterFinished — no GC needed.

  const skillsDir = path.resolve(process.cwd(), config.paths.skillsDir);
  const userDataDir = path.resolve(process.cwd(), config.paths.userDataDir);
  console.log(`[agentbox] cwd: ${process.cwd()}`);
  console.log(`[agentbox] userDataDir=${userDataDir}`);
  console.log(`[agentbox] skillsDir=${skillsDir}`);
  for (const tier of ["core", "extension"]) {
    const dir = path.join(skillsDir, tier);
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir).filter(e => !e.startsWith("."));
      console.log(`[agentbox] skills/${tier}: ${entries.length} entries${entries.length ? ` (${entries.join(", ")})` : ""}`);
    } else {
      console.warn(`[agentbox] WARNING: skills/${tier} NOT found at ${dir}`);
    }
  }

  // Create session manager. userId / agentId come from spawner env vars
  // (K8s: SICLAW_AGENT_ID + USER_ID; process-spawner: USER_ID + SICLAW_AGENT_ID).
  const sessionManager = new AgentBoxSessionManager();
  if (process.env.USER_ID) sessionManager.userId = process.env.USER_ID;
  if (process.env.SICLAW_AGENT_ID) sessionManager.agentId = process.env.SICLAW_AGENT_ID;

  // Graceful shutdown — defined before the server so the idle self-destruct
  // timer can route through it (see onIdleShutdown below). Idempotent: the idle
  // timer firing and a SIGTERM racing must not run the teardown twice.
  //
  // ⚠️ This closure forward-references `server` and `federationFlushEnabled`,
  // declared below. That is only safe because `onIdleShutdown` is invoked
  // ASYNCHRONOUSLY (from the setTimeout in createHttpServer's checkIdle), never
  // synchronously during createHttpServer — by the time it fires, both consts
  // are initialized. A future refactor that calls onIdleShutdown synchronously
  // would turn these into TDZ ReferenceErrors; don't.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[agentbox] Shutting down...");
    // Final metrics flush FIRST: capture the last <pull-interval of increments before
    // the pod is recycled, and before the (possibly slow) closeAll() risks hitting the
    // K8s SIGKILL grace deadline. Best-effort — never let it block shutdown. This
    // replaces the old "close :9090 last so Prometheus can scrape the final state"
    // window, which is gone now that the scrape target is removed.
    if (federationFlushEnabled) {
      try {
        const client = new GatewayClient({ gatewayUrl: config.server.gatewayUrl });
        await client.sendMetricsFlush({ incarnation: processIncarnation, prom: await getMetricsAsJSON() });
        console.log("[agentbox] Final metrics flush sent to Gateway");
      } catch (err) {
        console.warn("[agentbox] Final metrics flush failed (continuing shutdown):", err);
      }
    }
    await debugPodCache.evictAll();
    await sessionManager.closeAll();
    server.close();
    process.exit(0);
  };

  // Start HTTP server. The idle self-destruct (K8s mode) routes through the same
  // graceful shutdown as SIGTERM rather than a raw process.exit(0), so debug pods
  // get evicted and trailing metrics flushed instead of orphaned.
  const server = createHttpServer(sessionManager, {
    onIdleShutdown: () => { void shutdown(); },
  });

  // Per-pod initial tool-capabilities fetch. The tools sync type is
  // initialSync:false (its handler is per-box, not in the module-level registry
  // that syncAllResources walks, and needs the sessionManager that doesn't exist
  // at the syncAllResources call site above). This is the K8s analog of
  // LocalSpawner's spawn-time injection: resolve the agent's whitelist into
  // sessionManager.allowedToolsState so a restricted agent is restricted from
  // its FIRST turn — not only after the next admin-triggered reload push.
  //
  // Awaited BEFORE server.listen (like syncAllResources above) so the box never
  // accepts a prompt before its whitelist lands — first-turn restriction is the
  // whole point of a security-relevant tool gate. On failure (after retries) the
  // agent starts unrestricted (allowedToolsState stays null) until the next
  // reload push — the safe-open default.
  if (sessionManager.gatewayClient) {
    const boxClient = sessionManager.gatewayClient.toClientLike();
    try {
      // Reuse syncResource's exponential-backoff retry (descriptor.retry =
      // 3 attempts, 1s base) to shrink the fail-open window from a transient
      // gateway blip. Pass the per-box handler since `tools` is not in the
      // module-level registry that syncResource would otherwise look up.
      const count = await syncResource("tools", boxClient, createToolsHandler(sessionManager, boxClient));
      console.log(`[agentbox] Initial tool-capabilities synced: ${count === 0 ? "unrestricted" : `${count} tools`}`);
    } catch (err) {
      // Fail-open after all retries: a fresh box has no prior whitelist to fall
      // back to, and a failed fetch usually means broader gateway unreachability
      // (MCP/skills can't sync either). Loud warn so the gap is observable.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[agentbox] Initial tool-capabilities sync failed after retries (starting unrestricted): ${msg}`);
    }
  }

  const protocol = server instanceof https.Server ? "https" : "http";
  server.listen(PORT, () => {
    console.log(`[agentbox] ${protocol.toUpperCase()} server listening on port ${PORT}`);
    console.log(`[agentbox] Health check: ${protocol}://localhost:${PORT}/health`);
  });

  // In K8s mode (HTTPS / mTLS), apply the metrics config fetched from the Gateway.
  // The agentbox no longer exposes its own plaintext :9090 /metrics scrape target —
  // its prom-client registry is collected by the Gateway via federation (30s pull +
  // SIGTERM final flush) and re-exported from the stable gateway:3001/metrics. See
  // metrics-federation-DESIGN.md.
  if (server instanceof https.Server) {
    const latestConfig = loadConfig();
    const { setIncludeUserId } = await import("./shared/metrics.js");
    if (latestConfig.metrics?.includeUserId !== undefined) {
      // Controls the user_id label on token/cost metrics; still honoured because
      // those metrics now flow through federation rather than a local scrape.
      setIncludeUserId(latestConfig.metrics.includeUserId);
    }
  }

  // K8s-only: whether to push a final metrics flush to the Gateway on shutdown.
  // Gated identically to the 9090 metrics server (mTLS/https) plus a configured
  // gatewayUrl to push to.
  const federationFlushEnabled = server instanceof https.Server && !!config.server.gatewayUrl;

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[agentbox] Fatal error:", err);
  process.exit(1);
});
