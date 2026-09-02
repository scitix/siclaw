#!/usr/bin/env -S npx tsx

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  applyKnowledgeLabelManifest,
  type KnowledgeLabelBackfillManifest,
} from "../src/knowledge/label-backfill.js";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    output: { type: "string" },
    manifest: { type: "string" },
    report: { type: "string" },
  },
  strict: true,
});

if (!values.source || !values.output || !values.manifest) {
  throw new Error("Usage: apply-knowledge-label-manifest --source DIR --output DIR --manifest FILE [--report FILE]");
}

const manifest = JSON.parse(fs.readFileSync(path.resolve(values.manifest), "utf8")) as KnowledgeLabelBackfillManifest;
const report = applyKnowledgeLabelManifest(values.source, values.output, manifest);
const payload = JSON.stringify(report, null, 2) + "\n";
if (values.report) {
  fs.mkdirSync(path.dirname(path.resolve(values.report)), { recursive: true });
  fs.writeFileSync(path.resolve(values.report), payload);
}
process.stdout.write(payload);
