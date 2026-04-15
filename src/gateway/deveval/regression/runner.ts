/**
 * Regression Runner — orchestrates one case end-to-end.
 *
 * Pipeline:
 *   1. (reproducible only) kubectl apply the injected YAML
 *   2. Create a fresh agent session, send ONLY the work order prompt
 *      (agent must NOT see the expected answer or reference solution)
 *   3. Collect agent's streamed response + tool commands
 *   4. Score via evaluator.scoreCase() against the private answer
 *   5. (reproducible only) kubectl delete to clean up
 *
 * Stubbed cases (reproducible=false) are currently not executed — they
 * require a kubectl shim inside AgentBox which is future work. The runner
 * returns a "skipped" result for them.
 */

import { spawn } from "node:child_process";
import type { AgentBoxClient } from "../../agentbox/client.js";
import type { ChatRepository } from "../../db/repositories/chat-repo.js";
import { consumeAgentSse } from "../../sse-consumer.js";
import { scoreCase } from "../evaluator.js";
import type { ParsedCase } from "./md-parser.js";

export interface RunOptions {
  client: AgentBoxClient;
  chatRepo: ChatRepository;
  userId: string;
  workspaceId: string;
  runId: string;
  /** 0-indexed — which work order difficulty to send (default 0 = green) */
  workOrderIndex?: number;
  modelProvider?: string;
  modelId?: string;
  credentials?: any;
  modelConfig?: any;
  /** Optional callback for streaming progress to frontend */
  onProgress?: (ev: Record<string, unknown>) => void;
  agentTimeoutMs?: number;
}

export type CaseOutcome = "PASS" | "FAIL" | "SKIP" | "ERROR" | "MISSING_CONTEXT";

export interface CaseResult {
  id: string;
  title: string;
  reproducible: boolean;
  outcome: CaseOutcome;
  reason?: string;
  workOrderText?: string;
  workOrderDifficulty?: string;
  scoreCommands?: number;
  scoreConclusion?: number;
  scoreReasoning?: string;
  passThreshold: { commands: number; conclusion: number };
  agentResponse?: string;
  agentCommands?: string[];
  expectedAnswer?: string;
  solutionCommands?: string[];
  /** True if case-author supplied a custom scoring rubric (overrode default) */
  usedCustomRubric?: boolean;
  injectOutput?: string;
  /** Literal YAML manifest applied to the cluster (after placeholder substitution) */
  injectYamlApplied?: string;
  /** Full kubectl apply command that was run (for report reproducibility) */
  injectCommand?: string;
  /** Generated pod name — deveval-regress-<shortName>-<runId>-<date>-<time> */
  podName?: string;
  namespace?: string;
  cleanupOutput?: string;
  durationMs: number;
}

/**
 * Substitute placeholders. Supported:
 *   {runId}     — unique per regression run
 *   {podName}   — generated pod name following the project naming convention
 */
function subst(s: string, vars: { runId: string; podName: string }): string {
  return s
    .replace(/\{runId\}/g, vars.runId)
    .replace(/\{podName\}/g, vars.podName);
}

/**
 * Generate pod name following the required convention:
 *   deveval-regress-<shortName>-<runId>-<yyyymmdd>-<hhmmss>
 *
 * Constrained to K8s DNS-1123 subdomain rules (≤63 chars, lowercase, alnum+'-').
 */
function generatePodName(shortName: string, runId: string, now = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let name = `deveval-regress-${shortName}-${runId}-${date}-${time}`;
  if (name.length > 63) name = name.slice(0, 63).replace(/-$/, "");
  return name;
}

