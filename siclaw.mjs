#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf-8"));

const args = process.argv.slice(2);
const subcommand = args[0];

function printHelp() {
  console.log(`siclaw v${pkg.version}

Usage: siclaw [command] [options]

Commands:
  (default)    Start interactive TUI session
  local        Start local gateway with web UI

Options:
  --prompt <text>   Run in non-interactive print mode
  --continue        Continue the most recent session
  --debug           Enable debug logging
  --help, -h        Show this help
  --version, -v     Show version

In-session commands:
  /setup            Configure credentials and model provider
`);
}

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(pkg.version);
  process.exit(0);
}

if (subcommand === "local") {
  // Remove "local" from argv so gateway-main doesn't see it as an unknown arg
  process.argv.splice(2, 1);
  await import("./dist/gateway-main.js");
} else {
  await import("./dist/cli-main.js");
}
