import fs from "node:fs";
import { planLegacyWorkspaces, type LegacyMigrationCatalog, type LegacyInventoryEntry } from "../src/agentbox/workspace-migration-plan.js";

const [catalogFile, inventoryFile, output, ...extra] = process.argv.slice(2);
if (!catalogFile || !inventoryFile || !output || extra.length) throw new Error("Usage: npx tsx scripts/plan-private-workspace-migration.ts HOST_CATALOG.json INVENTORY.json NEW_PLAN.json");
const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8")) as LegacyMigrationCatalog;
const inventory = JSON.parse(fs.readFileSync(inventoryFile, "utf8")) as LegacyInventoryEntry[];
const plan = planLegacyWorkspaces(catalog, inventory);
fs.writeFileSync(output, JSON.stringify(plan, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ...plan.summary, unknownArchives: plan.unknownArchives.length, unknownSessions: plan.unknownArchives.reduce((n, a) => n + a.sessions.length, 0), excludedFiles: plan.excludedFiles.length, missingTranscripts: plan.catalogSessionsWithoutTranscript.length, invalidatedCaches: plan.invalidatedCaches.length, sourceFrozen: false }));
