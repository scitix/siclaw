#!/usr/bin/env node
// Keep the independently released MCP / Portal / host wire contract identical.
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(
  resolve(repo, "mcp/create-chart/src/waterfall-spec.ts"),
  "utf8",
);
const { values } = parseArgs({
  options: {
    check: { type: "boolean", default: false },
    "host-dir": { type: "string" },
  },
});
const check = values.check;
const hostDir = values["host-dir"];
if (hostDir !== undefined && !isAbsolute(hostDir))
  throw new Error("--host-dir requires an absolute component directory path");
const targets = [
  resolve(repo, "portal-web/src/components/chat/waterfall-spec.ts"),
];
if (hostDir) targets.push(resolve(hostDir, "waterfall-spec.ts"));
for (const target of targets) {
  if (check) {
    if ((await readFile(target, "utf8")) !== source)
      throw new Error(`Waterfall contract differs: ${target}`);
  } else await writeFile(target, source);
}
console.log(
  `${check ? "Checked" : "Synced"} ${targets.length} waterfall contracts.`,
);

if (hostDir) {
  const uiSource = await readFile(
    resolve(repo, "portal-web/src/components/chat/TraceTimeline.tsx"),
    "utf8",
  );
  const uiTarget = resolve(hostDir, "trace-timeline.tsx");
  if (check) {
    if ((await readFile(uiTarget, "utf8")) !== uiSource)
      throw new Error("Trace interaction implementations differ");
  } else await writeFile(uiTarget, uiSource);
}

if (hostDir) {
  for (const [from, to] of [
    ["trace-attachments.ts", "trace-attachments.ts"],
    ["trace-navigation.ts", "trace-navigation.ts"],
    ["trace-locale.ts", "trace-locale.ts"],
    ["trace-timeline.css", "trace-timeline.css"],
    ["TraceContext.tsx", "trace-context.tsx"],
  ]) {
    const content = await readFile(
      resolve(repo, "portal-web/src/components/chat", from),
      "utf8",
    );
    const target = resolve(hostDir, to);
    if (check) {
      if ((await readFile(target, "utf8")) !== content)
        throw new Error(`${to} differs`);
    } else await writeFile(target, content);
  }
}
