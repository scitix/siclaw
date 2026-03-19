#!/usr/bin/env node

/**
 * CLI entry point — siclaw-sig extract command using Commander.js.
 *
 * Wires CLI argument parsing to the extract command handler.
 */

import { Command } from "commander";
import path from "node:path";
import { runExtract } from "./extract.js";

const program = new Command();

program
  .name("siclaw-sig")
  .description("Extract log templates from source code into .sig packages")
  .version("0.1.0");

program
  .command("extract")
  .description("Extract log templates from a source directory")
  .requiredOption("--src <path>", "Source directory to scan")
  .requiredOption("--lang <language>", "Source language (go)")
  .requiredOption("--output <dir>", "Output directory for .sig package")
  .option("--source-version <tag>", "Component version tag", "unknown")
  .option("--component <name>", "Component name (default: basename of --src)")
  .option("--log-patterns <yaml...>", "Custom rule file path(s)", [])
  .action(async (opts) => {
    const component = opts.component ?? path.basename(path.resolve(opts.src));
    await runExtract({
      src: path.resolve(opts.src),
      lang: opts.lang,
      output: path.resolve(opts.output),
      version: opts.sourceVersion,
      component,
      logPatterns: opts.logPatterns,
    });
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
