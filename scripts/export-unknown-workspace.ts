import fs from "node:fs";
import { exportUnknownArchive, type UnknownArchiveMapping } from "../src/agentbox/unknown-workspace-archive.js";

const args = process.argv.slice(2);
if (!args[0] || (args.length !== 1 && (args.length !== 3 || args[1] !== "--output"))) throw new Error("Usage: npx tsx scripts/export-unknown-workspace.ts mapping.json [--output NEW_DIRECTORY]");
const mapping = JSON.parse(fs.readFileSync(args[0], "utf8")) as UnknownArchiveMapping;
const report = exportUnknownArchive(mapping, args[2]);
console.log(JSON.stringify({ dryRun: !args[2], archiveOnly: true, files: report.files.length, bytes: report.files.reduce((n, f) => n + f.size, 0) }));
