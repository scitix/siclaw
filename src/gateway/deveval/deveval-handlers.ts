/**
 * DevEval RPC Handlers — developer self-evaluation mode
 *
 * Registers deveval.* methods for generating fault-injection cases,
 * running them through the agent, and scoring the results.
 */

import { spawn } from "node:child_process";
import type { RpcHandler, RpcContext } from "../ws-protocol.js";
import type { Database } from "../db/index.js";
import type { AgentBoxManager } from "../agentbox/manager.js";
import type { AgentBoxTlsOptions } from "../agentbox/client.js";
import { AgentBoxClient } from "../agentbox/client.js";
import { DevEvalRepository } from "../db/repositories/deveval-repo.js";
import { ChatRepository } from "../db/repositories/chat-repo.js";
import { WorkspaceRepository } from "../db/repositories/workspace-repo.js";
import { ModelConfigRepository } from "../db/repositories/model-config-repo.js";
import { consumeAgentSse } from "../sse-consumer.js";
import { buildRedactionConfig } from "../output-redactor.js";
import { generateFaultCases } from "./fault-generator.js";
import { scoreCase } from "./evaluator.js";
import { parseRegressionMarkdown } from "./regression/md-parser.js";
import { runCase, type CaseResult } from "./regression/runner.js";
import { renderReport } from "./regression/reporter.js";

function requireAuth(context: RpcContext): string {
  const userId = context.auth?.userId;
  if (!userId) throw new Error("Unauthorized: login required");
  return userId;
}

/**
 * Execute a kubectl injection command directly via child_process.spawn.
 *
 * AI generates commands like:
 *   kubectl apply -f - <<EOF
 *   apiVersion: v1
 *   kind: Pod
 *   ...
 *   EOF
 *
 * We extract the YAML and pipe it to `kubectl apply -f -` via stdin,
 * completely avoiding shell quoting issues.
 */
