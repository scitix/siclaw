#!/usr/bin/env node
// Keep the independently released MCP / Portal / SiCore wire contract identical.
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(
  resolve(repo, "mcp/create-chart/src/waterfall-spec.ts"),
  "utf8",
);
const args = process.argv.slice(2);
const check = args.includes("--check");
const si = args.indexOf("--sicore");
if (si >= 0 && !args[si + 1])
  throw new Error("--sicore requires an absolute checkout path");
const targets = [
  resolve(repo, "portal-web/src/components/chat/waterfall-spec.ts"),
];
if (si >= 0)
  targets.push(
    resolve(args[si + 1], "web/components/siclaw/chat/pilot/waterfall-spec.ts"),
  );
for (const target of targets) {
  if (check) {
    if ((await readFile(target, "utf8")) !== source)
      throw new Error(`Waterfall contract differs: ${target}`);
  } else await writeFile(target, source);
}
console.log(
  `${check ? "Checked" : "Synced"} ${targets.length} waterfall contracts.`,
);

if (si >= 0) {
  const uiSource = await readFile(
    resolve(repo, "portal-web/src/components/chat/TraceTimeline.tsx"),
    "utf8",
  );
  const uiTarget = resolve(
    args[si + 1],
    "web/components/siclaw/chat/pilot/trace-timeline.tsx",
  );
  if (check) {
    if ((await readFile(uiTarget, "utf8")) !== uiSource)
      throw new Error("Trace interaction implementations differ");
  } else await writeFile(uiTarget, uiSource);
}

if (si >= 0) {
  for (const [from, to] of [
    ["trace-attachments.ts", "trace-attachments.ts"],
    ["trace-locale.ts", "trace-locale.ts"],
    ["trace-timeline.css", "trace-timeline.css"],
    ["TraceContext.tsx", "trace-context.tsx"],
  ]) {
    const content = await readFile(
      resolve(repo, "portal-web/src/components/chat", from),
      "utf8",
    );
    const target = resolve(
      args[si + 1],
      "web/components/siclaw/chat/pilot",
      to,
    );
    if (check) {
      if ((await readFile(target, "utf8")) !== content)
        throw new Error(`${to} differs`);
    } else await writeFile(target, content);
  }
}