export async function runCase(c: ParsedCase, opts: RunOptions): Promise<CaseResult> {
  const start = Date.now();
  const threshold = c.private.passThreshold;
  const base = {
    id: c.public.id,
    title: c.public.title,
    reproducible: c.public.reproducible,
    passThreshold: threshold,
    expectedAnswer: c.private.expectedAnswer,
    solutionCommands: c.private.solutionCommands,
    usedCustomRubric: !!c.private.customRubric,
  };

  // Non-reproducible cases ALWAYS go through knowledge-QA. If the case author
  // didn't provide '### 集群现状', we cannot evaluate the agent — surface this
  // as MISSING_CONTEXT so it shows up as a real problem in the report (not a
  // silent SKIP). Fixture-replay support is no longer wired (was never
  // implemented); legacy '### Fixtures' sections are tolerated by the parser
  // but ignored here.
  if (!c.public.reproducible) {
    if (c.public.clusterContext) {
      return runKnowledgeQaCase(c, opts, start, base);
    }
    return {
      ...base,
      outcome: "MISSING_CONTEXT",
      reason:
        `Knowledge-QA case has no '### 集群现状' section — cannot evaluate. ` +
        `Add a "### 集群现状" section with the relevant kubectl outputs / events / conditions ` +
        `the agent should reason from.`,
      durationMs: Date.now() - start,
    };
  }

  // Generate pod name BEFORE any substitution so every reference uses the same name
  const podName = generatePodName(c.public.podShortName, opts.runId);
  const vars = { runId: opts.runId, podName };
  const namespace = subst(c.public.namespace, vars);

  // Pick a work order
  const idx = Math.min(opts.workOrderIndex ?? 0, c.public.workOrders.length - 1);
  const wo = c.public.workOrders[idx];
  const workOrderText = subst(wo.text, vars);

  // 1) Inject — ensure namespace exists first, then apply the manifest
  let injectOutput = "";
  let injectYamlApplied = "";
  let injectCommand = "";
  try {
    const nsOutput = await kubectlEnsureNamespace(namespace);
    injectYamlApplied = subst(c.private.injectYaml ?? "", vars);
    injectCommand = `kubectl apply -f - --validate=warn <<'EOF'\n${injectYamlApplied}\nEOF`;
    const applyOutput = await kubectlApply(injectYamlApplied);
    injectOutput = [nsOutput, applyOutput].filter(Boolean).join("\n");
    opts.onProgress?.({
      type: "case_injected",
      caseId: c.public.id,
      podName,
      namespace,
      output: injectOutput,
    });
  } catch (err: any) {
    return {
      ...base,
      outcome: "ERROR",
      reason: `kubectl apply failed: ${err.stderr ?? err.message ?? err}`,
      workOrderText,
      workOrderDifficulty: wo.difficulty,
      injectOutput,
      injectYamlApplied,
      injectCommand,
      podName,
      namespace,
      durationMs: Date.now() - start,
    };
  }

  // 2) + 3) Run agent
  //
  // ISOLATION CONTRACT (critical): the agent sees ONLY the fields built into
  // `agentPrompt` below. It must NOT see injectYaml, expectedAnswer,
  // solutionCommands, faultType, or any reference to the inject step.
  let agentResponse = "";
  const agentCommands: string[] = [];
  try {
    const session = await opts.chatRepo.createSession(
      opts.userId,
      `[Regress] ${c.public.title}`,
      opts.workspaceId,
    );

    const agentPrompt =
      `[Namespace: ${namespace}]\n\n${workOrderText}\n\n请排查根因并给出修复建议。`;

    opts.onProgress?.({ type: "case_running", caseId: c.public.id, prompt: agentPrompt });

    const result = await opts.client.prompt({
      sessionId: session.id,
      text: agentPrompt,
      modelProvider: opts.modelProvider,
      modelId: opts.modelId,
      modelConfig: opts.modelConfig,
      credentials: opts.credentials,
    });

    await consumeAgentSse({
      client: opts.client,
      sessionId: result.sessionId,
      userId: opts.userId,
      chatRepo: opts.chatRepo,
      signal: AbortSignal.timeout(opts.agentTimeoutMs ?? 300_000),
      onEvent(evt, eventType) {
        if (eventType === "message_update") {
          const ame = evt.assistantMessageEvent as { type?: string; delta?: string } | undefined;
          if (ame?.type === "text_delta" && ame.delta) agentResponse += ame.delta;
        } else if (eventType === "tool_execution_start" || eventType === "tool_start") {
          const toolName = (evt.toolName as string) || (evt.name as string);
          const args = evt.args as Record<string, unknown> | undefined;
          if (toolName) {
            const cmd = (args?.command as string)
              ?? (args?.cmd as string)
              ?? (args?.script as string)
              ?? (args ? JSON.stringify(args) : "");
            agentCommands.push(`[${toolName}] ${cmd}`);
          }
        }
        opts.onProgress?.({ type: "agent_stream", caseId: c.public.id, eventType, event: evt });
      },
    });
  } catch (err: any) {
    await kubectlDeleteSafe(injectYamlApplied);
    return {
      ...base,
      outcome: "ERROR",
      reason: `Agent session failed: ${err.message ?? err}`,
      workOrderText,
      workOrderDifficulty: wo.difficulty,
      injectOutput,
      injectYamlApplied,
      injectCommand,
      podName,
      namespace,
      agentResponse,
      agentCommands,
      durationMs: Date.now() - start,
    };
  }

  // 4) Score
  let scoreCommands = 0, scoreConclusion = 0, scoreReasoning = "";
  try {
    const scores = await scoreCase(opts.client, {
      faultType: c.public.faultType,
      expectedAnswer: c.private.expectedAnswer,
      diagnosticSteps: c.private.solutionCommands.map(s => subst(s, vars)),
      agentResponse,
      agentCommands,
      customRubric: c.private.customRubric,
      modelProvider: opts.modelProvider,
      modelId: opts.modelId,
      onEvent(evt, eventType) {
        opts.onProgress?.({ type: "score_stream", caseId: c.public.id, eventType, event: evt });
      },
    });
    scoreCommands = scores.scoreCommands;
    scoreConclusion = scores.scoreConclusion;
    scoreReasoning = scores.scoreReasoning;
  } catch (err: any) {
    const cleanupOutput = await kubectlDeleteSafe(injectYamlApplied);
    return {
      ...base,
      outcome: "ERROR",
      reason: `Scoring failed: ${err.message ?? err}`,
      workOrderText,
      workOrderDifficulty: wo.difficulty,
      injectOutput,
      injectYamlApplied,
      injectCommand,
      podName,
      namespace,
      agentResponse,
      agentCommands,
      cleanupOutput,
      durationMs: Date.now() - start,
    };
  }

  // 5) Cleanup
  const cleanupOutput = await kubectlDeleteSafe(injectYamlApplied);

  const outcome: CaseOutcome =
    scoreCommands >= threshold.commands && scoreConclusion >= threshold.conclusion
      ? "PASS"
      : "FAIL";

  return {
    ...base,
    outcome,
    workOrderText,
    workOrderDifficulty: wo.difficulty,
    scoreCommands,
    scoreConclusion,
    scoreReasoning,
    injectOutput,
    injectYamlApplied,
    injectCommand,
    podName,
    namespace,
    agentResponse,
    agentCommands,
    cleanupOutput,
    durationMs: Date.now() - start,
  };
}