async function execKubectl(command: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Extract YAML from heredoc: "kubectl apply -f - <<EOF\n...\nEOF"
    const heredocMatch = command.match(
      /^(kubectl\s+.+?)\s+-f\s+-\s*<<\s*'?EOF'?\s*\n([\s\S]*?)\n\s*EOF\s*$/,
    );

    let args: string[];
    let stdinData: string | undefined;

    if (heredocMatch) {
      const kubectlPart = heredocMatch[1]; // e.g. "kubectl apply"
      const yamlContent = heredocMatch[2];
      // Split kubectl tokens, add -f - and --validate=warn for lenient parsing
      args = kubectlPart.split(/\s+/).slice(1); // remove "kubectl" itself
      args.push("-f", "-", "--validate=warn");
      stdinData = yamlContent;
    } else {
      // Simple command like "kubectl get pods"
      args = command.split(/\s+/).slice(1); // remove "kubectl"
      stdinData = undefined;
    }

    const child = spawn("kubectl", args, {
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`kubectl exited with code ${code}: ${stderr}`);
        (err as any).stderr = stderr;
        (err as any).stdout = stdout;
        reject(err);
      }
    });

    child.on("error", reject);

    // Write YAML to stdin and close
    if (stdinData) {
      child.stdin.write(stdinData);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

export function registerDevEvalMethods(
  methods: Map<string, RpcHandler>,
  db: Database | null,
  agentBoxManager: AgentBoxManager,
  agentBoxTlsOptions?: AgentBoxTlsOptions,
  buildCredentialPayload?: (userId: string, workspaceId: string, isDefault: boolean) => Promise<{ manifest: Array<{ name: string; type: string; description?: string | null; files: string[]; metadata?: Record<string, unknown> }>; files: Array<{ name: string; content: string; mode?: number }> }>,
  sendToUser?: (userId: string, event: string, payload: Record<string, unknown>) => void,
): void {
  const devEvalRepo = db ? new DevEvalRepository(db) : null;
  const chatRepo = db ? new ChatRepository(db) : null;
  const workspaceRepo = db ? new WorkspaceRepository(db) : null;
  const modelConfigRepo = db ? new ModelConfigRepository(db) : null;

  function requireDb() {
    if (!devEvalRepo || !chatRepo || !workspaceRepo)
      throw new Error("Database not available");
    return { devEvalRepo, chatRepo, workspaceRepo };
  }

  // ── deveval.generate ────────────────────────────────
  methods.set("deveval.generate", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const { devEvalRepo, workspaceRepo } = requireDb();

    const prompt = params.prompt as string;
    const workspaceId = params.workspaceId as string | undefined;
    const namespace = (params.namespace as string) || "default";
    const caseCount = Math.min(Math.max(Number(params.caseCount) || 3, 1), 20);

    if (!prompt) throw new Error("Missing required param: prompt");

    const workspace = workspaceId
      ? await workspaceRepo.getById(workspaceId)
      : await workspaceRepo.getOrCreateDefault(userId);
    if (!workspace || workspace.userId !== userId)
      throw new Error("Workspace not found");

    const modelProvider = (params.modelProvider as string | undefined) ?? workspace.configJson?.defaultModel?.provider;
    const modelId = (params.modelId as string | undefined) ?? workspace.configJson?.defaultModel?.modelId;

    const experimentId = await devEvalRepo.createExperiment(userId, workspace.id, prompt);
    await devEvalRepo.updateExperimentStatus(experimentId, "generating");

    const notify = (payload: Record<string, unknown>) => {
      if (sendToUser) sendToUser(userId, "deveval_event", payload);
      else context.sendEvent("deveval_event", payload);
    };

    notify({ type: "status", experimentId, status: "generating" });

    (async () => {
      try {
        const handle = await agentBoxManager.getOrCreate(userId, workspace.id, {
          workspaceId: workspace.id,
          podEnv: (workspace.envType === "test" ? "test" : "prod") as "prod" | "dev" | "test",
        });
        const client = new AgentBoxClient(handle.endpoint, 60000, agentBoxTlsOptions);

        const cases = await generateFaultCases(client, {
          prompt,
          namespace,
          caseCount,
          modelProvider,
          modelId,
        });

        for (let i = 0; i < cases.length; i++) {
          await devEvalRepo.createCase(experimentId, i, cases[i]);
        }
        await devEvalRepo.updateExperimentCaseCount(experimentId, cases.length);
        await devEvalRepo.updateExperimentStatus(experimentId, "draft");

        notify({ type: "generated", experimentId, caseCount: cases.length });
      } catch (err) {
        console.error("[deveval] generation failed:", err);
        await devEvalRepo.updateExperimentStatus(experimentId, "draft");
        notify({
          type: "error",
          experimentId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return { experimentId, status: "generating" };
  });

  // ── deveval.list ────────────────────────────────────
  methods.set("deveval.list", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const { devEvalRepo } = requireDb();
    const experiments = await devEvalRepo.listExperiments(userId);
    return { experiments };
  });

  // ── deveval.get ─────────────────────────────────────
  methods.set("deveval.get", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const { devEvalRepo } = requireDb();
    const experimentId = params.experimentId as string;
    if (!experimentId) throw new Error("Missing experimentId");

    const experiment = await devEvalRepo.getExperiment(experimentId);
    if (!experiment || experiment.userId !== userId) throw new Error("Experiment not found");

    const cases = await devEvalRepo.getCasesForExperiment(experimentId);
    return { experiment, cases };
  });

  // ── deveval.delete ──────────────────────────────────
  methods.set("deveval.delete", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const { devEvalRepo } = requireDb();
    const experimentId = params.experimentId as string;
    if (!experimentId) throw new Error("Missing experimentId");
    await devEvalRepo.deleteExperiment(experimentId, userId);
    return { ok: true };
  });

  // ── deveval.inject ──────────────────────────────────
  // Inject fault pods directly via kubectl (NOT through agent)
  methods.set("deveval.inject", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const { devEvalRepo } = requireDb();
    const experimentId = params.experimentId as string;
    if (!experimentId) throw new Error("Missing experimentId");

    const experiment = await devEvalRepo.getExperiment(experimentId);
    if (!experiment || experiment.userId !== userId) throw new Error("Experiment not found");

    const cases = await devEvalRepo.getCasesForExperiment(experimentId);
    if (cases.length === 0) throw new Error("No cases to inject");

    await devEvalRepo.updateExperimentStatus(experimentId, "injecting");

    const notify = (payload: Record<string, unknown>) => {
      if (sendToUser) sendToUser(userId, "deveval_event", payload);
      else context.sendEvent("deveval_event", payload);
    };

    // Execute kubectl directly — deterministic, no AI in the loop
    (async () => {
      let successCount = 0;
      for (const c of cases) {
        if (!c.kubectlInject) {
          await devEvalRepo.updateCaseStatus(c.id, "error", "No injection command");
          notify({ type: "case_error", experimentId, caseId: c.id, message: "No injection command" });
          continue;
        }

        try {
          console.log(`[deveval] injecting case ${c.id}: ${c.podName}`);
          const { stdout, stderr } = await execKubectl(c.kubectlInject);
          const output = (stdout + stderr).trim();
          console.log(`[deveval] inject result for ${c.podName}: ${output}`);

          await devEvalRepo.updateCaseStatus(c.id, "injected");
          successCount++;
          notify({ type: "case_injected", experimentId, caseId: c.id, output });
        } catch (err: any) {
          const msg = err.stderr || err.message || String(err);
          console.error(`[deveval] inject case ${c.id} failed:`, msg);
          await devEvalRepo.updateCaseStatus(c.id, "error", msg);
          notify({ type: "case_error", experimentId, caseId: c.id, message: msg });
        }
      }

      // Update experiment status
      await devEvalRepo.updateExperimentStatus(experimentId, successCount > 0 ? "draft" : "draft");
      notify({ type: "injected", experimentId, successCount, totalCount: cases.length });
    })();

    return { ok: true, status: "injecting" };
  });

  // ── deveval.run ─────────────────────────────────────
  // Send work orders to siclaw agent for diagnosis (agent cannot see answers)
  methods.set("deveval.run", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const { devEvalRepo, chatRepo, workspaceRepo } = requireDb();
    const experimentId = params.experimentId as string;
    if (!experimentId) throw new Error("Missing experimentId");

    const experiment = await devEvalRepo.getExperiment(experimentId);
    if (!experiment || experiment.userId !== userId) throw new Error("Experiment not found");

    const cases = await devEvalRepo.getCasesForExperiment(experimentId);
    // Only run cases that have been successfully injected
    const runnableCases = cases.filter(c => c.status === "injected");
    if (runnableCases.length === 0) {
      throw new Error("No injected cases to run. Please inject faults first.");
    }

    await devEvalRepo.updateExperimentStatus(experimentId, "running");

    const workspace = await workspaceRepo.getById(experiment.workspaceId);
    if (!workspace) throw new Error("Workspace not found");

    const modelProvider = (params.modelProvider as string | undefined) ?? workspace.configJson?.defaultModel?.provider;
    const modelId = (params.modelId as string | undefined) ?? workspace.configJson?.defaultModel?.modelId;

    let modelConfig: Record<string, unknown> | undefined;
    if (modelProvider && modelConfigRepo) {
      try {
        const providerConfig = await modelConfigRepo.getProviderWithModels(modelProvider);
        if (providerConfig) modelConfig = providerConfig as unknown as Record<string, unknown>;
      } catch {}
    }

    const notify = (payload: Record<string, unknown>) => {
      if (sendToUser) sendToUser(userId, "deveval_event", payload);
      else context.sendEvent("deveval_event", payload);
    };

    (async () => {
      try {
        const handle = await agentBoxManager.getOrCreate(userId, workspace.id, {
          workspaceId: workspace.id,
          podEnv: (workspace.envType === "test" ? "test" : "prod") as "prod" | "dev" | "test",
        });
        const client = new AgentBoxClient(handle.endpoint, 120000, agentBoxTlsOptions);

        for (const c of runnableCases) {
          const workOrders = c.workOrders as Array<{ difficulty: string; text: string }> | null;
          if (!workOrders || workOrders.length === 0) {
            await devEvalRepo.updateCaseStatus(c.id, "error", "No work orders");
            continue;
          }

          const selectedIdx = c.selectedWorkOrder ?? 0;
          const workOrder = workOrders[Math.min(selectedIdx, workOrders.length - 1)];

          // Always prepend pod name + namespace to the work order so agent knows
          // exactly what to investigate (user work orders may omit this)
          const contextPrefix = `[Pod: ${c.podName ?? "unknown"}, Namespace: ${c.namespace ?? "default"}]\n\n`;
          const agentPrompt = contextPrefix + workOrder.text;

          try {
            await devEvalRepo.updateCaseStatus(c.id, "running");
            notify({ type: "case_running", experimentId, caseId: c.id, podName: c.podName });

            const agentSession = await chatRepo.createSession(
              userId,
              `[DevEval] ${c.title ?? c.faultType ?? "Case"}`,
              workspace.id,
            );

            let credentials: Awaited<ReturnType<NonNullable<typeof buildCredentialPayload>>> | undefined;
            if (buildCredentialPayload) {
              credentials = await buildCredentialPayload(userId, workspace.id, workspace.isDefault).catch(() => undefined);
            }

            const result = await client.prompt({
              sessionId: agentSession.id,
              text: agentPrompt,
              modelProvider,
              modelId,
              modelConfig: modelConfig as any,
              credentials,
            });

            // Collect agent response + forward streaming events to frontend
            let assistantText = "";
            const agentCommands: string[] = [];

            await consumeAgentSse({
              client,
              sessionId: result.sessionId,
              userId,
              chatRepo,
              redactionConfig: buildRedactionConfig([], undefined),
              signal: AbortSignal.timeout(300_000),
              onEvent(evt, eventType) {
                if (eventType === "message_update") {
                  const ame = evt.assistantMessageEvent as { type?: string; delta?: string } | undefined;
                  if (ame?.type === "text_delta" && ame.delta) {
                    assistantText += ame.delta;
                  }
                } else if (eventType === "tool_execution_start" || eventType === "tool_start") {
                  const toolName = (evt.toolName as string) || (evt.name as string);
                  const args = evt.args as Record<string, unknown> | undefined;
                  if (toolName) {
                    // Extract the actual command from common arg shapes
                    const cmd = (args?.command as string)
                      ?? (args?.cmd as string)
                      ?? (args?.script as string)
                      ?? (args ? JSON.stringify(args) : "");
                    agentCommands.push(`[${toolName}] ${cmd}`);
                  }
                }
                // Forward ALL events to frontend for real-time streaming display
                notify({
                  type: "agent_stream",
                  experimentId,
                  caseId: c.id,
                  sessionId: result.sessionId,
                  eventType,
                  event: evt,
                });
              },
            });

            await devEvalRepo.updateCaseAgentResult(c.id, {
              agentSessionId: result.sessionId,
              agentResponse: assistantText,
              agentCommands,
            });

            notify({ type: "case_completed", experimentId, caseId: c.id });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[deveval] run case ${c.id} failed:`, msg);
            await devEvalRepo.updateCaseStatus(c.id, "error", msg);
            notify({ type: "case_error", experimentId, caseId: c.id, message: msg });
          }
        }

        await devEvalRepo.updateExperimentStatus(experimentId, "completed");
        notify({ type: "run_completed", experimentId });
      } catch (err) {
        console.error("[deveval] run failed:", err);
        await devEvalRepo.updateExperimentStatus(experimentId, "completed");
        notify({
          type: "error",
          experimentId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return { ok: true, status: "running" };
  });

  // ── deveval.score ───────────────────────────────────
  methods.set("deveval.score", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const { devEvalRepo, workspaceRepo } = requireDb();
    const experimentId = params.experimentId as string;
    if (!experimentId) throw new Error("Missing experimentId");

    const experiment = await devEvalRepo.getExperiment(experimentId);
    if (!experiment || experiment.userId !== userId) throw new Error("Experiment not found");

    const cases = await devEvalRepo.getCasesForExperiment(experimentId);
    const scorableCases = cases.filter(c => c.status === "completed");
    if (scorableCases.length === 0) throw new Error("No completed cases to score");

    await devEvalRepo.updateExperimentStatus(experimentId, "scoring");

    const workspace = await workspaceRepo.getById(experiment.workspaceId);
    if (!workspace) throw new Error("Workspace not found");

    const notify = (payload: Record<string, unknown>) => {
      if (sendToUser) sendToUser(userId, "deveval_event", payload);
      else context.sendEvent("deveval_event", payload);
    };

    (async () => {
      try {
        const handle = await agentBoxManager.getOrCreate(userId, workspace.id, {
          workspaceId: workspace.id,
          podEnv: (workspace.envType === "test" ? "test" : "prod") as "prod" | "dev" | "test",
        });
        const client = new AgentBoxClient(handle.endpoint, 60000, agentBoxTlsOptions);

        const modelProvider = (params.modelProvider as string | undefined) ?? workspace.configJson?.defaultModel?.provider;
        const modelId = (params.modelId as string | undefined) ?? workspace.configJson?.defaultModel?.modelId;

        for (const c of scorableCases) {
          try {
            notify({ type: "case_scoring", experimentId, caseId: c.id });

            const scores = await scoreCase(client, {
              faultType: c.faultType ?? "unknown",
              expectedAnswer: c.expectedAnswer ?? "",
              diagnosticSteps: (c.diagnosticSteps as string[] | null) ?? [],
              agentResponse: c.agentResponse ?? "",
              agentCommands: (c.agentCommands as string[] | null) ?? [],
              modelProvider,
              modelId,
              onEvent(evt, eventType) {
                // Forward scoring LLM stream to frontend (thinking + text)
                notify({
                  type: "agent_stream",
                  experimentId,
                  caseId: c.id,
                  eventType,
                  event: evt,
                });
              },
            });

            await devEvalRepo.updateCaseScore(c.id, scores);
            notify({ type: "case_scored", experimentId, caseId: c.id, ...scores });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[deveval] score case ${c.id} failed:`, msg);
            notify({ type: "case_error", experimentId, caseId: c.id, message: msg });
          }
        }

        await devEvalRepo.updateExperimentStatus(experimentId, "completed");
        notify({ type: "scoring_completed", experimentId });
      } catch (err) {
        console.error("[deveval] scoring failed:", err);
        await devEvalRepo.updateExperimentStatus(experimentId, "completed");
        notify({
          type: "error",
          experimentId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return { ok: true, status: "scoring" };
  });

  // ── deveval.runRegression ───────────────────────────
  // Parse a markdown case-bank, run each case through agent + evaluator,
  // and return a markdown report. Used by the regress CLI for pre-release
  // regression testing.
  methods.set("deveval.runRegression", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const { chatRepo, workspaceRepo } = requireDb();

    const markdown = params.markdown as string;
    const workspaceId = params.workspaceId as string | undefined;
    const workOrderIndex = Number(params.workOrderIndex ?? 0);
    if (!markdown) throw new Error("Missing required param: markdown");

    const workspace = workspaceId
      ? await workspaceRepo.getById(workspaceId)
      : await workspaceRepo.getOrCreateDefault(userId);
    if (!workspace || workspace.userId !== userId) throw new Error("Workspace not found");

    const modelProvider = (params.modelProvider as string | undefined)
      ?? workspace.configJson?.defaultModel?.provider;
    const modelId = (params.modelId as string | undefined)
      ?? workspace.configJson?.defaultModel?.modelId;

    let modelConfig: Record<string, unknown> | undefined;
    if (modelProvider && modelConfigRepo) {
      try {
        const pc = await modelConfigRepo.getProviderWithModels(modelProvider);
        if (pc) modelConfig = pc as unknown as Record<string, unknown>;
      } catch {}
    }

    const parsed = parseRegressionMarkdown(markdown);
    if (parsed.cases.length === 0) {
      throw new Error(
        `No valid cases parsed. Warnings: ${JSON.stringify(parsed.warnings)}`,
      );
    }

    const runId = `r${Date.now().toString(36)}`;
    const startedAt = new Date().toISOString();
    const notify = (payload: Record<string, unknown>) => {
      if (sendToUser) sendToUser(userId, "deveval_event", payload);
      else context.sendEvent("deveval_event", payload);
    };
    notify({
      type: "regress_started",
      runId,
      total: parsed.cases.length,
      warnings: parsed.warnings,
    });

    const handle = await agentBoxManager.getOrCreate(userId, workspace.id, {
      workspaceId: workspace.id,
      podEnv: (workspace.envType === "test" ? "test" : "prod") as "prod" | "dev" | "test",
    });
    const client = new AgentBoxClient(handle.endpoint, 300_000, agentBoxTlsOptions);

    let credentials: any;
    if (buildCredentialPayload) {
      credentials = await buildCredentialPayload(userId, workspace.id, workspace.isDefault).catch(() => undefined);
    }

    const results: CaseResult[] = [];
    for (const c of parsed.cases) {
      notify({ type: "regress_case_start", runId, caseId: c.public.id });
      const result = await runCase(c, {
        client,
        chatRepo,
        userId,
        workspaceId: workspace.id,
        runId,
        workOrderIndex,
        modelProvider,
        modelId,
        modelConfig: modelConfig as any,
        credentials,
        onProgress: (ev) => notify({ ...ev, runId }),
      });
      results.push(result);
      notify({
        type: "regress_case_done",
        runId,
        caseId: c.public.id,
        outcome: result.outcome,
        scoreCommands: result.scoreCommands,
        scoreConclusion: result.scoreConclusion,
      });
    }

    const finishedAt = new Date().toISOString();
    const report = renderReport(results, {
      runId,
      startedAt,
      finishedAt,
      modelProvider,
      modelId,
    });

    const summary = {
      pass: results.filter(r => r.outcome === "PASS").length,
      fail: results.filter(r => r.outcome === "FAIL").length,
      skip: results.filter(r => r.outcome === "SKIP").length,
      error: results.filter(r => r.outcome === "ERROR").length,
      total: results.length,
    };
    notify({ type: "regress_finished", runId, summary });

    return {
      runId,
      startedAt,
      finishedAt,
      summary,
      warnings: parsed.warnings,
      results,
      report,
    };
  });

  // ── deveval.updateWorkOrder ─────────────────────────
  methods.set("deveval.updateWorkOrder", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const { devEvalRepo } = requireDb();
    const caseId = params.caseId as string;
    const selectedIndex = params.selectedIndex as number;
    if (!caseId || selectedIndex == null) throw new Error("Missing params");

    const c = await devEvalRepo.getCase(caseId);
    if (!c) throw new Error("Case not found");

    const exp = await devEvalRepo.getExperiment(c.experimentId);
    if (!exp || exp.userId !== userId) throw new Error("Not authorized");

    await devEvalRepo.updateCaseSelectedWorkOrder(caseId, selectedIndex);
    return { ok: true };
  });
}
