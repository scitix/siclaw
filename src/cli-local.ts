/**
 * `siclaw local` — single-process entry point.
 *
 * Starts Portal + Runtime + LocalSpawner + SQLite in one Node process.
 * Zero external dependencies: DB auto-created at `.siclaw/data/portal.db`,
 * secrets auto-generated on first run into `.siclaw/local-secrets.json`.
 */

import path from "node:path";
import { bootstrapPortal } from "./lib/bootstrap-portal.js";
import { bootstrapRuntime } from "./lib/bootstrap-runtime.js";
import { loadOrGenerateLocalSecrets } from "./lib/local-secrets.js";

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
    jwtSecret: secrets.jwtSecret,
  },
});
console.log(`[local] Runtime: ${runtimeUrl}`);
console.log(`[local] DB:      ${DATABASE_URL}`);
console.log(`[local] Secrets: ${secretsPath}`);
console.log(`[local] Open ${portalUrl} to get started`);

async function shutdown() {
  console.log("\n[local] Shutting down...");
  await runtimeHandle.close();
  await portalHandle.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