/** Idempotently create a namespace via server-side apply. */
function kubectlEnsureNamespace(ns: string): Promise<string> {
  if (!ns || ns === "default") return Promise.resolve("");
  const manifest =
    `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n  labels:\n    deveval/managed: "true"\n`;
  return kubectlApply(manifest);
}

/**
 * Run a batch of cases with bounded concurrency. Cases are independent
 * (separate sessions, unique pod names, unique chat rooms), so parallelism is
 * safe. Returns results in the SAME order as the input array.
 *
 * Concurrency defaults to 4 — high enough for ~4x speedup on case-heavy runs,
 * low enough to stay under typical LLM API rate limits and keep kubectl /
 * AgentBox load manageable.
 */
export async function runCasesBatch(
  cases: ParsedCase[],
  opts: Omit<RunOptions, "onProgress"> & {
    concurrency?: number;
    onCaseStart?: (c: ParsedCase, idx: number) => void;
    onCaseDone?: (c: ParsedCase, r: CaseResult, idx: number) => void;
    onCaseProgress?: (c: ParsedCase, ev: Record<string, unknown>) => void;
  },
): Promise<CaseResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const results: CaseResult[] = new Array(cases.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= cases.length) return;
      const c = cases[i];
      opts.onCaseStart?.(c, i);
      const r = await runCase(c, {
        ...opts,
        onProgress: (ev) => opts.onCaseProgress?.(c, ev),
      });
      results[i] = r;
      opts.onCaseDone?.(c, r, i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));
  return results;
}

