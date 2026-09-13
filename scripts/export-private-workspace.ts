import fs from "node:fs";
import { exportLegacyWorkspace, type LegacyWorkspaceMapping } from "../src/agentbox/workspace-migration.js";

const args = process.argv.slice(2);
if (!args[0] || (args.length !== 1 && (args.length !== 3 || args[1] !== "--output"))) {
  throw new Error("Usage: npx tsx scripts/export-private-workspace.ts mapping.json [--output NEW_DIRECTORY]. Without --output: read-only dry run.");
}
const mapping = JSON.parse(fs.readFileSync(args[0], "utf8")) as LegacyWorkspaceMapping;
const report = exportLegacyWorkspace(mapping, args[2]);
console.log(JSON.stringify({ dryRun: !args[2], files: report.files.length, bytes: report.files.reduce((n, f) => n + f.size, 0), activeLeafKnown: report.activeLeafKnown }));
