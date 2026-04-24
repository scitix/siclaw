/**
 * `siclaw local` — single-process entry point.
 *
 * Starts Portal + Runtime + LocalSpawner + SQLite in one Node process.
 * Zero external dependencies: DB auto-created at `.siclaw/data/portal.db`,
 * secrets auto-generated on first run into `.siclaw/local-secrets.json`.
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { bootstrapPortal } from "./lib/bootstrap-portal.js";
import { bootstrapRuntime } from "./lib/bootstrap-runtime.js";
import { loadOrGenerateLocalSecrets } from "./lib/local-secrets.js";

const SHOULD_OPEN_BROWSER = process.argv.includes("--open");

const PORTAL_PORT = parseInt(process.env.PORTAL_PORT || "3000", 10);
const RUNTIME_PORT = parseInt(process.env.SICLAW_PORT || "3001", 10);
const INTERNAL_PORT = parseInt(process.env.SICLAW_INTERNAL_PORT || "3002", 10);

const DATABASE_URL = process.env.DATABASE_URL || "sqlite:./.siclaw/data/portal.db";

const secretsPath = path.resolve(".siclaw/local-secrets.json");
const secrets = loadOrGenerateLocalSecrets(secretsPath);

const runtimeUrl = `http://127.0.0.1:${RUNTIME_PORT}`;
const runtimeWsUrl = `ws://127.0.0.1:${RUNTIME_PORT}/ws`;
const portalUrl = `http://127.0.0.1:${PORTAL_PORT}`;

// Phase 1: Portal (DB + migrations + HTTP server listening)
const portalHandle = await bootstrapPortal({
  port: PORTAL_PORT,
  databaseUrl: DATABASE_URL,
  jwtSecret: secrets.jwtSecret,
  runtimeUrl,
  runtimeWsUrl,
  runtimeSecret: secrets.runtimeSecret,
  portalSecret: secrets.portalSecret,
  // Local single-user mode: expose the CLI snapshot endpoint so `siclaw`
  // (TUI) running on the same machine can fetch providers/MCP/default model
  // via HTTP instead of maintaining its own settings.json. Prod K8s Portal
  // must NOT set this — the endpoint is not per-tenant scoped.
  enableCliSnapshot: true,
  cliSnapshotSecret: secrets.cliSnapshotSecret,
  // Single-user mode: seed `admin / admin` on first-boot empty DB so the
  // Web UI is usable out of the box. Production K8s must leave this unset.
  enableDefaultAdminSeed: true,
});
console.log(`[local] Portal:  ${portalUrl}`);

// Phase 2: Runtime (in-process, connects back to Portal over loopback)
const runtimeHandle = await bootstrapRuntime({
  spawnerKind: "local",
  config: {
    port: RUNTIME_PORT,
    internalPort: INTERNAL_PORT,
    host: "127.0.0.1",
    runtimeSecret: secrets.runtimeSecret,
    serverUrl: portalUrl,
    portalSecret: secrets.portalSecret,
  },
});
console.log(`[local] Runtime: ${runtimeUrl}`);
console.log(`[local] DB:      ${DATABASE_URL}`);
console.log(`[local] Secrets: ${secretsPath}`);
console.log(`[local] Open ${portalUrl} to get started`);

if (SHOULD_OPEN_BROWSER) {
  const opener = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
    ? "start"
    : "xdg-open";
  try {
    spawn(opener, [portalUrl], { detached: true, stdio: "ignore" }).unref();
  } catch (err) {
    console.warn(`[local] --open: failed to launch browser (${err instanceof Error ? err.message : err})`);
  }
}

async function shutdown() {
  console.log("\n[local] Shutting down...");
  await runtimeHandle.close();
  await portalHandle.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
