/**
 * Cron Executor — Runs cron jobs via Gateway's internal API
 *
 * Instead of managing AgentBox pods directly, delegates to Gateway
 * which is the single owner of all AgentBox lifecycles.
 */

import crypto from "node:crypto";
import type { GatewayClient } from "./gateway-client.js";
import type { CronJobRow } from "./cron-scheduler.js";

const EXECUTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class CronExecutor {
  private gatewayUrl: string;
  private client: GatewayClient;

  constructor(gatewayUrl: string, client: GatewayClient) {
    this.gatewayUrl = gatewayUrl.replace(/\/$/, "");
    this.client = client;
  }

  async execute(job: CronJobRow): Promise<void> {
    // Re-validate job from DB before executing (handles cross-instance delete/pause)
    const current = await this.client.getCronJobById(job.id);
    if (!current || current.status !== "active") {
      console.log(`[cron-executor] Job ${job.id} no longer active, skipping`);
      return;
    }

    // Acquire execution lock (idempotency guard)
    const executionId = crypto.randomUUID();
    const locked = await this.client.lockJobForExecution(job.id, executionId);
    if (!locked) {
      console.log(`[cron-executor] Job ${job.id} already locked by another executor, skipping`);
      return;
    }

    const workspaceId = current.workspaceId ?? undefined;
    console.log(`[cron-executor] Executing job ${job.id} (${job.name}) for user ${job.userId}${workspaceId ? ` ws=${workspaceId}` : ""}`);

    try {
      const sessionId = `cron-${job.id}-${Date.now()}`;
      const prompt = buildCronPrompt(current);

      const resp = await fetch(`${this.gatewayUrl}/api/internal/agent-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: current.userId,
          sessionId,
          text: prompt,
          timeoutMs: EXECUTION_TIMEOUT_MS,
          caller: "cron",
          workspaceId,
        }),
        signal: AbortSignal.timeout(EXECUTION_TIMEOUT_MS + 10_000), // HTTP timeout slightly longer
      });

      const data = await resp.json() as {
        status: string; resultText?: string; error?: string; durationMs?: number;
      };

      if (!resp.ok || data.status !== "success") {
        throw new Error(data.error || `Gateway returned status=${data.status} http=${resp.status}`);
      }

      const resultText = data.resultText || "";

      // Record success
      await this.client.updateCronJobRun(job.id, "success");
      console.log(`[cron-executor] Job ${job.id} completed in ${data.durationMs}ms, resultText length=${resultText.length}`);
      if (resultText) {
        console.log(`[cron-executor] Result preview: ${resultText.slice(0, 200)}`);
      }

      // Notify gateway (fire-and-forget)
      this.notifyGateway(job, "success", resultText, undefined, data.durationMs);
    } catch (err) {
      console.error(`[cron-executor] Job ${job.id} failed:`, err);
      await this.client.updateCronJobRun(job.id, "failure");
      this.notifyGateway(job, "failure", "", err instanceof Error ? err.message : String(err));
    } finally {
      // Release execution lock (best-effort)
      try {
        await this.client.unlockJob(job.id, executionId);
      } catch (err) {
        console.warn(`[cron-executor] Failed to unlock job ${job.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  private notifyGateway(
    job: CronJobRow,
    result: "success" | "failure",
    resultText: string,
    error?: string,
    durationMs?: number,
  ): void {
    fetch(`${this.gatewayUrl}/api/internal/cron-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: job.userId,
        jobId: job.id,
        jobName: job.name,
        result,
        resultText,
        error,
        durationMs,
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch((err) =>
      console.warn("[cron-executor] notify failed:", err instanceof Error ? err.message : err),
    );
  }
}

function buildCronPrompt(job: CronJobRow): string {
  const parts = [
    `[System: You are executing an automated scheduled task in NON-INTERACTIVE mode.

Rules:
- Perform the task described below directly and report the result.
- Do NOT ask the user any questions or request confirmations — there is no user to respond.
- If multiple environments, hosts, or credentials are available, operate on ALL of them unless the task description specifies a particular target.
- Do NOT create, modify, delete, pause, or manage any schedules.
- Keep the output concise and structured.
- Respond in the same language as the task name and description below.]`,
    `Task: ${job.name}`,
  ];
  if (job.description) {
    parts.push(`Instructions: ${job.description}`);
  }
  if (job.skillId) {
    parts.push(`Execute skill: ${job.skillId}`);
  }
  return parts.join("\n\n");
}
