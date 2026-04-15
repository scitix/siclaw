/**
 * Regression Entry — boots Gateway in-process, runs a markdown case-bank
 * through the full inject → agent → score → cleanup pipeline, writes a
 * markdown report, and exits with 0 (all pass) or 1 (any fail/error).
 *
 * Usage:
 *   npm run dev:regress                                    # uses defaults
 *   npm run dev:regress -- <case.md> <report.md>           # custom paths
 *
 * Env (optional):
 *   REGRESS_INPUT   — case-bank path (default tests/regression/cases/sample-cases.md)
 *   REGRESS_OUTPUT  — report path    (default tests/regression/reports/report-<ts>.md)
 *   REGRESS_USER    — username to run as (default "admin", auto-created)
 *   REGRESS_WORK_ORDER — 0-indexed work order to send (default 0)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadGatewayConfig } from "./gateway/config.js";
import { startGateway } from "./gateway/server.js";
import { AgentBoxManager, LocalSpawner } from "./gateway/agentbox/index.js";
import { AgentBoxClient } from "./gateway/agentbox/client.js";
import { ChatRepository } from "./gateway/db/repositories/chat-repo.js";
import { WorkspaceRepository } from "./gateway/db/repositories/workspace-repo.js";
import { parseRegressionMarkdown } from "./gateway/deveval/regression/md-parser.js";
import { runCase, type CaseResult } from "./gateway/deveval/regression/runner.js";
import { renderReport } from "./gateway/deveval/regression/reporter.js";

const inputPath = resolve(
  process.argv[2] ?? process.env.REGRESS_INPUT ?? "tests/regression/cases/sample-cases.md",
);
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outputPath = resolve(
  process.argv[3] ?? process.env.REGRESS_OUTPUT ?? `tests/regression/reports/report-${ts}.md`,
);
const runAs = process.env.REGRESS_USER ?? "admin";
const workOrderIndex = Number(process.env.REGRESS_WORK_ORDER ?? 0);

console.log(`[regress] Input:  ${inputPath}`);
console.log(`[regress] Output: ${outputPath}`);
console.log(`[regress] Booting Gateway in-process (LocalSpawner)…`);

const markdown = readFileSync(inputPath, "utf8");

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

  const parsed = parseRegressionMarkdown(markdown);
  if (parsed.warnings.length > 0) {
    console.warn(`[regress] Parse warnings:`, parsed.warnings);
  }
  if (parsed.cases.length === 0) {
    throw new Error("No valid cases found in case-bank");
  }
  console.log(`[regress] Loaded ${parsed.cases.length} cases`);

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
  const results: CaseResult[] = [];

  for (const c of parsed.cases) {
    console.log(`\n[regress] ▶ ${c.public.id} — ${c.public.title}`);
    const r = await runCase(c, {
      client,
      chatRepo,
      userId: user.id,
      workspaceId: workspace.id,
      runId,
      workOrderIndex,
      modelProvider,
      modelId,
      credentials,
      onProgress(ev) {
        if (ev.type === "case_injected") {
          console.log(`[regress]   injected: ${String(ev.output ?? "").slice(0, 120)}`);
        } else if (ev.type === "case_running") {
          console.log(`[regress]   agent investigating…`);
        }
      },
    });
    const scoreStr = r.scoreCommands != null
      ? ` scores=${r.scoreCommands}/${r.scoreConclusion}`
      : "";
    console.log(`[regress]   ← ${r.outcome}${scoreStr} (${r.durationMs}ms)`);
    if (r.reason) console.log(`[regress]     reason: ${r.reason}`);
    results.push(r);
  }

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

  console.log(`\n[regress] 📄 Report: ${outputPath}`);
  console.log(`[regress] Summary: ${pass} pass / ${fail} fail / ${skip} skip / ${error} error / ${results.length} total`);
  if (fail > 0 || error > 0) {
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
