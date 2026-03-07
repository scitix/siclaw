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
  --prompt <text>      Run in non-interactive print mode
  --continue           Continue the most recent session
  --credentials        Manage cluster credentials (add/remove kubeconfig)
  --add-kube [path]    Quick-add a kubeconfig (default: ~/.kube/config)
  --debug              Enable debug logging
  --setup              Force provider setup wizard
  --help, -h           Show this help
  --version, -v        Show version
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
} else if (args.includes("--credentials") || args.includes("--add-kube")) {
  // Credential management — lightweight path, no agent/config loading
  const { runCredentialsManager } = await import("./dist/cli-credentials.js");
  const { registerKubeconfig } = await import("./dist/tools/credential-manager.js");
  const path = await import("node:path");
  const os = await import("node:os");
  const credDir = path.default.resolve(process.cwd(), ".siclaw/credentials");

  const addKubeIndex = args.indexOf("--add-kube");
  if (addKubeIndex >= 0) {
    const nextArg = args[addKubeIndex + 1];
    const kubePath = (nextArg && !nextArg.startsWith("--")) ? nextArg : path.default.join(os.homedir(), ".kube", "config");
    try {
      const result = await registerKubeconfig({ sourcePath: path.default.resolve(kubePath), credentialsDir: credDir });
      console.log(`  ✓ Added "${result.name}" ${result.reachable ? `(${result.serverVersion})` : `(unreachable: ${result.probeError})`}`);
    } catch (err) {
      console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    await runCredentialsManager(credDir);
  }
  process.exit(0);
} else {
  await import("./dist/cli-main.js");
}
