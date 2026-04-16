/**
 * Regression Entry — boots Gateway in-process, runs one or more markdown
 * case-banks through the full inject → agent → score → cleanup pipeline,
 * writes a markdown report, and exits with 0 (all pass) or 1 (any fail/error).
 *
 * Usage:
 *   npm run dev:regress                                              # default (sample-cases.md)
 *   npm run dev:regress -- --cases itbench-sre                      # run itbench-sre.md
 *   npm run dev:regress -- --cases sample-cases,itbench-sre         # merge and run both
 *   npm run dev:regress -- --cases all                              # every *.md in cases dir
 *   npm run dev:regress -- --cases itbench-sre --output report.md  # explicit output path
 *   npm run dev:regress -- <case.md> <report.md>                    # legacy positional args
 *
 * Env (optional):
 *   REGRESS_INPUT   — comma-separated case-bank paths (default: sample-cases.md)
 *   REGRESS_OUTPUT  — report path (default: tests/regression/reports/report-<ts>.md)
 *   REGRESS_USER    — username to run as (default "admin", auto-created)
 *   REGRESS_WORK_ORDER — 0-indexed work order to send (default 0)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { loadGatewayConfig } from "./gateway/config.js";
import { startGateway } from "./gateway/server.js";
import { AgentBoxManager, LocalSpawner } from "./gateway/agentbox/index.js";
import { AgentBoxClient } from "./gateway/agentbox/client.js";
import { ChatRepository } from "./gateway/db/repositories/chat-repo.js";
import { WorkspaceRepository } from "./gateway/db/repositories/workspace-repo.js";
import { parseRegressionMarkdown } from "./gateway/deveval/regression/md-parser.js";
import { runCasesBatch } from "./gateway/deveval/regression/runner.js";
import { renderReport } from "./gateway/deveval/regression/reporter.js";

const CASES_DIR = "tests/regression/cases";

/** Resolve one or more input case-file paths from CLI flags / env vars / defaults.
 *
 *   --cases itbench-sre                 → tests/regression/cases/itbench-sre.md
 *   --cases sample-cases,itbench-sre    → both files, merged
 *   --cases all                         → every *.md in the cases directory
 *   --cases path/to/custom.md           → explicit path (contains / or .md)
 */
function resolveInputPaths(): string[] {
  const casesIdx = process.argv.indexOf("--cases");
  if (casesIdx !== -1 && process.argv[casesIdx + 1]) {
    const val = process.argv[casesIdx + 1].trim();
    if (val === "all") {
      return readdirSync(resolve(CASES_DIR))
        .filter(f => f.endsWith(".md"))
        .sort()
        .map(f => resolve(join(CASES_DIR, f)));
    }
    return val.split(",").map(name => {
      const n = name.trim();
      if (n.includes("/") || n.endsWith(".md")) return resolve(n);
      return resolve(join(CASES_DIR, `${n}.md`));
    });
  }
  // Legacy positional arg[2] (not prefixed with --)
  const posArg = process.argv[2];
  if (posArg && !posArg.startsWith("--")) return [resolve(posArg)];
  // REGRESS_INPUT env var (comma-separated for multi-file)
  if (process.env.REGRESS_INPUT) {
    return process.env.REGRESS_INPUT.split(",").map(p => resolve(p.trim()));
  }
  return [resolve(join(CASES_DIR, "sample-cases.md"))];
}

function resolveOutputPath(ts: string): string {
  const outIdx = process.argv.indexOf("--output");
  if (outIdx !== -1 && process.argv[outIdx + 1]) return resolve(process.argv[outIdx + 1]);
  // Legacy positional arg[3] (only when not using --cases flag)
  if (!process.argv.includes("--cases")) {
    const posArg3 = process.argv[3];
    if (posArg3 && !posArg3.startsWith("--")) return resolve(posArg3);
  }
  if (process.env.REGRESS_OUTPUT) return resolve(process.env.REGRESS_OUTPUT);
  return resolve(`tests/regression/reports/report-${ts}.md`);
}

const inputPaths = resolveInputPaths();
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outputPath = resolveOutputPath(ts);
const runAs = process.env.REGRESS_USER ?? "admin";
const workOrderIndex = Number(process.env.REGRESS_WORK_ORDER ?? 0);
const concurrency = Math.max(1, Number(process.env.REGRESS_CONCURRENCY ?? 4));

console.log(`[regress] Input:  ${inputPaths.join(", ")}`);
console.log(`[regress] Output: ${outputPath}`);
console.log(`[regress] Booting Gateway in-process (LocalSpawner)…`);

