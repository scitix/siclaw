/**
 * Siclaw Agent Runtime — Entry point.
 *
 * Reads env, delegates all assembly to `bootstrapRuntime`, and handles shutdown.
 */

import { loadRuntimeConfig } from "./gateway/config.js";
import { bootstrapRuntime, type SpawnerKind } from "./lib/bootstrap-runtime.js";

const args = process.argv.slice(2);
const spawnerKind: SpawnerKind = args.includes("--k8s")
  ? "k8s"
  : args.includes("--process")
    ? "process"
    : "local";

const config = loadRuntimeConfig();
const handle = await bootstrapRuntime({ config, spawnerKind });

async function shutdown() {
  console.log("\n[runtime] Shutting down...");
  await handle.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
