#!/usr/bin/env node

// Node 22 requires `--experimental-sqlite` to import `node:sqlite`.
// `siclaw local` uses node:sqlite for the Portal DB — if the flag is missing,
// re-exec ourselves with it. Node 24+ has sqlite stable, so skip the re-exec.
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
const needsSqliteFlag =
  nodeMajor < 24 &&
  process.argv[2] === "local" &&
  !process.execArgv.includes("--experimental-sqlite") &&
  !process.env.SICLAW_REEXEC_SQLITE;

if (needsSqliteFlag) {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    ["--experimental-sqlite", process.argv[1], ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, SICLAW_REEXEC_SQLITE: "1" } },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error("Failed to re-exec with --experimental-sqlite:", err);
    process.exit(1);
  });
} else {
  // Suppress Node.js ExperimentalWarning (node:sqlite) without removing other warning listeners
  const _origEmit = process.emit;
  process.emit = function (event, ...args) {
    if (event === "warning" && args[0]?.name === "ExperimentalWarning") return false;
    return _origEmit.apply(this, [event, ...args]);
  };

  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf-8"));

  const args = process.argv.slice(2);
  const subcommand = args[0];

  function printHelp() {
    console.log(`siclaw v${pkg.version}

Usage: siclaw [command] [options]

Commands:
  (default)    Start interactive TUI session
  local        Start local gateway with web UI (single process, SQLite)

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
    process.argv.splice(2, 1);
    await import("./dist/cli-local.js");
  } else {
    await import("./dist/cli-main.js");
  }
}