/**
 * Knowledge-QA evaluation: agent receives the work order PLUS pre-recorded
 * cluster context (kubectl outputs, events, conditions) and is asked to
 * diagnose without touching a real cluster. Same scoring path as reproducible
 * cases — evaluator compares agent's commands+conclusion against the gold
 * answer in PrivateCase.
 *
 * Isolation contract: agent still NEVER sees expectedAnswer or solutionCommands;
 * those go only to the scoring session.
 */
async function runKnowledgeQaCase(
  c: ParsedCase,
  opts: RunOptions,
  start: number,
  base: Pick<CaseResult, "id" | "title" | "reproducible" | "passThreshold" | "expectedAnswer" | "solutionCommands" | "usedCustomRubric">,
): Promise<CaseResult> {
  const idx = Math.min(opts.workOrderIndex ?? 0, c.public.workOrders.length - 1);
  const wo = c.public.workOrders[idx];
  const vars = { runId: opts.runId, podName: "" };
  const workOrderText = subst(wo.text, vars);
  const namespace = subst(c.public.namespace, vars);
  const clusterContext = c.public.clusterContext!;

  let agentResponse = "";
  const agentCommands: string[] = [];
  try {
    const session = await opts.chatRepo.createSession(
      opts.userId,
      `[Regress-QA] ${c.public.title}`,
      opts.workspaceId,
    );

    // Knowledge-QA prompt: tell agent to reason from given context, NOT to
    // probe a real cluster. The "[KNOWLEDGE-QA]" tag is honest disclosure —
    // execution-mode realism is sacrificed for ability-to-evaluate scenarios
    // we cannot inject.
    const agentPrompt =
      `[KNOWLEDGE-QA MODE — Namespace: ${namespace}]\n\n` +
      `## 工单\n${workOrderText}\n\n` +
      `## 已收集到的集群现状(Runner 提供,无需也无法访问真实集群)\n\n${clusterContext}\n\n` +
      `请基于以上信息,给出:\n` +
      `1. 你会用哪些 kubectl 命令进一步确认/补充信息(列出命令即可,无需执行);\n` +
      `2. 故障的根因分析;\n` +
      `3. 修复建议。`;

    opts.onProgress?.({ type: "case_running", caseId: c.public.id, prompt: agentPrompt });

    const result = await opts.client.prompt({
      sessionId: session.id,
      text: agentPrompt,
      modelProvider: opts.modelProvider,
      modelId: opts.modelId,
      modelConfig: opts.modelConfig,
      credentials: opts.credentials,
    });

    await consumeAgentSse({
      client: opts.client,
      sessionId: result.sessionId,
      userId: opts.userId,
      chatRepo: opts.chatRepo,
      signal: AbortSignal.timeout(opts.agentTimeoutMs ?? 300_000),
      onEvent(evt, eventType) {
        if (eventType === "message_update") {
          const ame = evt.assistantMessageEvent as { type?: string; delta?: string } | undefined;
          if (ame?.type === "text_delta" && ame.delta) agentResponse += ame.delta;
        } else if (eventType === "tool_execution_start" || eventType === "tool_start") {
          const toolName = (evt.toolName as string) || (evt.name as string);
          const args = evt.args as Record<string, unknown> | undefined;
          if (toolName) {
            const cmd = (args?.command as string) ?? (args?.cmd as string) ?? (args?.script as string) ?? (args ? JSON.stringify(args) : "");
            agentCommands.push(`[${toolName}] ${cmd}`);
          }
        }
        opts.onProgress?.({ type: "agent_stream", caseId: c.public.id, eventType, event: evt });
      },
    });
  } catch (err: any) {
    return {
      ...base,
      outcome: "ERROR",
      reason: `Agent session failed (knowledge-QA): ${err.message ?? err}`,
      workOrderText,
      workOrderDifficulty: wo.difficulty,
      namespace,
      agentResponse,
      agentCommands,
      durationMs: Date.now() - start,
    };
  }

  let scoreCommands = 0, scoreConclusion = 0, scoreReasoning = "";
  try {
    const scores = await scoreCase(opts.client, {
      faultType: c.public.faultType,
      expectedAnswer: c.private.expectedAnswer,
      diagnosticSteps: c.private.solutionCommands.map(s => subst(s, vars)),
      // In KQA mode, agentCommands may be empty (agent didn't execute anything).
      // Pass agentResponse to scorer so it can extract proposed commands from
      // the response text — the existing scoring rubric already evaluates
      // "commands the agent proposed" not just "commands actually executed".
      agentResponse,
      agentCommands,
      customRubric: c.private.customRubric,
      modelProvider: opts.modelProvider,
      modelId: opts.modelId,
      onEvent(evt, eventType) {
        opts.onProgress?.({ type: "score_stream", caseId: c.public.id, eventType, event: evt });
      },
    });
    scoreCommands = scores.scoreCommands;
    scoreConclusion = scores.scoreConclusion;
    scoreReasoning = scores.scoreReasoning;
  } catch (err: any) {
    return {
      ...base,
      outcome: "ERROR",
      reason: `Scoring failed (knowledge-QA): ${err.message ?? err}`,
      workOrderText,
      workOrderDifficulty: wo.difficulty,
      namespace,
      agentResponse,
      agentCommands,
      durationMs: Date.now() - start,
    };
  }

  const threshold = c.private.passThreshold;
  const outcome: CaseOutcome =
    scoreCommands >= threshold.commands && scoreConclusion >= threshold.conclusion
      ? "PASS"
      : "FAIL";

  return {
    ...base,
    outcome,
    workOrderText,
    workOrderDifficulty: wo.difficulty,
    namespace,
    scoreCommands,
    scoreConclusion,
    scoreReasoning,
    agentResponse,
    agentCommands,
    durationMs: Date.now() - start,
  };
}

/** Apply a YAML manifest via `kubectl apply -f -`, returning combined stdout+stderr. */
function kubectlApply(yaml: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("kubectl", ["apply", "-f", "-", "--validate=warn"], {
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d.toString()));
    child.stderr.on("data", d => (stderr += d.toString()));
    child.on("close", code => {
      if (code === 0) resolve((stdout + stderr).trim());
      else {
        const err: any = new Error(`kubectl apply exited ${code}`);
        err.stderr = stderr;
        err.stdout = stdout;
        reject(err);
      }
    });
    child.on("error", reject);
    child.stdin.write(yaml);
    child.stdin.end();
  });
}

/** Best-effort cleanup — never throws. */
async function kubectlDeleteSafe(yaml: string): Promise<string> {
  if (!yaml.trim()) return "";
  return new Promise(resolve => {
    const child = spawn(
      "kubectl",
      ["delete", "-f", "-", "--ignore-not-found=true", "--wait=false"],
      { timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", d => (out += d.toString()));
    child.stderr.on("data", d => (out += d.toString()));
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(out.trim()));
    child.stdin.write(yaml);
    child.stdin.end();
  });
}