// Merge cases from all input files
const allCases: ReturnType<typeof parseRegressionMarkdown>["cases"] = [];
const allWarnings: ReturnType<typeof parseRegressionMarkdown>["warnings"] = [];
for (const p of inputPaths) {
  const parsed = parseRegressionMarkdown(readFileSync(p, "utf8"));
  allCases.push(...parsed.cases);
  allWarnings.push(...parsed.warnings);
}

const config = loadGatewayConfig();
const spawner = new LocalSpawner(4000);
const agentBoxManager = new AgentBoxManager(spawner, {
  namespace: process.env.SICLAW_K8S_NAMESPACE ?? "default",
});

const gateway = await startGateway({ config, agentBoxManager, spawner });
if (!gateway.db) {
  console.error("[regress] Database not available — aborting");
  await gateway.close();
  process.exit(2);
}

let exitCode = 0;
try {
  const workspaceRepo = new WorkspaceRepository(gateway.db);
  const chatRepo = new ChatRepository(gateway.db);

  let user = gateway.userStore.getByUsername(runAs);
  if (!user) {
    console.log(`[regress] User "${runAs}" not found — creating`);
    user = await gateway.userStore.createAsync({
      username: runAs,
      password: runAs === "admin" ? (process.env.SICLAW_ADMIN_PASSWORD ?? "admin") : "regress",
    });
  }
  const workspace = await workspaceRepo.getOrCreateDefault(user.id);

  console.log(`[regress] User: ${user.username} (${user.id}) | Workspace: ${workspace.id}`);

  if (allWarnings.length > 0) {
    console.warn(`[regress] Parse warnings:`, allWarnings);
  }
  if (allCases.length === 0) {
    throw new Error("No valid cases found in case-bank");
  }
  console.log(`[regress] Loaded ${allCases.length} cases from ${inputPaths.length} file(s)`);

  const handle = await agentBoxManager.getOrCreate(user.id, workspace.id, {
    workspaceId: workspace.id,
    podEnv: (workspace.envType === "test" ? "test" : "prod") as "prod" | "dev" | "test",
  });
  const client = new AgentBoxClient(handle.endpoint, 300_000, gateway.agentBoxTlsOptions);

  const credentials = await gateway
    .buildCredentialPayload(user.id, workspace.id, workspace.isDefault)
    .catch(() => undefined);

  const modelProvider = workspace.configJson?.defaultModel?.provider;
  const modelId = workspace.configJson?.defaultModel?.modelId;

  const runId = `r${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();

  console.log(`[regress] Running ${allCases.length} cases (concurrency=${concurrency})…\n`);

  const results = await runCasesBatch(allCases, {
    client,
    chatRepo,
    userId: user.id,
    workspaceId: workspace.id,
    runId,
    workOrderIndex,
    modelProvider,
    modelId,
    credentials,
    concurrency,
    onCaseStart(c) {
      console.log(`[regress] ▶ ${c.public.id} — ${c.public.title}`);
    },
    onCaseDone(c, r) {
      const scoreStr = r.scoreCommands != null
        ? ` scores=${r.scoreCommands}/${r.scoreConclusion}`
        : "";
      console.log(`[regress] ← ${c.public.id} ${r.outcome}${scoreStr} (${r.durationMs}ms)`);
      if (r.reason) console.log(`[regress]   reason: ${r.reason}`);
    },
  });

  const finishedAt = new Date().toISOString();
  const report = renderReport(results, {
    runId,
    startedAt,
    finishedAt,
    modelProvider,
    modelId,
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, report, "utf8");

  const pass = results.filter(r => r.outcome === "PASS").length;
  const fail = results.filter(r => r.outcome === "FAIL").length;
  const skip = results.filter(r => r.outcome === "SKIP").length;
  const error = results.filter(r => r.outcome === "ERROR").length;
  const missing = results.filter(r => r.outcome === "MISSING_CONTEXT").length;

  console.log(`\n[regress] 📄 Report: ${outputPath}`);
  console.log(
    `[regress] Summary: ${pass} pass / ${fail} fail / ${missing} missing-context / ${skip} skip / ${error} error / ${results.length} total`,
  );
  // MISSING_CONTEXT is a case-authoring problem — counts toward exit-code failure
  if (fail > 0 || error > 0 || missing > 0) {
    console.error(`[regress] ❌ FAILED`);
    exitCode = 1;
  } else {
    console.log(`[regress] ✅ All passing`);
  }
} catch (err) {
  console.error(`[regress] FATAL:`, err);
  exitCode = 2;
} finally {
  await gateway.close();
  process.exit(exitCode);
}
