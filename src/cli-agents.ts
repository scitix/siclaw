/**
 * `siclaw agents` — list Portal-configured agents and exit.
 *
 * Reaches into the running local Portal (same mechanism as `siclaw` itself:
 * read local-secrets.json, sign a short-lived admin JWT, hit /api/v1/cli-snapshot).
 * Prints the `availableAgents` list from the response. If no local Portal is
 * running, says so and exits non-zero.
 *
 * Meant as the "shell way" to discover agents without entering TUI — useful
 * for CI, tab-completion scripts, or just quick `grep` queries.
 */

import { loadPortalSnapshotDetailed } from "./lib/portal-snapshot-client.js";

const { snapshot, error } = await loadPortalSnapshotDetailed();

if (error?.kind === "no-secrets") {
  console.error("No .siclaw/local-secrets.json in the current directory — is `siclaw local` running here?");
  process.exit(1);
}
if (error?.kind === "portal-unreachable") {
  console.error("Portal unreachable on 127.0.0.1. Start it with `siclaw local` and try again.");
  process.exit(1);
}
if (!snapshot) {
  console.error(`Portal returned an error: ${JSON.stringify(error)}`);
  process.exit(1);
}

if (snapshot.availableAgents.length === 0) {
  console.log("No agents configured. Open the Portal Web UI (Agents page) to create one,");
  console.log("or run `siclaw` without --agent to use the global unscoped view.");
  process.exit(0);
}

// Compact table for easy shell parsing.
const rows = snapshot.availableAgents.map((a) => ({
  name: a.name,
  model: a.modelProvider && a.modelId ? `${a.modelProvider}/${a.modelId}` : "(use default)",
  description: a.description ?? "",
}));

const nameW = Math.max(4, ...rows.map((r) => r.name.length));
const modelW = Math.max(5, ...rows.map((r) => r.model.length));

console.log(`${"NAME".padEnd(nameW)}  ${"MODEL".padEnd(modelW)}  DESCRIPTION`);
for (const r of rows) {
  console.log(`${r.name.padEnd(nameW)}  ${r.model.padEnd(modelW)}  ${r.description}`);
}
console.log(`\nUse: siclaw --agent <name>`);
